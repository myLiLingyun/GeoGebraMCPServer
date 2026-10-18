#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * 离线自检：不需要浏览器，也不需要 GeoGebra 内核。
 *
 * 1. 命令行开关（--help / --version / 未知参数退出码）。
 * 2. 按 stdio 启动 bin/geogebra-mcp-bridge.mjs，列出工具，逐个把 inputSchema
 *    送进宿主（DSH）支持的 JSON Schema 子集校验器——多一个关键字就会让
 *    mcp-client 整体注册失败。
 * 3. 起一个「假页面」：连上桥的 SSE 通道，按同一份协议回投结果。它不实现
 *    GeoGebra，只实现本桥约定要用的那些方法，用来验证桥这一侧的协议、参数
 *    映射、错误路径与文件读写都通。真实 ggbApplet 的行为由浏览器实机验证。
 *
 * schema 子集校验器取自 DSH 安装目录（`DSH_CHECKOUT`），本机没有就跳过那一步。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const binPath = join(packageDir, 'bin', 'geogebra-mcp-bridge.mjs');
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** 自检用的 HTTP 端口：避开默认 3460，免得和正在跑的桥撞上。 */
const TEST_PORT = Number(process.env.GGB_TEST_PORT ?? 3489);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const CLIENT_ID = 'fake-page';

/**
 * DSH 安装目录：只用来拿它的 schema 子集校验器。
 * 没设 `DSH_CHECKOUT` 时跳过那一步，离线协议断言照跑。
 */
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? '';
const DSH_TOOLS = DSH_CHECKOUT ? `${DSH_CHECKOUT}/@deepseek-ai/dsh-tools/lib/index.js` : '';

/** 1×1 透明 PNG，用来冒充 GeoGebra 的导出结果。 */
const PNG_1X1 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

let failed = 0;
const fail = (message) => {
	console.error(message);
	failed += 1;
};
const check = (name, condition, detail) => {
	if (condition) console.log(`  ✓ ${name}`);
	else fail(`  ✗ ${name}${detail === undefined ? '' : `：${detail}`}`);
};

/* ------------------------------------------------------------ 命令行开关 */

const version = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
check('--version', version.status === 0 && version.stdout.trim() === pkg.version, `status=${version.status}`);

const help = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
check('--help', help.status === 0 && help.stdout.includes('geogebra-mcp-bridge'), `status=${help.status}`);

const badArg = spawnSync(process.execPath, [binPath, '--nope'], { encoding: 'utf8' });
check('未知参数以 2 退出', badArg.status === 2, `实际 ${badArg.status}`);

/* ---------------------------------------------------------- 假页面客户端 */

/**
 * 一个内存里的假 GeoGebra：够跑通桥的协议与参数映射，不做真实几何。
 *
 * @param {number} port
 */
