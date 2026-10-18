#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * 真机验证：用无界面 Firefox 加载查看器页面，让真的 GeoGebra 内核连上桥，
 * 再用 MCP 工具驱动它——画图、读对象、改样式、导出 PNG/SVG/PDF、存取构造。
 *
 * 与 test/list-tools.mjs 的分工：那个不需要浏览器、验证桥自己的协议与参数映射；
 * 这个验证真正的 ggbApplet API 在浏览器里确实按预期工作。需要本机有 firefox。
 *
 * 用法：
 *   node test/e2e-browser.mjs            # 结果写到 ./verify/
 *   GGB_E2E_PORT=3462 node test/e2e-browser.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const verifyDir = join(packageDir, 'verify');
const binPath = join(packageDir, 'bin', 'geogebra-mcp-bridge.mjs');

const PORT = Number(process.env.GGB_E2E_PORT ?? 3460);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PROFILE_DIR = `/tmp/ggb-e2e-profile-${PORT}`;

let failed = 0;
const fail = (message) => {
	console.error(message);
	failed += 1;
};
const check = (name, condition, detail) => {
	if (condition) console.log(`  ✓ ${name}`);
	else fail(`  ✗ ${name}${detail === undefined ? '' : `：${detail}`}`);
};

const waitFor = async (label, probe, timeoutMs = 30000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = await probe();
			if (value) return value;
		} catch {
			// 还没就绪
		}
		if (Date.now() > deadline) throw new Error(`等待「${label}」超过 ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
};

const bridgeStatus = async () => (await fetch(`${BASE_URL}/api/status`)).json();

const fileSize = (path) => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

mkdirSync(verifyDir, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [binPath, '--port', String(PORT)],
	stderr: 'pipe',
});
const client = new Client({ name: 'geogebra-bridge-e2e', version: '0.1.0' });

const call = async (name, args) => {
	const result = await client.callTool({ name, arguments: args ?? {} });
	const text = (result.content ?? [])
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');
	return { result, text, isError: result.isError === true };
};

/** 当前画布 id：canvas_create 返回，之后所有页面级工具都要带它。 */
let CANVAS_ID = '';
const page = (name, args) => call(name, { id: CANVAS_ID, ...(args ?? {}) });

let firefox = null;

try {
	await client.connect(transport);
	await waitFor('桥的 HTTP 服务', async () => (await bridgeStatus()).ok);
	console.log(`桥已启动：${BASE_URL}`);

	// 先建画布拿 id 与地址（这套环境没有 DISPLAY，canvas_create 会把地址给出来），
	// 再用无界面 Firefox 打开它——这就是 DSH 里那套流程。
	const created = await call('canvas_create', { app: 'classic' });
	CANVAS_ID = /画布 (c\d+) 已建好/.exec(created.text)?.[1] ?? '';
	check('canvas_create 返回画布 id 与地址', Boolean(CANVAS_ID) && created.text.includes(`?canvas=${CANVAS_ID}`), created.text.slice(0, 240));
	const viewerUrl = /地址：(\S+)/.exec(created.text)?.[1] ?? `${BASE_URL}/?canvas=${CANVAS_ID}`;

	firefox = spawn('firefox', ['--headless', '--new-instance', '--profile', PROFILE_DIR, viewerUrl], {
		detached: true,
		stdio: 'ignore',
	});
	firefox.once('error', (error) => fail(`启动 firefox 失败：${error.message}`));
	console.log(`已启动无界面 firefox 打开画布 ${CANVAS_ID}，等 GeoGebra 连上来…`);

	const connected = await waitFor(
		'GeoGebra 页面连上这个画布',
		async () => {
			const status = await bridgeStatus();
			return (status.canvases ?? []).find((item) => item.id === CANVAS_ID && item.info?.version) ?? null;
		},
		120000,
	);
	console.log(`GeoGebra ${connected.info.version} / ${connected.info.appName} 已连到 ${connected.id}（视口 ${connected.info.width}×${connected.info.height}）\n`);

	/* --- status --- */

	const status = await call('status', {});
	check('status 报出真 GeoGebra 版本', status.text.includes(connected.info.version), status.text.split('\n')[0]);
	check('status 报出离线资源可用', status.text.includes('可用'), status.text.split('\n')[1]);
	check('status 列出画布 id 与连接状态', status.text.includes(CANVAS_ID) && status.text.includes('已连接'), status.text.slice(0, 300));

	/* --- 造构造 --- */

	const build = await page('eval', {
		command: ['A=(1,2)', 'B=(5,3)', 's=Segment(A,B)', 'f(x)=x^2', 'c=Circle(A,2)', 'g=Derivative(f)'].join('\n'),
	});
	check('eval 一次画完 6 个对象', !build.isError && build.text.includes('新建 6 个对象'), build.text.replace(/\n/g, ' '));
	check('eval 报出对象名 A', build.text.includes('A（point）'), build.text.replace(/\n/g, ' '));

	const objects = await page('objects', {});
	check('objects 列出 6 个对象', objects.text.includes('共 6 个对象'), objects.text.split('\n')[0]);
	check('objects 里能看到函数 f', /(^|\s)f(\s|$)/m.test(objects.text) && objects.text.includes('function'), objects.text.slice(0, 300));

	const detail = await page('object', { name: 'f' });
	check('object f 给出定义与值', !detail.isError && detail.text.includes('f(x)'), detail.text.split('\n').slice(0, 3).join(' | '));

	const derivative = await page('object', { name: 'g' });
	check('导数对象 g 存在', !derivative.isError, derivative.text.split('\n')[0]);

	// 自动命名：GeoGebra 会自己挑下一个空闲字母；返回里必须能读到真实名字。
	const auto = await page('eval', { command: 'Segment(B,A)' });
	const autoName = /·\s*(\w+)（segment）/.exec(auto.text)?.[1];
	check('自动命名对象的真实名字可从返回里读到', Boolean(autoName), auto.text.replace(/\n/g, ' '));
	if (autoName) {
		const removed = await page('edit', { action: 'delete', object: autoName });
		check('按自动名字删除成功', removed.text.includes(`已删除 ${autoName}`), removed.text);
	}

	/* --- 语法错误路径 --- */

	const bad = await page('eval', { command: 'Segment(A,)' });
	check('语法错误被识别为「没有变化」', bad.text.includes('没有产生任何变化'), bad.text.replace(/\n/g, ' ').slice(0, 160));

	/* --- CAS --- */

	const cas = await page('eval', { command: 'Integral(x^2)', engine: 'cas' });
	check(
		'CAS 求积分给出结果',
		!cas.isError && /1\s*\/\s*3/.test(cas.text) && /x/.test(cas.text),
		cas.text.replace(/\n/g, ' ').slice(0, 160),
	);
	const casSolve = await page('eval', { command: 'Solve(x^2-4=0, x)', engine: 'cas' });
	check('CAS 解方程给出结果', /x\s*=\s*-2/.test(casSolve.text) && /x\s*=\s*2/.test(casSolve.text), casSolve.text.replace(/\n/g, ' ').slice(0, 160));

	/* --- 事件 --- */

	const events = await page('events', {});
	check('events 记录了构造变化', events.text.includes('add') || events.text.includes('共'), events.text.replace(/\n/g, ' ').slice(0, 200));

	/* --- 视图 --- */

	const view = await page('view', {});
	check('view 给出可见坐标范围', /x ∈ \[/.test(view.text), view.text.replace(/\n/g, ' ').slice(0, 200));
	check('view 给出网格状态', /网格：[开关]/.test(view.text), view.text.replace(/\n/g, ' ').slice(0, 200));

	// 浏览器到底有没有 WebGL：这决定 3D 视图/3D 计算器能不能用。
	const webglLine = view.text.split('\n').find((line) => line.startsWith('浏览器 WebGL'));
	console.log(`  浏览器 WebGL 状态：${webglLine ?? '(未读到)'}`);
	check('view 报出浏览器 WebGL 状态', Boolean(webglLine), view.text.slice(-320));
	check('view 报出构造里有没有 3D 视图', view.text.includes('构造里有 3D 视图：'), view.text.slice(-320));

	const viewSet = await page('view', { xmin: -8, xmax: 8, ymin: -5, ymax: 5, grid: true });
	check('view 设范围与网格成功', viewSet.text.startsWith('已调整：') && viewSet.text.includes('范围'), viewSet.text.split('\n')[0]);
	const viewBack = await page('view', {});
	check('view 回读到新范围', /x ∈ \[-8, 8\]/.test(viewBack.text), viewBack.text.replace(/\n/g, ' ').slice(0, 200));

	/* --- 样式 --- */

	const styled = await page('set', { object: 'f', property: 'color', red: 200, green: 30, blue: 30 });
	check('set color 成功', !styled.isError && styled.text.includes('setColor'), styled.text);
	const styledThickness = await page('set', { object: 'f', property: 'lineThickness', level: 5 });
	check('set lineThickness 成功', !styledThickness.isError, styledThickness.text);
	const hidden = await page('set', { object: 'c', property: 'visible', flag: false });
	check('set visible 成功', !hidden.isError, hidden.text);
	await page('set', { object: 'c', property: 'visible', flag: true });

	/* --- 截图与导出 --- */

	const shot = await page('screenshot', { scale: 1 });
	const shotImage = (shot.result.content ?? []).find((item) => item.type === 'image');
	check('screenshot（默认 view=applet）返回图片内容', Boolean(shotImage) && shotImage.data.length > 1000, `base64 长度 ${shotImage?.data?.length ?? 0}`);
	if (shotImage) {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(verifyDir, 'ggb-screenshot.png'), Buffer.from(shotImage.data, 'base64'));
	}

	// 两条截图路径都要真在走：整窗（含代数面板）应当比纯图形区宽。
	const shotGraphics = await page('screenshot', { view: 'graphics', scale: 1 });
	const graphicsImage = (shotGraphics.result.content ?? []).find((item) => item.type === 'image');
	check('screenshot view=graphics 返回图片内容', Boolean(graphicsImage) && graphicsImage.data.length > 1000, `base64 长度 ${graphicsImage?.data?.length ?? 0}`);
	const pngSize = (base64) => {
		const buffer = Buffer.from(base64, 'base64');
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	};
	if (shotImage && graphicsImage) {
		const whole = pngSize(shotImage.data);
		const plot = pngSize(graphicsImage.data);
		check(
			'整窗与图形区是两张不同尺寸的图',
			whole.width > plot.width,
			`applet ${whole.width}×${whole.height} vs graphics ${plot.width}×${plot.height}`,
		);
	}

	const appletPath = join(verifyDir, 'ggb-applet.png');
	const appletExport = await page('export', { format: 'png', path: appletPath, view: 'applet' });
	check('export png view=applet 写出文件', fileSize(appletPath) > 5000, `${fileSize(appletPath)} 字节（${appletExport.text}）`);

	const pngPath = join(verifyDir, 'ggb-export.png');
	const png = await page('export', { format: 'png', path: pngPath, scale: 2, transparent: false });
	check('export png 写出文件', fileSize(pngPath) > 5000, `${fileSize(pngPath)} 字节（${png.text}）`);

	const svgPath = join(verifyDir, 'ggb-export.svg');
	const svg = await page('export', { format: 'svg', path: svgPath });
	check('export svg 写出文件', fileSize(svgPath) > 500, `${fileSize(svgPath)} 字节（${svg.text}）`);

	const pdfPath = join(verifyDir, 'ggb-export.pdf');
	const pdf = await page('export', { format: 'pdf', path: pdfPath });
	check('export pdf 写出文件', fileSize(pdfPath) > 5000, `${fileSize(pdfPath)} 字节（${pdf.text}）`);

	/* --- 构造存取 --- */

	// 先记下保存时的对象数与名字，恢复后要一模一样。
	const beforeSave = await page('objects', {});
	const beforeCount = /共 (\d+) 个对象/.exec(beforeSave.text)?.[1];
	const beforeNames = beforeSave.text
		.split('\n')
		.slice(3)
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean)
		.sort()
		.join(',');

	const ggbPath = join(verifyDir, 'ggb-state.ggb');
	const saved = await page('state', { action: 'save', path: ggbPath });
	check('state save 写出 .ggb', fileSize(ggbPath) > 500, `${fileSize(ggbPath)} 字节（${saved.text}）`);

	const xml = await page('state', { action: 'get', format: 'xml' });
	check('state get 返回构造 XML', xml.text.includes('<construction'), xml.text.slice(0, 120).replace(/\n/g, ' '));

	// 清空后从文件恢复，核对对象数与名字回到保存时的状态。
	const cleared = await page('edit', { action: 'clear' });
	check('edit clear 清空构造', cleared.text.includes('已清空'), cleared.text);
	const empty = await page('objects', {});
	check('清空后 objects 为空', empty.text.includes('构造是空的'), empty.text);

	const loaded = await page('state', { action: 'load', path: ggbPath });
	check('state load 恢复构造', !loaded.isError, loaded.text);
	const restored = await page('objects', {});
	const restoredNames = restored.text
		.split('\n')
		.slice(3)
		.map((line) => line.trim().split(/\s+/)[0])
		.filter(Boolean)
		.sort()
		.join(',');
	check(
		'恢复后对象数与名字与保存时一致',
		beforeCount !== undefined && restored.text.includes(`共 ${beforeCount} 个对象`) && restoredNames === beforeNames,
		`保存时 ${beforeCount} 个 [${beforeNames}] → 恢复后 ${restored.text.split('\n')[0]} [${restoredNames}]`,
	);

	/* --- 撤销 / 重做 --- */

	const undo = await page('edit', { action: 'undo' });
	check('edit undo 成功', undo.text.includes('已撤销'), undo.text);
	const redo = await page('edit', { action: 'redo' });
	check('edit redo 成功', redo.text.includes('已重做'), redo.text);

	/* --- help --- */

	const help = await call('help', { topic: 'bridge' });
	check('help bridge 有内容', help.text.includes('工具分工'), help.text.slice(0, 60));

	/* --- 释放画布 --- */

	const released = await call('canvas_release', { id: CANVAS_ID });
	check('canvas_release 让页面自我拆除', released.text.includes('applet 已拆除'), released.text.slice(0, 200));
	await waitFor('画布从列表里消失', async () => {
		const bridge = await bridgeStatus();
		return (bridge.canvases ?? []).length === 0;
	});
	const afterRelease = await page('objects', {});
	check('释放后该 id 不可再用', afterRelease.isError && afterRelease.text.includes('没有这个画布'), afterRelease.text.slice(0, 200));
} catch (error) {
	fail(`端到端验证中断：${error?.stack ?? error}`);
} finally {
	if (firefox?.pid) {
		try {
			process.kill(-firefox.pid, 'SIGTERM');
		} catch {
			// 已经退出了
		}
		try {
			firefox.kill('SIGTERM');
		} catch {
			// 同上
		}
	}
	spawn('pkill', ['-f', PROFILE_DIR], { stdio: 'ignore' }).on('error', () => {});
	await client.close().catch(() => {});
	rmSync(PROFILE_DIR, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n真机验证通过。' : `\n真机验证失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