function startFakeClient(port, canvasHint = '') {
	const base = `http://127.0.0.1:${port}`;
	const state = {
		objects: new Map(),
		events: [
			{ at: Date.now() - 3000, kind: 'add', target: 'A' },
			{ at: Date.now() - 1200, kind: 'setMode', detail: '工具 15' },
		],
		mode: 15,
		invoked: [],
		loaded: null,
	};
	const controller = new AbortController();
	let ready = false;

	const summary = (name) => {
		const object = state.objects.get(name);
		if (!object) return null;
		return {
			name: object.name,
			type: object.type,
			visible: object.visible,
			color: object.color,
			value: object.value,
			definition: object.definition,
		};
	};

	const fakeEval = (command) => {
		const text = String(command ?? '');
		if (/BADCOMMAND/i.test(text)) {
			return { ok: false, error: '（假页面）语法错误', created: [], objectCount: state.objects.size };
		}
		const created = [];
		for (const line of text.split('\n')) {
			// Delete(A) 这类删除命令
			const deleteMatch = /^\s*Delete\(\s*([A-Za-z]\w*)\s*\)\s*$/i.exec(line);
			if (deleteMatch) {
				state.objects.delete(deleteMatch[1]);
				continue;
			}
			// A=(1,2) 与 f(x)=x^2 都算定义式
			const match = /^\s*([A-Za-z]\w*)\s*(?:\([^)]*\))?\s*=\s*(.+)$/.exec(line);
			if (!match) continue;
			const name = match[1];
			const value = match[2].trim();
			const type = value.includes('(') ? 'point' : /\b(x|y|z)\b/.test(value) ? 'function' : 'numeric';
			const object = {
				name,
				type,
				visible: true,
				color: '#0000FF',
				value: type === 'point' ? '(1, 2)' : value,
				definition: `${name}=${value}`,
				command: `${name}=${value}`,
				latex: value,
				independent: true,
				defined: true,
				layer: 0,
				lineStyle: 0,
				lineThickness: 2,
				pointStyle: 0,
				pointSize: 5,
				filling: 0.1,
				labelStyle: 1,
				labelVisible: true,
				caption: '',
				coords: type === 'point' ? { x: 1, y: 2 } : { x: 1, y: 2 },
			};
			state.objects.set(name, object);
			created.push({ name, type, value: object.value });
		}
		return { ok: true, error: null, created, objectCount: state.objects.size };
	};

	const fakeInvoke = (method, rawArgs) => {
		const args = Array.isArray(rawArgs) ? rawArgs : [];
		const name = typeof args[0] === 'string' ? args[0] : undefined;
		switch (method) {
			case 'setVisible': {
				const object = state.objects.get(name);
				if (object) object.visible = args[1] === true;
				return null;
			}
			case 'setColor': {
				const object = state.objects.get(name);
				const hex = args
					.slice(1, 4)
					.map((value) => Math.trunc(Number(value)).toString(16).padStart(2, '0'))
					.join('')
					.toUpperCase();
				if (object) object.color = `#${hex}`;
				return null;
			}
			case 'renameObject': {
				const object = state.objects.get(name);
				if (!object || state.objects.has(args[1])) return false;
				state.objects.delete(name);
				object.name = args[1];
				state.objects.set(object.name, object);
				return true;
			}
			case 'deleteObject': {
				state.objects.delete(name);
				return null;
			}
			case 'newConstruction': {
				state.objects.clear();
				return null;
			}
			case 'setMode': {
				state.mode = args[0];
				state.invoked.push([method, args[0]]);
				return null;
			}
			default: {
				state.invoked.push([method, ...args]);
				return null;
			}
		}
	};

	const handlers = {
		ping: () => ({ pong: true, ready: true, clientId: CLIENT_ID }),
		info: () => ({
			version: '5.4.932.1-fake',
			appName: 'classic',
			objectCount: state.objects.size,
			mode: state.mode,
			width: 800,
			height: 600,
		}),
		eval: (params) => fakeEval(params.command),
		evalCAS: () => ({ result: 'x^3/3' }),
		objects: (params) => {
			const wanted = params.type === undefined || params.type === null ? '' : String(params.type);
			const list = [...state.objects.values()]
				.filter((object) => wanted === '' || object.type === wanted)
				.map((object) => summary(object.name));
			return { count: state.objects.size, objects: list };
		},
		object: (params) => {
			const object = state.objects.get(String(params.name ?? ''));
			return object ? { ...object, exists: true } : { exists: false, name: params.name };
		},
		events: () => {
			const drained = state.events;
			state.events = [];
			return { events: drained };
		},
		webgl: () => ({ webgl: true, webgl2: true, vendor: 'FakeVendor', renderer: 'FakeRenderer' }),
		release: () => {
			// 桥会先等这条回复再删画布；回完就让通道断开，模拟页面自我拆除。
			setTimeout(() => controller.abort(), 300);
			return { released: true };
		},
		view: () => ({
			appName: 'classic',
			has3DView: true,
			mode: state.mode,
			grid: state.grid ?? false,
			axes: true,
			range: { xmin: -5, xmax: 5, ymin: -3, ymax: 3 },
			width: 800,
			height: 600,
			perspective: '视图 1 开，视图 2 关',
			graphicsOptions: '{"grid":false,"axes":true}',
		}),
		invoke: (params) => ({ method: params.method, result: fakeInvoke(params.method, params.args) }),
		getState: (params) => {
			const format = String(params.format ?? 'base64');
			if (format === 'xml') return { format, data: '<construction><element type="point"><label>A</label></element></construction>' };
			return { format, data: Buffer.from('FAKEGGB').toString('base64') };
		},
		setState: (params) => {
			state.loaded = { format: params.format, data: params.data };
			return { ok: true, objectCount: state.objects.size };
		},
		screenshot: (params) => ({ base64: PNG_1X1, scale: params.scale ?? 1 }),
		exportPNG: (params) => ({ base64: PNG_1X1, scale: params.scale ?? 1 }),
		exportSVG: () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>' }),
		exportPDF: (params) => ({ base64: Buffer.from('%PDF-1.4\nfake\n').toString('base64'), scale: params.scale ?? 1 }),
	};

	async function reply(message) {
		let ok = true;
		let result = null;
		let error = null;
		try {
			const handler = handlers[message.method];
			if (typeof handler !== 'function') throw new Error(`假页面不认识方法 ${message.method}`);
			result = await handler(message.params ?? {});
		} catch (caught) {
			ok = false;
			error = String(caught?.message ?? caught);
		}
		await fetch(`${base}/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientId: CLIENT_ID, id: message.id, ok, result, error }),
		}).catch(() => {});
	}

	async function run() {
		const response = await fetch(`${base}/events?clientId=${CLIENT_ID}&canvas=${encodeURIComponent(canvasHint)}`, {
			headers: { accept: 'text/event-stream' },
			signal: controller.signal,
		});
		if (!response.ok || !response.body) throw new Error(`连不上桥的 SSE：HTTP ${response.status}`);
		const helloResponse = await fetch(`${base}/hello`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientId: CLIENT_ID,
				canvas: canvasHint,
				info: { version: '5.4.932.1-fake', appName: 'classic', objectCount: 0, mode: 15, width: 800, height: 600 },
			}),
		});
		const helloBody = await helloResponse.json().catch(() => ({}));
		state.canvasId = helloBody.canvasId ?? canvasHint;
		ready = true;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf('\n\n')) >= 0) {
				const chunk = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
				if (!dataLine) continue;
				let message;
				try {
					message = JSON.parse(dataLine.slice(6));
				} catch {
					continue;
				}
				await reply(message);
			}
		}
	}

	return {
		state,
		started: run(),
		isReady: () => ready,
		stop: () => controller.abort(),
	};
}

/** 等桥的 HTTP 服务和假页面都就位。 */
async function waitFor(label, probe, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await probe()) return true;
		} catch {
			// 还没起来，继续等
		}
		if (Date.now() > deadline) throw new Error(`等待「${label}」超过 ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

/* -------------------------------------------------------------- 主流程 */

const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [binPath, '--port', String(TEST_PORT)],
	stderr: 'pipe',
});
const client = new Client({ name: 'geogebra-bridge-selfcheck', version: '0.1.0' });

/** 调一个工具，取出全部文本内容。 */
async function call(name, args) {
	const result = await client.callTool({ name, arguments: args ?? {} });
	const text = (result.content ?? [])
		.filter((item) => item.type === 'text')
		.map((item) => item.text)
		.join('\n');
	return { result, text, isError: result.isError === true };
}

/** 当前画布 id：由 canvas_create 返回，之后所有页面级工具都要带它。 */
let CANVAS_ID = '';
const page = (name, args) => call(name, { id: CANVAS_ID, ...(args ?? {}) });

const tempDir = mkdtempSync(join(tmpdir(), 'ggb-selfcheck-'));
let fake;

try {
	await client.connect(transport);
	console.log(`\n桥已启动（HTTP 自检端口 ${TEST_PORT}）。`);

	/* --- 工具清单与 schema 子集 --- */

	const { tools } = await client.listTools();
	console.log(`\n工具 ${tools.length} 个：${tools.map((tool) => tool.name).join('、')}`);
	check('工具数量与预期一致（14 个）', tools.length === 14, `实际 ${tools.length}`);
	const expected = ['status', 'help', 'objects', 'object', 'events', 'screenshot', 'view', 'eval', 'set', 'edit', 'state', 'export', 'canvas_create', 'canvas_release'];
	for (const name of expected) {
		check(`工具存在：${name}`, tools.some((tool) => tool.name === name));
	}

	let assertSupportedJsonSchema;
	try {
		({ assertSupportedJsonSchema } = await import(DSH_TOOLS));
	} catch (error) {
		console.warn(`（跳过 schema 子集校验：没找到 ${DSH_TOOLS}）`);
	}
	const beforeSchema = failed;
	for (const tool of tools) {
		const schema = tool.inputSchema;
		if (schema === undefined) {
			fail(`[${tool.name}] 没有 inputSchema`);
			continue;
		}
		if (Array.isArray(schema.required) && schema.required.some((key) => !(key in (schema.properties ?? {})))) {
			fail(`[${tool.name}] required 里有未声明的参数`);
			continue;
		}
		if (assertSupportedJsonSchema !== undefined) {
			try {
				assertSupportedJsonSchema(JSON.parse(JSON.stringify(schema)));
			} catch (error) {
				fail(`[${tool.name}] inputSchema 不在宿主支持子集内：${error.message}`);
			}
		}
	}
	check('全部 inputSchema 落在宿主支持子集内', failed === beforeSchema);

	/* --- 画布生命周期：id 是必需的句柄 --- */

	console.log('\n画布生命周期：');
	const noId = await call('objects', {});
	check('页面工具不带 id 被拒绝（schema 层就拦下）', noId.isError && /id/.test(noId.text), noId.text.slice(0, 200));
	const unknownId = await call('objects', { id: 'c9' });
	check('未知画布 id 报错并提示现有画布', unknownId.isError && unknownId.text.includes('没有这个画布：c9'), unknownId.text.slice(0, 160));
	const statusEmpty = await call('status', {});
	check('status 报告 0 个画布', statusEmpty.text.includes('画布：0 个'), statusEmpty.text.slice(0, 200));

	/* --- 确认框：canvas_create 先登记，等用户点「已打开」才返回 --- */

	console.log('\n确认框（/api/pending）：');

	/** 读一次确认清单（等价于界面轮询一次，会把「有人在看弹窗」标上）。 */
	const readPending = async () => (await fetch(`${BASE_URL}/api/pending`)).json();
	/** 提交用户在弹窗里的选择。 */
	const postConfirm = async (id, action) => {
		const response = await fetch(`${BASE_URL}/api/pending/confirm`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, action }),
		});
		return { status: response.status, body: await response.json() };
	};
	/** 等到 probe 返回一个真值（不是布尔）。 */
	const waitForValue = async (label, probe, timeoutMs = 10000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await probe().catch(() => null);
			if (value) return value;
			if (Date.now() > deadline) throw new Error(`等待「${label}」超过 ${timeoutMs}ms`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};

	const statusShape = await (await fetch(`${BASE_URL}/api/status`)).json();
	check(
		'/api/status 报出桥身份与确认协议号',
		statusShape.name === 'geogebra-math-bridge' && statusShape.protocol === 2 && Number.isFinite(statusShape.startedAt),
		JSON.stringify(statusShape).slice(0, 200),
	);

	const pendingEmpty = await readPending();
	check(
		'/api/pending 一开始没有等待确认的请求',
		pendingEmpty.ok === true && Array.isArray(pendingEmpty.pending) && pendingEmpty.pending.length === 0,
		JSON.stringify(pendingEmpty).slice(0, 200),
	);

	// 先让桥知道「有人在看弹窗」，这样下面这次 canvas_create 不会退回 no-ui 老路径。
	const confirmingCreate = call('canvas_create', { app: 'classic' });
	const pendingItem = await waitForValue('canvas_create 登记出等待确认的请求', async () => {
		const body = await readPending();
		return (body.pending ?? [])[0] ?? null;
	});
	check(
		'等待确认的请求带画布 id、地址与连接状态',
		Boolean(pendingItem) &&
			/^c\d+$/.test(pendingItem.canvasId) &&
			String(pendingItem.url).includes(`?canvas=${pendingItem.canvasId}`) &&
			pendingItem.app === 'classic' &&
			pendingItem.connected === false,
		JSON.stringify(pendingItem).slice(0, 240),
	);

	const bogusConfirm = await postConfirm('o999', 'opened');
	check(
		'确认一个不存在的请求被拒绝（409）',
		bogusConfirm.status === 409 && bogusConfirm.body.ok === false && bogusConfirm.body.accepted === false,
		JSON.stringify(bogusConfirm).slice(0, 200),
	);

	const unknownAction = await postConfirm(pendingItem.id, 'whatever');
	check(
		'不认识的动作被拒绝，请求仍在等待',
		unknownAction.body.accepted === false && (await readPending()).pending.length === 1,
		JSON.stringify(unknownAction).slice(0, 200),
	);

	const opened = await postConfirm(pendingItem.id, 'opened');
	check('确认「已打开」被受理', opened.body.ok === true && opened.body.accepted === true, JSON.stringify(opened).slice(0, 200));

	const confirmedResult = await confirmingCreate;
	check(
		'确认后 canvas_create 才返回，并说明用户已确认',
		!confirmedResult.isError && confirmedResult.text.includes('用户已在网页界面的确认框里点过「已打开」'),
		confirmedResult.text.slice(0, 300),
	);
	const confirmedId = /画布 (c\d+) 已建好/.exec(confirmedResult.text)?.[1] ?? '';
	check('确认路径仍给出画布 id 与地址', Boolean(confirmedId) && confirmedResult.text.includes(`?canvas=${confirmedId}`), confirmedResult.text.slice(0, 200));
	check('确认之后没有残留的等待请求', (await readPending()).pending.length === 0);

	// 跳过：用户不想等页面连上，agent 也该拿到 id 继续。
	const skippingCreate = call('canvas_create', { app: 'suite' });
	const skipItem = await waitForValue('跳过路径登记出请求', async () => {
		const body = await readPending();
		return (body.pending ?? [])[0] ?? null;
	});
	const skipped = await postConfirm(skipItem.id, 'skip');
	check('确认「跳过」被受理', skipped.body.ok === true && skipped.body.accepted === true, JSON.stringify(skipped).slice(0, 200));
	const skippedResult = await skippingCreate;
	check(
		'跳过后 canvas_create 返回并说明用户跳过了',
		!skippedResult.isError && skippedResult.text.includes('用户在确认框里选了「跳过」'),
		skippedResult.text.slice(0, 300),
	);
	const skippedId = /画布 (c\d+) 已建好/.exec(skippedResult.text)?.[1] ?? '';
	await call('canvas_release', { id: skippedId });
	await call('canvas_release', { id: confirmedId });
	check('确认框用过的画布都能释放', (await (await fetch(`${BASE_URL}/api/status`)).json()).canvases.length === 0);

	// headless 是自动化路径：不弹确认框，立刻返回。
	const headlessCreate = await call('canvas_create', { app: 'geometry', headless: true, browser: 'definitely-not-a-browser-xyz' });
	const headlessId = /画布 (c\d+) 已建好/.exec(headlessCreate.text)?.[1] ?? '';
	check('headless 不弹确认框', (await readPending()).pending.length === 0 && Boolean(headlessId), headlessCreate.text.slice(0, 200));
	await call('canvas_release', { id: headlessId });

	// 超时：没人确认时也要把 id 还回来，不能把模型永远卡住。
	const timeoutCreate = call('canvas_create', { app: 'classic', confirmTimeoutMs: 5000 });
	const timeoutResult = await timeoutCreate;
	check(
		'没人确认时按 confirmTimeoutMs 超时返回',
		!timeoutResult.isError && timeoutResult.text.includes('没有回应') && /画布 (c\d+) 已建好/.test(timeoutResult.text),
		timeoutResult.text.slice(0, 300),
	);
	const timeoutId = /画布 (c\d+) 已建好/.exec(timeoutResult.text)?.[1] ?? '';
	check('超时后没有残留的等待请求', (await readPending()).pending.length === 0);
	await call('canvas_release', { id: timeoutId });

	console.log('  （确认框：等待 5 秒的超时断言会真的等一次）');

	// 建画布：拉不起浏览器时不能抛错（画布已经建好了，抛错会漏掉这个 id）
	const created = await call('canvas_create', { app: '3d', headless: true, browser: 'definitely-not-a-browser-xyz' });
	CANVAS_ID = /画布 (c\d+) 已建好/.exec(created.text)?.[1] ?? '';
	check('canvas_create 返回画布 id', Boolean(CANVAS_ID), created.text.slice(0, 200));
	check(
		'canvas_create 给出带 canvas 与 app 的地址',
		created.text.includes(`?canvas=${CANVAS_ID}`) && created.text.includes('app=3d'),
		created.text.slice(0, 240),
	);
	check('canvas_create 拉不起浏览器时给地址而不抛错', !created.isError && created.text.includes('请自己打开'), created.text.slice(0, 300));

	const notConnected = await page('objects', {});
	check('画布还没连页面时报错可读', notConnected.isError && notConnected.text.includes('还没有页面连上来'), notConnected.text.slice(0, 220));

	/* --- 缺参数被 schema 拒绝 --- */

	const missing = await page('eval', {});
	check('eval 缺参数被拒绝', missing.isError);

	/* --- 起假页面，接上这个画布 --- */

	fake = startFakeClient(TEST_PORT, CANVAS_ID);
	fake.started.catch((error) => console.error(`假页面通道结束：${error?.message ?? error}`));
	await waitFor('假页面连上画布', async () => {
		const response = await fetch(`${BASE_URL}/api/status`);
		const body = await response.json();
		return (body.canvases ?? []).some((c) => c.id === CANVAS_ID && c.connected) && fake.isReady();
	});
	console.log('\n假页面已接到画布 ' + CANVAS_ID + '，开始跑工具：');

	const status = await call('status', {});
	check('status 看到这个画布已连接', status.text.includes(CANVAS_ID) && status.text.includes('已连接'), status.text.slice(0, 300));
	check('status 报出 GeoGebra 版本', status.text.includes('5.4.932.1-fake'), status.text.slice(0, 300));

	/* --- eval --- */

	const evalOk = await page('eval', { command: 'A=(1,2)\nf(x)=x^2' });
	check('eval 成功并报出新建对象', !evalOk.isError && evalOk.text.includes('新建 2 个对象'), evalOk.text);
	check('eval 报出对象名 A', evalOk.text.includes('A（point）'), evalOk.text);

	const evalBad = await page('eval', { command: 'BADCOMMAND whatever' });
	check('eval 语法错误被识别为「没有变化」', evalBad.text.includes('没有产生任何变化'), evalBad.text);

	const evalCas = await page('eval', { command: 'Integral(x^2)', engine: 'cas' });
	check('eval engine=cas 走 CAS', evalCas.text.includes('x^3/3'), evalCas.text);

	const emptyCommand = await page('eval', { command: '   ' });
	check('空命令被拒绝', emptyCommand.isError);

	/* --- objects / object --- */

	const objects = await page('objects', {});
	check('objects 列出 A 与 f', objects.text.includes('A') && objects.text.includes('f'), objects.text.slice(0, 200));

	const points = await page('objects', { type: 'point' });
	check('objects type=point 只留点', points.text.includes('A') && !points.text.includes('function'), points.text.slice(0, 200));

	const noSuchType = await page('objects', { type: 'polygon' });
	check('objects 空结果有可读提示', noSuchType.text.includes('没有类型为 polygon 的对象'), noSuchType.text);

	const detail = await page('object', { name: 'A' });
	check('object 给出详情', detail.text.includes('A（point') && detail.text.includes('坐标'), detail.text.slice(0, 200));

	const missingObject = await page('object', { name: 'ZZZ' });
	check('object 不存在时报错可读', missingObject.isError && missingObject.text.includes('没有叫 ZZZ 的对象'), missingObject.text);

	/* --- events --- */

	const events = await page('events', {});
	check('events 读走两条', events.text.includes('共 2 条事件') && events.text.includes('setMode'), events.text);
	const eventsAgain = await page('events', {});
	check('events 读取即清空', eventsAgain.text.includes('没有新事件'), eventsAgain.text);

	/* --- view --- */

	const view = await page('view', {});
	check('view 给出坐标范围', view.text.includes('x ∈ [-5, 5]'), view.text.replace(/\n/g, ' ').slice(0, 200));
	check('view 报出 3D 视图与 WebGL 状态', view.text.includes('构造里有 3D 视图：有') && view.text.includes('浏览器 WebGL：可用'), view.text.replace(/\n/g, ' ').slice(0, 240));
	check('view 给出当前工具', view.text.includes('15'), view.text.replace(/\n/g, ' ').slice(0, 200));

	const viewSet = await page('view', { grid: false, mode: 0 });
	check('view 设置后回读', viewSet.text.startsWith('已调整：') && viewSet.text.includes('网格关'), viewSet.text.split('\n')[0]);
	check('view 把 setGridVisible 发到页面', fake.state.invoked.some((entry) => entry[0] === 'setGridVisible' && entry[1] === false), JSON.stringify(fake.state.invoked));

	const badRange = await page('view', { xmin: 0 });
	check('view 只给一半范围被拒绝', badRange.isError && badRange.text.includes('四个值一起给'), badRange.text);

	/* --- set / edit --- */

	const setVisible = await page('set', { object: 'A', property: 'visible', flag: false });
	check('set visible 走 setVisible', setVisible.text.includes('setVisible') && fake.state.objects.get('A')?.visible === false, setVisible.text);

	const setColor = await page('set', { object: 'A', property: 'color', red: 255, green: 0, blue: 0 });
	check('set color 走 setColor', setColor.text.includes('setColor') && fake.state.objects.get('A')?.color === '#FF0000', setColor.text);

	const setMissing = await page('set', { object: 'A', property: 'color', red: 255 });
	check('set 缺参数被拒绝', setMissing.isError && setMissing.text.includes('red / green / blue'), setMissing.text);

	const renamed = await page('edit', { action: 'rename', object: 'A', newName: 'P' });
	check('edit rename 生效', !renamed.isError && fake.state.objects.has('P') && !fake.state.objects.has('A'), renamed.text);

	const deleted = await page('edit', { action: 'delete', object: 'P' });
	check('edit delete 生效', deleted.text.includes('已删除 P') && !fake.state.objects.has('P'), deleted.text);

	const undo = await page('edit', { action: 'undo' });
	check('edit undo 发到页面', undo.text.includes('已撤销') && fake.state.invoked.some((entry) => entry[0] === 'undo'), undo.text);

	/* --- state save / load --- */

	const ggbPath = join(tempDir, 'demo.ggb');
	const xmlPath = join(tempDir, 'demo.xml');
	const saved = await page('state', { action: 'save', path: ggbPath });
	check('state save 写出 .ggb', existsSync(ggbPath) && readFileSync(ggbPath).toString('utf8') === 'FAKEGGB', saved.text);
	const savedXml = await page('state', { action: 'save', path: xmlPath });
	check('state save 按扩展名选 xml', savedXml.text.includes('xml') && existsSync(xmlPath), savedXml.text);
	const loaded = await page('state', { action: 'load', path: ggbPath });
	check('state load 回灌页面', loaded.text.includes('已从') && fake.state.loaded?.format === 'base64', loaded.text);
	const stateGet = await page('state', { action: 'get', format: 'xml' });
	check('state get 返回 XML', stateGet.text.includes('<construction>'), stateGet.text.slice(0, 160));
	const stateSet = await page('state', { action: 'set', format: 'xml', data: '<construction/>' });
	check('state set 生效', stateSet.text.includes('已用 xml 数据替换'), stateSet.text);

	/* --- export --- */

	const pngPath = join(tempDir, 'plot.png');
	const exportedPng = await page('export', { format: 'png', path: pngPath });
	check('export png 写文件', existsSync(pngPath) && readFileSync(pngPath).subarray(1, 4).toString('latin1') === 'PNG', exportedPng.text);

	const inlinePng = await page('export', { format: 'png' });
	check('export png 不给 path 时返回图片内容', (inlinePng.result.content ?? []).some((item) => item.type === 'image'), JSON.stringify(inlinePng.result.content).slice(0, 120));

	const svg = await page('export', { format: 'svg' });
	check('export svg 返回矢量文本', svg.text.includes('<svg'), svg.text.slice(0, 120));

	const pdfNoPath = await page('export', { format: 'pdf' });
	check('export pdf 缺 path 被拒绝', pdfNoPath.isError && pdfNoPath.text.includes('path'), pdfNoPath.text);

	const pdfPath = join(tempDir, 'plot.pdf');
	const exportedPdf = await page('export', { format: 'pdf', path: pdfPath, scale: 2 });
	check('export pdf 写文件', existsSync(pdfPath) && exportedPdf.text.includes('PDF 已保存'), exportedPdf.text);

	/* --- screenshot --- */

	const shot = await page('screenshot', {});
	check('screenshot 返回图片内容', (shot.result.content ?? []).some((item) => item.type === 'image'), JSON.stringify(shot.result.content).slice(0, 120));
	check('screenshot 报出像素尺寸', shot.text.includes('1×1'), shot.text);

	/* --- help / open --- */

	for (const topic of ['bridge', 'commands', 'cas', 'views', 'events']) {
		const topicHelp = await call('help', { topic });
		check(`help ${topic} 有内容`, !topicHelp.isError && topicHelp.text.length > 200, topicHelp.text.slice(0, 80));
	}

	// canvas_create 每次都给新 id，不会因为已有画布而含糊拒绝或重复开窗。
	const thirdForCheck = await call('canvas_create', { app: 'geometry', headless: true, browser: 'definitely-not-a-browser-xyz' });
	const thirdId = /画布 (c\d+) 已建好/.exec(thirdForCheck.text)?.[1] ?? '';
	check('有画布在用时仍能建新画布（新 id）', Boolean(thirdId) && thirdId !== CANVAS_ID, `已有 ${CANVAS_ID}，新建 ${thirdId}`);
	check('新画布地址带自己的 canvas 与 app', thirdForCheck.text.includes(`?canvas=${thirdId}`) && thirdForCheck.text.includes('app=geometry'), thirdForCheck.text.slice(0, 240));
	await call('canvas_release', { id: thirdId });

	/* --- 第二个画布：与第一个互不干扰，可单独 release --- */

	const second = await call('canvas_create', { app: 'suite', headless: true, browser: 'definitely-not-a-browser-xyz' });
	const secondId = /画布 (c\d+) 已建好/.exec(second.text)?.[1] ?? '';
	check('再建一个画布拿到不同的 id', Boolean(secondId) && secondId !== CANVAS_ID, `${CANVAS_ID} / ${secondId}`);
	const secondNotConnected = await call('objects', { id: secondId });
	check('第二个画布没连页面时报错只提它自己', secondNotConnected.isError && secondNotConnected.text.includes(secondId), secondNotConnected.text.slice(0, 220));
	const releaseSecond = await call('canvas_release', { id: secondId });
	check('canvas_release 释放未连接的画布', !releaseSecond.isError && releaseSecond.text.includes(`画布 ${secondId} 已释放`), releaseSecond.text);
	const afterRelease = await call('objects', { id: secondId });
	check('释放后的 id 不可再用', afterRelease.isError && afterRelease.text.includes('没有这个画布'), afterRelease.text.slice(0, 160));
	const statusStillOne = await call('status', {});
	check('释放第二个画布不影响第一个', statusStillOne.text.includes(CANVAS_ID) && !statusStillOne.text.includes(secondId), statusStillOne.text.slice(0, 300));

	/* --- 页面断开：画布记录保留，只是未连接 --- */

	fake.stop();
	await waitFor('桥感知到页面断开', async () => {
		const response = await fetch(`${BASE_URL}/api/status`);
		const body = await response.json();
		return (body.canvases ?? []).some((c) => c.id === CANVAS_ID && !c.connected);
	});
	const afterClose = await page('objects', {});
	check('页面断开后 objects 报错可读', afterClose.isError && afterClose.text.includes('还没有页面连上来'), afterClose.text.slice(0, 200));
	const statusAfterClose = await call('status', {});
	check('页面断开后画布仍在、只是未连接', statusAfterClose.text.includes(CANVAS_ID) && statusAfterClose.text.includes('未连接'), statusAfterClose.text.slice(0, 300));

	/* --- release：让页面自我拆除并删掉记录 --- */

	fake = startFakeClient(TEST_PORT, CANVAS_ID);
	fake.started.catch(() => {});
	await waitFor('页面重新接回同一个画布', async () => {
		const response = await fetch(`${BASE_URL}/api/status`);
		const body = await response.json();
		return (body.canvases ?? []).some((c) => c.id === CANVAS_ID && c.connected);
	});
	const released = await call('canvas_release', { id: CANVAS_ID });
	check('canvas_release 让页面自己拆除 applet', released.text.includes('applet 已拆除'), released.text);
	await waitFor('画布从列表里消失', async () => {
		const response = await fetch(`${BASE_URL}/api/status`);
		const body = await response.json();
		return (body.canvases ?? []).length === 0;
	});
	const statusFinal = await call('status', {});
	check('释放后画布列表为空', statusFinal.text.includes('画布：0 个'), statusFinal.text.slice(0, 240));

	// 没有画布时，新建的画布地址仍然可用；顺便验无图形环境的分支。
	if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		const noDisplay = await call('canvas_create', { app: 'classic' });
		check(
			'canvas_create 在没有 DISPLAY 时给地址而非抛错',
			!noDisplay.isError && noDisplay.text.includes('图形环境') && noDisplay.text.includes('?canvas='),
			noDisplay.text.slice(0, 260),
		);
	} else {
		console.log('  （跳过无 DISPLAY 的 canvas_create 断言：当前环境有图形显示）');
	}
} finally {
	fake?.stop();
	await client.close().catch(() => {});
	rmSync(tempDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\n自检通过。' : `\n自检失败 ${failed} 项。`);
process.exit(failed === 0 ? 0 : 1);
