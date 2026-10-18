// SPDX-License-Identifier: GPL-3.0-only
/**
 * GeoGebra 数学绘图桥（MCP stdio server）。
 *
 * 浏览器里的 GeoGebra 只认页面上的 `ggbApplet` JS API，没有可以被别的进程
 * 直接调用的接口。所以本程序同时做两件事：
 *
 *   1. 起一个只监听回环地址的 HTTP 服务，托管查看器页面与 GeoGebra 离线包；
 *      页面加载完成后经 SSE 连回来，构造/视图/导出都在这条通道上往返。
 *   2. 在 stdin/stdout 上说 MCP，把那条通道包装成 mcp__geogebra__* 工具。
 *
 * 本进程不跑 GeoGebra 内核，只做协议转换；没有页面连上来时，工具返回一句
 * 可读的中文，并给出查看器地址。stdin/stdout 是 MCP 协议通道，日志走 stderr。
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { BridgeError } from './errors.mjs';
import { startHttpServer } from './http.mjs';
import { SERVER_INFO } from './identity.mjs';
import { ClientHub, DEFAULT_CALL_TIMEOUT_MS } from './hub.mjs';
import { DEFAULT_CONFIRM_TIMEOUT_MS, OpenRequests } from './open-requests.mjs';

export { SERVER_INFO, OpenRequests, DEFAULT_CONFIRM_TIMEOUT_MS };

/** 查看器只监听回环地址。 */
export const DEFAULT_HOST = '127.0.0.1';
/** 查看器默认端口；被占用时向后顺延，实际地址以 status 为准。 */
export const DEFAULT_PORT = 3460;
/**
 * GeoGebra 离线包默认位置（含 GeoGebra/deployggb.js 的那一层）。
 *
 * 默认找「本仓库上一级」的 `geogebra-math-apps-bundle/`，也就是推荐布局：
 *
 *   geogebra/
 *   ├── GeoGebraMCPServer/          ← 本仓库
 *   ├── GeoGebraDSHPlug/            ← DSH 插件
 *   └── geogebra-math-apps-bundle/  ← 官方离线包解压到这里
 *
 * 放在别处时用 `--ggb-root` 或环境变量 `GGB_ROOT` 覆盖。
 */
export const DEFAULT_GGB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'geogebra-math-apps-bundle',
);

/** 各工具的等待上限；GeoGebra 的 API 大多是同步的，只有导出与整份状态偏慢。 */
const TIMEOUT = {
	read: 20_000,
	eval: 60_000,
	state: 120_000,
	export: 60_000,
};

/** 2D 工具栏编号 → 中文名（`setMode` / `view.mode` 用）。只收常用项。 */
const MODE_NAMES = {
	0: '移动',
	1: '点',
	2: '直线（两点）',
	3: '平行线',
	4: '垂线',
	5: '交点',
	6: '删除',
	7: '向量',
	8: '中垂线',
	9: '角平分线',
	10: '圆（两点）',
	11: '圆（三点）',
	13: '切线',
	14: '关系',
	15: '线段',
	16: '多边形',
	17: '文本',
	18: '射线',
	19: '中点',
	24: '半圆',
	25: '滑动条',
	36: '角度',
	38: '距离',
	41: '放大',
	42: '缩小',
	47: '轨迹',
	49: '面积',
	50: '斜率',
	51: '正多边形',
	60: '按钮',
	501: '对象上的点',
};

/** 显示宽度：CJK 与全角字符按 2 列算，用来对齐纯文本表格。 */
function displayWidth(text) {
	let width = 0;
	for (const ch of String(text)) {
		width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
	}
	return width;
}

/** 按显示宽度右侧补空格。 */
function pad(text, width) {
	const value = String(text ?? '');
	return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

/** 按最大显示宽度对齐一列。 */
function column(values) {
	const width = Math.max(0, ...values.map((value) => displayWidth(value)));
	return { width, cell: (value) => pad(value, width) };
}

/** 本地时间 `HH:MM:SS`。 */
function timeLabel(at) {
	const date = new Date(Number(at) || Date.now());
	const pad2 = (n) => String(n).padStart(2, '0');
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 从 PNG 的 IHDR 里读画面尺寸，用来在结果里说清坐标系。 */
function pngSize(buffer) {
	if (buffer.length >= 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	return undefined;
}

/**
 * 把 zod 对象包成 SDK 接受的 StandardSchema，并去掉根上的 `$schema`：
 * 宿主只支持 type/oneOf/properties/required/additionalProperties/items/enum/const
 * 加注解，多一个关键字就拒绝注册。
 *
 * @param {import('zod').ZodObject} schema
 */
function inputSchema(schema) {
	const standard = schema['~standard'];
	const stripRoot = (value) => {
		const { $schema: _ignored, ...rest } = JSON.parse(JSON.stringify(value));
		return rest;
	};
	return {
		'~standard': {
			version: 1,
			vendor: 'geogebra-mcp-bridge',
			validate: (value) => standard.validate(value),
			jsonSchema: {
				input: (options) => stripRoot(standard.jsonSchema.input(options)),
				output: (options) => stripRoot(standard.jsonSchema.output(options)),
			},
		},
	};
}

const textResult = (text) => ({ content: [{ type: 'text', text: text.length > 0 ? text : '(空)' }] });

/** 工具回调：任何失败都变成给模型看的 isError 文本，不让 SDK 抛协议错误。 */
const tool = (run) => async (args) => {
	try {
		return await run(args ?? {});
	} catch (error) {
		const text = error instanceof BridgeError ? error.message : `桥接内部错误：${error?.stack ?? error}`;
		return { isError: true, content: [{ type: 'text', text }] };
	}
};

/** 观测类工具统一只读注解。 */
const readOnly = { readOnlyHint: true };

/** `eval` 结果的中文摘要。 */
function formatEval(command, out) {
	const lines = [];
	const created = Array.isArray(out?.created) ? out.created : [];
	if (out?.ok === true) {
		if (created.length > 0) {
			lines.push(`已执行，新建 ${created.length} 个对象：`);
			for (const object of created) {
				lines.push(`  · ${object.name}（${object.type}）${object.value ? ` = ${object.value}` : ''}`);
			}
		} else {
			lines.push('已执行并生效（没有新建对象，属于设置/删除/视图类命令）。');
		}
	} else if (out?.ok === false) {
		lines.push('命令没有产生任何变化，多半是语法或参数有问题。');
		if (out?.error) lines.push(`页面报错：${out.error}`);
		lines.push('排查：命令名必须是英文；参数个数与类型要对；引号配对；引用的对象要先存在。用 objects 看当前构造再改。');
	} else {
		lines.push('命令已发出，但构造太大（含图片），无法比对是否生效。用 objects / object 复核。');
	}
	if (typeof out?.objectCount === 'number') lines.push(`构造现有 ${out.objectCount} 个对象。`);
	return lines.join('\n');
}

/** `objects` 结果的表格。 */
function formatObjectList(objects) {
	if (!Array.isArray(objects) || objects.length === 0) return '(构造是空的)';
	const name = column(objects.map((o) => o.name));
	const type = column(objects.map((o) => o.type));
	const lines = [`共 ${objects.length} 个对象：`, ''];
	lines.push(`${name.cell('名称')}  ${type.cell('类型')}  ${pad('可见', 4)}  ${pad('颜色', 8)}  ${pad('值', 26)}  定义`);
	for (const object of objects) {
		lines.push(
			`${name.cell(object.name)}  ${type.cell(object.type)}  ${pad(object.visible ? '是' : '否', 4)}  ${pad(
				object.color ?? '',
				8,
			)}  ${pad(object.value ?? '', 26)}  ${object.definition ?? ''}`,
		);
	}
	return lines.join('\n');
}

/** `object` 结果的键值清单。 */
function formatObjectDetail(object) {
	const lines = [
		`${object.name}（${object.type}${object.independent ? '，独立对象' : '，依赖对象'}）`,
		`值：${object.value ?? '(无)'}`,
		`定义：${object.definition ?? '(无)'}`,
	];
	if (object.command && object.command !== object.definition) lines.push(`非本地化写法：${object.command}`);
	if (object.latex) lines.push(`LaTeX：${object.latex}`);
	if (object.coords) {
		const coords = object.coords;
		lines.push(`坐标：x=${coords.x}${coords.y === undefined ? '' : `  y=${coords.y}`}${coords.z === undefined ? '' : `  z=${coords.z}`}`);
	}
	lines.push(
		`可见：${object.visible ? '是' : '否'}；颜色：${object.color ?? '(未知)'}；图层：${object.layer ?? '(未知)'}；固定：${
			object.fixed ? '是' : '否'
		}`,
	);
	lines.push(
		`标签：${object.labelVisible ? '显示' : '隐藏'}（样式 ${object.labelStyle ?? '(未知)'}：0 名称 / 1 名称+值 / 2 值 / 3 标题）${
			object.caption ? `；标题 ${object.caption}` : ''
		}`,
	);
	lines.push(
		`点：大小 ${object.pointSize ?? '-'} 型 ${object.pointStyle ?? '-'}；线：宽 ${object.lineThickness ?? '-'} 型 ${
			object.lineStyle ?? '-'
		}；填充 ${object.filling ?? '-'}`,
	);
	if (object.defined === false) lines.push('注意：对象当前未定义（值无效）。');
	return lines.join('\n');
}

/** `events` 结果的行清单。 */
function formatEvents(events) {
	if (!Array.isArray(events) || events.length === 0) return '（没有新事件）';
	const lines = [`共 ${events.length} 条事件（读取即清空）：`];
	for (const event of events) {
		const parts = [timeLabel(event.at), event.kind];
		if (event.target) parts.push(event.target);
		if (event.detail) parts.push(`（${event.detail}）`);
		lines.push(`  ${parts.join(' ')}`);
	}
	return lines.join('\n');
}

/** `view` 结果。 */
function formatView(view) {
	const lines = [`应用：${view.appName ?? '(未知)'}；当前工具：${view.mode ?? '?'}${view.modeName ? `（${view.modeName}）` : ''}`];
	if (view.range) {
		const r = view.range;
		lines.push(`可见范围：x ∈ [${round(r.xmin)}, ${round(r.xmax)}]  y ∈ [${round(r.ymin)}, ${round(r.ymax)}]`);
	} else {
		lines.push('可见范围：(没读到，视图可能还没渲染完)');
	}
	lines.push(
		`网格：${view.grid === null || view.grid === undefined ? '(未读到)' : view.grid ? '开' : '关'}；坐标轴：${
			view.axes === null || view.axes === undefined ? '(未读到)' : view.axes ? '开' : '关'
		}；视口像素：${view.width ?? '?'}×${view.height ?? '?'}`,
	);
	if (view.perspective) lines.push(`布局（perspective XML）：${view.perspective}`);
	lines.push(`构造里有 3D 视图：${view.has3DView ? '有' : '没有（要用 view(perspective:"3D") 打开）'}`);
	if (view.webgl) {
		const gl = view.webgl;
		lines.push(
			gl.webgl
				? `浏览器 WebGL：可用（${gl.webgl2 ? 'WebGL2' : 'WebGL1'}${gl.renderer ? `，${gl.renderer}` : ''}）`
				: `浏览器 WebGL：不可用（${gl.error || '未知原因'}）——3D 视图与 3D 计算器都需要它，这会让 3D 面板一片空白`,
		);
	}
	return lines.join('\n');
}

/** 把 base64 PNG 包成「图片 + 一行说明」的工具结果。 */
function imageResult(base64, label, extra = '') {
	const png = Buffer.from(base64, 'base64');
	const size = pngSize(png);
	return {
		content: [
			{ type: 'image', data: base64, mimeType: 'image/png' },
			{ type: 'text', text: `${label}${size ? `：${size.width}×${size.height}` : ''}（PNG）${extra}` },
		],
	};
}

const round = (value) => (Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 1000) / 1000) : String(value));

/** `help` 的五段说明。内容与 GeoGebra 5.4.932.1 的 API 对齐。 */
const HELP_TOPICS = {
	bridge: `桥的结构
  浏览器里的 GeoGebra 只认页面上的 ggbApplet JS API，没有跨进程接口。
  所以本桥自己托管一个查看器页面（页面里加载离线 GeoGebra），页面经 SSE 连回本进程；
  mcp__geogebra__* 的每个调用就是往那条通道上往返一次。

画布（canvas）
  一个「画布」= 一个浏览器里跑着的 GeoGebra 页面，用短 id 指代（c1、c2…）。
  1. canvas_create 建空白画布 → 拿到 id 和要打开的地址（app 参数决定界面）。
     默认会先在用户的网页界面上弹确认框：用户点开地址、页面连上，再点「已打开」，
     这个调用才返回。等几十秒到几分钟是正常的，不要重复建画布；用户点「跳过」、
     或没人能点（没有图形环境 / 界面插件不在）时走老路径：自己拉起浏览器，拉不起
     就把地址交给用户。headless:true / confirm:false 跳过确认框。
  2. 之后每个操作都要带这个 id：objects / object / events / screenshot / view /
     eval / set / edit / state / export；
  3. 不再需要时 canvas_release 释放它（页面里的 applet 会被真正拆除）。
  status 列出所有画布的 id / 界面 / 地址 / 是否已连上页面；地址里没有 canvas 参数的
  手工页面会被自动分配一个 auto-N 画布。

界面（canvas_create 的 app 参数，页面加载时定死，之后改不了）
  按顺序选、命中就停：
  1. 要画 3D / 立体（空间点、曲面、立体几何）        3d
  2. 不需要坐标网格的几何问题（作图、证明、尺规、角度、圆）
                                                     geometry（网格与坐标轴默认关闭）
  3. 只用 suite 就能完成（函数、数列、统计、表格、符号计算）
                                                     suite
  4. 其它（要经典多视图布局、构形协议，或用户点名要经典界面）
                                                     classic（默认，也是兜底）
  选错只能 canvas_release 后重建，所以建画布前先定下来。3d 需要浏览器有可用的 WebGL。

工具分工
  观测  status    桥、离线资源、画布清单（不碰页面，随时可跑）
        objects   对象清单（名称/类型/可见/颜色/值/定义），可只列某类型
        object    单个对象详情（含可直接喂给 eval 的非本地化命令）
        view      当前工具、可见坐标范围、网格/坐标轴、有没有 3D 视图、WebGL 状态
        screenshot 出图给用户看：view="applet"（默认）整窗，view="graphics" 只要图形区
        events    用户操作事件，读取即清空
  操作  eval      执行英文 GeoGebra 命令（主力）
        set       按属性名改样式/数值
        edit      删除/改名/清空/撤销/重做/视野适配
        state     整份构造的 get/set/save/load
        export    PNG / SVG / PDF 出图
        canvas_create / canvas_release   建画布 / 释放画布
        help      本说明书

3D
  3D 视图与 3D 计算器（app=3d）都要浏览器有可用的 WebGL。没有 WebGL 时 3D 面板一片空白，
  view / status 会直接报「3D 渲染：不可用」；这时只有两条路：让用户在 about:config 里打开
  webgl.force-enabled，或者把 3D 内容投影到 2D 重画。
  另外 screenshot / export 只出 2D 图形区（整窗也一样），3D 面板的内容抓不到。

节奏
  1. 先看再动：objects / view 了解现状，动完再核对。
  2. 一次只做一个动作，别把一串互不相关的命令堆在一次 eval 里。
  3. 用户在画布上自己动手时先读 events，才知道他拖了哪个滑块、点了哪个对象。
  4. eval 的返回说明「有没有产生可观察的变化」：新建了对象，或构造/视图变了，就是成功；
     什么都没变多半是语法错。GeoGebra 不提供具体错误文本，用 objects 复核再改。
  5. 画布没连上时先 status：它给出该画布的地址，让用户打开即可。`,

	commands: `eval 的执行方式
  一行一条命令，geoGebra 引擎下可以用 \\n 一次传多条；命令名必须英文，
  例如 Segment(A,B) 而不是「线段(A,B)」。定义式直接写等式即可。
  返回值 ok=true 表示 GeoGebra 接受并执行了；ok=false 表示语法/参数有问题。

造对象（写定义式或调命令）
  点/向量   A=(1,2)      A=(1,2,3)（3D）     v=Vector(A,B)     Midpoint(A,B)
  直线段    Line(A,B)    Segment(A,B)        Ray(A,B)          PerpendicularLine(A,f)
            ParallelLine(A,f)  PerpendicularBisector(A,B)  AngleBisector(A,B,C)
  圆/圆锥   Circle(A,2)  Circle(A,B)         Circle(A,B,C)     Circumcircle(A,B,C)
            Incircle(A,B,C)  Ellipse(F1,F2,a)  Parabola(F,d)   Hyperbola(F1,F2,a)
  多边形    Polygon(A,B,C)  RegularPolygon(A,B,n)  Area(poly)  Perimeter(poly)
  函数      f(x)=x^2     f'(x)               Integral(f)       Integral(f,a,b)
            Limit(f,0)   Extremum(f)         Root(f)           Intersect(f,g)
            Tangent(A,f) TaylorPolynomial(f,0,5)  Asymptote(f)
  数值      a=1          a=Slider(-5,5,0.1)  n=Slider(1,20,1)  b=2a+1
  解方程    Solve(x^2=4) Solutions(x^2=4)     NSolve(...)       （这些更适合 cas 引擎）
  变换      Translate(poly,v)  Rotate(A,90°,O)  Reflect(A,line)  Dilate(A,2,O)
  列表/统计 l=Sequence(k^2,k,1,10)  Sum(l)  Mean(l)  SD(l)  Histogram(l)
            FitPoly(l,2)  BoxPlot(1,0.5,l)     BarChart(l)
  文本/控件 Text("hello",(1,1))  Text("a="+a,(1,3))  Checkbox("显示")  Button("重置")
  3D        Cube(A,B)  Sphere(A,2)  Pyramid(A,B,C,D,E)  Plane(A,B,C)  Net(poly)
  视图      ZoomIn(2)  ZoomIn(-1,-5,5,-5,5)  （更推荐用 view 工具设范围与网格）

设置与删除（也可以直接用 set / edit 工具）
  SetColor(A,255,0,0)  SetVisible(A,false)  SetLabelMode(A,1)  SetLineThickness(f,5)
  SetFilling(c,0.2)    SetFixed(A,true,false)  SetValue(a,3)  SetCoords(A,3,4)
  Delete(A)  Rename? 改用 edit rename 或右键；Clear? 改用 edit clear

常用坑
  · 中文命令名一律失败；字符串与注释里的中文没问题。
  · 命令之间用换行分隔，不要用分号。
  · 引号里既有单引号又有双引号时注意转义，外层用单引号更省事。
  · 自动命名会撞车：Segment(A,B) 这类命令会自己挑一个空闲小写字母（常常正好是 f），
    之后你再写 f(x)=x^2 就把那条线段改成了函数。给对象显式命名：s=Segment(A,B)。
    eval 的返回里会列出新建对象的真实名字，照着它往下写就不会错。
  · 命令全集（离线不可达时按 help 里这些类推）：geogebra.org/docs/manual/en/commands`,

	cas: `engine: cas 的用法
  eval 传 engine="cas" 时，命令交给 GeoGebra 的 CAS 引擎求符号结果，
  返回结果字符串，并把结果行作为对象放进构造（返回里会列出新对象名）。适合符号运算与方程求解：

  eval(engine="cas", command="Integral(x^2)")          → 1 / 3 x³ + c_1
  eval(engine="cas", command="Solve(x^2-4=0, x)")      → {x = -2, x = 2}
  eval(engine="cas", command="Factor(x^2-1)")          → (x + 1) (x - 1)
  eval(engine="cas", command="Expand((x+1)^3)")        → x³ + 3x² + 3x + 1
  eval(engine="cas", command="Limit(sin(x)/x, x, 0)")  → 1
  eval(engine="cas", command="Derivative(x^3, x)")     → 3x²
  eval(engine="cas", command="Simplify(sin(x)^2+cos(x)^2)") → 1

  只有 classic / suite 这类应用带 CAS；geometry / 3d 没有，会明确报错。
  要符号计算就选 classic 或 suite，别选 3d / geometry。
  查看器在加载时会短暂打开一次 CAS 视图做预热（之后就绪，布局会切回来），
  所以第一次调用通常已经可用；若收到「CAS 没有返回结果」，稍等重试即可。

  CAS 会把结果行作为对象放进构造（例如积分常数 c_{1}），eval 的返回里会列出这些
  新对象名；它们是构造的一部分，会被 state 保存，也可能出现在 objects 里。

  要把符号结果画出来时，再用 engine="geogebra" 把结果建成对象，例如：
  eval(command="f(x)=x^3/3")

  数值近似用 NSolve / NIntegral，或在 geogebra 引擎里用 Integral(f,a,b)。`,

	views: `坐标范围与视图
  读：view 工具不给参数。它给出当前工具、可见范围、网格/坐标轴、视口像素。
  写：view 带参数，先改再返回结果。
      view(xmin:-10, xmax:10, ymin:-5, ymax:5)   设可见范围（四个一起给）
      view(grid:true) / view(grid:false)         网格
      view(axes:true) / view(axes:false)         坐标轴
      view(action:"fit")                         调整视野放下所有对象
      view(perspective:"G")                      只留图形视图
      view(perspective:"AG")                     代数 + 图形
      view(mode:15)                              换当前工具（见下）

  缩放也可以直接发命令：ZoomIn(1.25) 放大、ZoomIn(-1.25) 缩小。

perspective 常用串
  G 图形 | A 代数 | S 表格 | C CAS | P 概率 | T 作图 | 3D 三维 |
  组合写在一起，如 AG、AGS、G3D。切换会改变页面上看到的视图布局。

当前工具编号（view.mode / setMode），2D 常用
  0 移动    1 点      2 直线（两点） 3 平行线  4 垂线   5 交点
  6 删除    7 向量    8 中垂线       9 角平分线 10 圆(两点) 11 圆(三点)
  13 切线   14 关系   15 线段        16 多边形 17 文本   18 射线
  19 中点   24 半圆   25 滑动条      36 角度   38 距离   47 轨迹
  49 面积   50 斜率   51 正多边形    60 按钮   501 对象上的点
  3D 常用：510 平面(三点) 520 球(心+半径) 531 棱柱 533 棱锥 535 展开图 536 正方体

  工具栏编号只影响「用户手动点哪个工具」，不影响 eval 直接造对象。`,

	events: `events 里会出现什么（读取即清空）
  构造变化   add A / remove A / update a / rename A→B / clear
  用户动作   select A（选中）、click A（点击）、dragEnd（拖拽结束）、
             movingGeos（多对象拖动结束）、setMode 15（换工具）
  编辑动作   undo / redo / updateStyle A（样式被改）
  视图动作   perspectiveChange（开关视图）
  编辑器     editorStart / editorStop（进入/离开输入框）

怎么用
  用户在画布上拖过滑块或点之后，先读 events，再决定要不要重算、重画或回答。
  update 事件很密（拖动滑块会连发），桥会合并 120ms 内的同名重复事件。
  事件只记最近 500 条，读走就清空；需要长期跟踪某个对象就打 object 看当前值。
  构造被清空时不会逐个发 remove，只发一条 clear。`,
};

/**
 * 建一个 MCP server 实例并注册全部工具。
 *
 * @param {{hub: ClientHub, openRequests?: OpenRequests, viewerUrl?: () => string, ggbRoot?: string, ggbRootOk?: boolean}} context
 * @returns {McpServer}
 */
export function createServer(context) {
	const hub = context.hub;
	const openRequests = context.openRequests ?? new OpenRequests();
	const viewerUrl = () => (typeof context.viewerUrl === 'function' ? context.viewerUrl() : context.viewerUrl ?? '');
	const ggbRoot = context.ggbRoot ?? DEFAULT_GGB_ROOT;

	/**
	 * 需要画布 id 的工具：统一校验 id，并把 hub.call 绑定到这个画布上。
	 * 回调拿到 (args, call)，call 的签名与原来一样（少一个 canvasId）。
	 */
	const canvasTool = (run) =>
		tool(async (args) => {
			const id = String(args?.id ?? '').trim();
			if (id === '') throw new BridgeError('要带画布 id：先用 canvas_create 建一个，它会把 id 和要打开的地址一起给你。');
			const call = (method, params = {}, options = {}) => hub.call(id, method, params, options);
			return await run(args ?? {}, call);
		});

	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
		instructions: instructionsFor(viewerUrl),
	});

	// ---------------------------------------------------------------- status

	server.registerTool(
		'status',
		{
			title: '自检：桥与画布',
			description:
				'不碰页面、随时可跑：HTTP 查看器、GeoGebra 离线资源、每个画布的 id / 界面 / 地址 / 是否已连上页面 / 对象数。任何调用异常时先跑它——要用哪个 id 也在这里看。',
			inputSchema: inputSchema(z.object({})),
			annotations: readOnly,
		},
		tool(async () => {
			const canvases = hub.snapshot();
			const lines = [
				`GeoGebra 桥：${viewerUrl() || '(HTTP 服务未启动)'}`,
				`离线资源：${ggbRoot}（${context.ggbRootOk === false ? '⚠ 没找到 GeoGebra/deployggb.js，页面会加载不出内核' : '可用'}）`,
				`画布：${canvases.length} 个${canvases.length === 0 ? '（用 canvas_create 建一个，它会返回 id 和要打开的地址）' : ''}`,
			];
			for (const canvas of canvases) {
				const info = canvas.info ?? {};
				lines.push(
					`  · ${canvas.id}  ${canvas.app ?? '?'} 界面  ${
						canvas.connected ? `已连接（GeoGebra ${info.version ?? '?'}，对象 ${info.objectCount ?? '?'}，最后活跃 ${timeLabel(canvas.lastSeenAt)}）` : '未连接（等页面打开）'
					}  ${canvas.url}`,
				);
			}
			if (canvases.length === 0) {
				lines.push('', `也可以手工打开 ${viewerUrl() || '(未启动)'}——不带 canvas 参数时桥会自动分配一个 auto-N 画布。`);
			}
			return textResult(lines.join('\n'));
		}),
	);

	server.registerTool(
		'help',
		{
			title: '用法说明书',
			description:
				'取一段权威说明：bridge=桥与工具怎么配合；commands=eval 里能写的英文命令速查；cas=符号计算引擎；views=视图/坐标范围/工具栏编号；events=用户操作事件。语法细节先看它。',
			inputSchema: inputSchema(
				z.object({
					topic: z.enum(['bridge', 'commands', 'cas', 'views', 'events']).describe('要看哪一段'),
				}),
			),
			annotations: readOnly,
		},
		tool(async ({ topic }) => textResult(HELP_TOPICS[topic] ?? '(未知主题)')),
	);

	// --------------------------------------------------------------- objects

	server.registerTool(
		'objects',
		{
			title: '对象清单',
			description:
				'列出当前构造里的全部对象（可只列某类型）：名称、类型、可见性、颜色、值、定义。想知道「现在有什么」先看它。类型字符串如 point / line / segment / circle / conic / function / numeric / text / list / polygon。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					type: z.string().optional().describe('只要这个类型，例如 point；省略则全部'),
				}),
			),
			annotations: readOnly,
		},
		canvasTool(async ({ type }, call) => {
			const out = await call('objects', { type }, { timeoutMs: TIMEOUT.read });
			const objects = Array.isArray(out?.objects) ? out.objects : [];
			if (objects.length === 0 && type) return textResult(`没有类型为 ${type} 的对象。（构造共 ${out?.count ?? 0} 个对象）`);
			return textResult(formatObjectList(objects));
		}),
	);

	server.registerTool(
		'object',
		{
			title: '单个对象详情',
			description:
				'一个对象的完整状态：值、定义、可直接喂给 eval 的非本地化命令、LaTeX、坐标、颜色、图层、固定、标签、点/线样式、填充。改样式或核对结果时用它。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					name: z.string().describe('对象名，区分大小写，例如 A、f、c_1'),
				}),
			),
			annotations: readOnly,
		},
		canvasTool(async ({ name }, call) => {
			const trimmed = String(name ?? '').trim();
			if (!trimmed) throw new BridgeError('对象名不能为空。');
			const out = await call('object', { name: trimmed }, { timeoutMs: TIMEOUT.read });
			if (out?.exists === false) throw new BridgeError(`构造里没有叫 ${trimmed} 的对象。先用 objects 看清单。`);
			return textResult(formatObjectDetail(out));
		}),
	);

	// ---------------------------------------------------------------- events

	server.registerTool(
		'events',
		{
			title: '用户操作事件（读取即清空）',
			description:
				'自上次读取以来页面里发生的事：用户拖动了滑块/点、点击或选中了对象、切了工具、撤销/重做、开关视图、改了样式、清空了构造。读取即清空，只返回新内容。用户在画布上动过手之后先读它。',
			inputSchema: inputSchema(z.object({
				id: z.string().describe('画布 id（canvas_create 返回的那个）'),
			})),
			annotations: readOnly,
		},
		canvasTool(async (args, call) => {
			const out = await call('events', {}, { timeoutMs: TIMEOUT.read });
			return textResult(formatEvents(out?.events));
		}),
	);

	// ------------------------------------------------------------- screenshot

	server.registerTool(
		'screenshot',
		{
			title: '截取画面',
			description:
				'给用户看画面就用它。view="applet"（默认）截整个 applet 窗口（代数面板 + 各图形面板的布局）；view="graphics" 只截活动图形视图，得到干净的 2D 插图。\n注意：GeoGebra 的导出接口只能读图形视图（2D）的画布，3D 视图是 WebGL 画布，三条导出路径（图形区 / 整窗 / 缩略图）实测都拿不到它的内容——切到 perspective:"3D" 导出的仍是那张 2D 网格。要看 3D 只能在真实窗口里看，或把 3D 内容投影到 2D 重画一遍。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					scale: z.number().optional().describe('倍率，默认 1；2 更清晰但更慢'),
					transparent: z.boolean().optional().describe('view=graphics 时背景是否透明，默认 false（白底）'),
					view: z.enum(['applet', 'graphics']).optional().describe('applet（默认）整个窗口；graphics 只要图形区（2D）'),
				}),
			),
			annotations: readOnly,
		},
		canvasTool(async ({ scale, transparent, view = 'applet' }, call) => {
			const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
			if (view === 'graphics') {
				const out = await call('screenshot', { scale: factor, transparent: transparent === true }, { timeoutMs: TIMEOUT.export });
				const base64 = String(out?.base64 ?? '');
				if (!base64) throw new BridgeError('GeoGebra 没有返回 PNG（图形视图可能还没渲染）。');
				return imageResult(base64, '图形区（活动图形视图）');
			}
			try {
				const out = await call('screenshotApplet', { scale: factor }, { timeoutMs: TIMEOUT.export });
				const base64 = String(out?.base64 ?? '');
				if (!base64) throw new BridgeError('整窗截图返回空');
				return imageResult(base64, '整个 applet 窗口（含全部可见面板）');
			} catch (error) {
				// 官方把 getScreenshotBase64 标为「仅内部使用，未必所有浏览器可用」，
				// 所以失败时退回图形区，并把原因说清楚，不要让模型以为画面就是全部。
				const out = await call('screenshot', { scale: factor, transparent: transparent === true }, { timeoutMs: TIMEOUT.export });
				const base64 = String(out?.base64 ?? '');
				if (!base64) throw new BridgeError('GeoGebra 没有返回 PNG（图形视图可能还没渲染）。');
				const why = error instanceof BridgeError ? error.message : String(error?.message ?? error);
				return imageResult(base64, '图形区（活动图形视图）', `\n整窗截图不可用（${why}），已退回图形区：3D 面板的内容不会出现在这张图里。`);
			}
		}),
	);

	// ------------------------------------------------------------------ view

	server.registerTool(
		'view',
		{
			title: '视图：读取或调整',
			description:
				'不给参数就是读：当前工具、可见坐标范围、网格/坐标轴、视口像素、布局。给了参数就先改再读：范围（xmin/xmax/ymin/ymax 四个一起给）、网格、坐标轴、布局 perspective、当前工具 mode、缩放动作（in/out/fit）。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					xmin: z.number().optional().describe('左边界，与 xmax/ymin/ymax 一起给'),
					xmax: z.number().optional().describe('右边界'),
					ymin: z.number().optional().describe('下边界'),
					ymax: z.number().optional().describe('上边界'),
					grid: z.boolean().optional().describe('网格开关'),
					axes: z.boolean().optional().describe('坐标轴开关（图形区 1、2）'),
					perspective: z.string().optional().describe('布局串，例如 G（只图形）或 AG（代数+图形）'),
					mode: z.number().optional().describe('当前工具编号，见 help views'),
					action: z.enum(['in', 'out', 'fit']).optional().describe('in/out 缩放，fit 调整视野放下所有对象'),
				}),
			),
			annotations: readOnly,
		},
		canvasTool(async (args, call) => {
			const changes = [];
			const hasRange = [args.xmin, args.xmax, args.ymin, args.ymax].some((value) => Number.isFinite(value));
			if (hasRange) {
				if (![args.xmin, args.xmax, args.ymin, args.ymax].every((value) => Number.isFinite(value))) {
					throw new BridgeError('设范围要四个值一起给：xmin / xmax / ymin / ymax。');
				}
				if (!(args.xmin < args.xmax) || !(args.ymin < args.ymax)) {
					throw new BridgeError('范围要满足 xmin < xmax 且 ymin < ymax。');
				}
				await call('invoke', { method: 'setCoordSystem', args: [args.xmin, args.xmax, args.ymin, args.ymax] });
				changes.push(`范围 x∈[${args.xmin},${args.xmax}] y∈[${args.ymin},${args.ymax}]`);
			}
			if (typeof args.grid === 'boolean') {
				await call('invoke', { method: 'setGridVisible', args: [args.grid] });
				changes.push(`网格${args.grid ? '开' : '关'}`);
			}
			if (typeof args.axes === 'boolean') {
				await call('invoke', { method: 'setAxesVisible', args: [args.axes, args.axes] });
				changes.push(`坐标轴${args.axes ? '开' : '关'}`);
			}
			if (typeof args.perspective === 'string' && args.perspective.trim()) {
				await call('invoke', { method: 'setPerspective', args: [args.perspective.trim()] });
				// setPerspective 只切视图，不重算画布；不补这一步，真实浏览器里也会出现
				// 「布局报告已是 3D、画面还是旧的那张」。
				await call('invoke', { method: 'recalculateEnvironments', args: [] }).catch(() => {});
				changes.push(`布局 ${args.perspective.trim()}`);
			}
			if (Number.isFinite(args.mode)) {
				await call('invoke', { method: 'setMode', args: [args.mode] });
				changes.push(`工具 ${args.mode}`);
			}
			if (args.action === 'fit') {
				await call('invoke', { method: 'showAllObjects', args: [] });
				changes.push('视野适配全部对象');
			} else if (args.action === 'in' || args.action === 'out') {
				const factor = args.action === 'in' ? 1.25 : -1.25;
				await call('eval', { command: `ZoomIn(${factor})` }, { timeoutMs: TIMEOUT.eval });
				changes.push(args.action === 'in' ? '放大' : '缩小');
			}
			const out = await call('view', {}, { timeoutMs: TIMEOUT.read });
			// 顺带把 WebGL 状态带上：3D 面板空白时这就是原因。
			out.webgl = await call('webgl', {}, { timeoutMs: TIMEOUT.read }).catch(() => null);
			const prefix = changes.length > 0 ? `已调整：${changes.join('；')}\n\n` : '';
			return textResult(prefix + formatView(out ?? {}));
		}),
	);

	// ------------------------------------------------------------------ eval

	server.registerTool(
		'eval',
		{
			title: '执行 GeoGebra 命令',
			description:
				'主力工具：像在输入栏一样执行 GeoGebra 命令（命令名必须英文）。engine=geogebra 时会新建/修改对象并返回新建对象清单与是否成功；engine=cas 时把表达式交给 CAS 求符号结果，结果文本返回、结果行成为构造里的对象。语法用 help commands / help cas。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					command: z
						.string()
						.describe('命令文本，一行一条；geogebra 引擎下可用 \\n 一次传多条。例：A=(1,2)　f(x)=x^2　Circle(A,2)　SetColor(f,255,0,0)'),
					engine: z.enum(['geogebra', 'cas']).optional().describe('默认 geogebra；cas 走符号计算，返回结果字符串'),
				}),
			),
		},
		canvasTool(async ({ command, engine = 'geogebra' }, call) => {
			const text = String(command ?? '');
			if (text.trim().length === 0) throw new BridgeError('命令不能为空。');
			if (engine === 'cas') {
				const out = await call('evalCAS', { command: text }, { timeoutMs: TIMEOUT.eval });
				const result = String(out?.result ?? '').trim();
				const created = Array.isArray(out?.created) ? out.created : [];
				const lines = [`CAS 结果：\n${result.length > 0 ? result : '(空结果)'}`];
				if (created.length > 0) {
					lines.push(`（CAS 顺手往构造里加了对象：${created.join('、')}，它会被 state 一起保存。）`);
				}
				return textResult(lines.join('\n'));
			}
			const out = await call('eval', { command: text }, { timeoutMs: TIMEOUT.eval });
			return textResult(formatEval(text, out));
		}),
	);

	// ------------------------------------------------------------------- set

	server.registerTool(
		'set',
		{
			title: '设置对象属性',
			description:
				'按属性名精确设置一个对象的样式或数值，比手写命令少出错。property 决定要带哪些参数：visible/fixed/trace/auxiliary/labelVisible/animating 用 flag；color 用 red/green/blue；value/filling/animationSpeed 用 value；coords 用 x[,y[,z]]；caption/displayStyle 用 text；layer/lineStyle/lineThickness/pointStyle/pointSize/labelStyle 用 level。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					object: z.string().describe('对象名'),
					property: z
						.enum([
							'visible',
							'color',
							'value',
							'coords',
							'caption',
							'labelVisible',
							'labelStyle',
							'fixed',
							'layer',
							'lineStyle',
							'lineThickness',
							'pointStyle',
							'pointSize',
							'filling',
							'trace',
							'auxiliary',
							'displayStyle',
							'animating',
							'animationSpeed',
						])
						.describe('要改的属性'),
					flag: z.boolean().optional().describe('布尔属性用'),
					value: z.number().optional().describe('数值属性用'),
					x: z.number().optional().describe('coords 的 x'),
					y: z.number().optional().describe('coords 的 y'),
					z: z.number().optional().describe('coords 的 z（3D 点）'),
					red: z.number().optional().describe('color 的 R，0–255'),
					green: z.number().optional().describe('color 的 G，0–255'),
					blue: z.number().optional().describe('color 的 B，0–255'),
					text: z.string().optional().describe('caption/displayStyle 用'),
					level: z.number().optional().describe('样式编号类属性用（整数）'),
				}),
			),
		},
		canvasTool(async (args, call) => {
			const name = String(args.object ?? '').trim();
			if (!name) throw new BridgeError('对象名不能为空。');
			const need = (condition, message) => {
				if (!condition) throw new BridgeError(message);
			};
			let method;
			let params;
			switch (args.property) {
				case 'visible':
					need(typeof args.flag === 'boolean', 'visible 需要 flag: true/false。');
					method = 'setVisible';
					params = [name, args.flag];
					break;
				case 'color':
					need(
						[args.red, args.green, args.blue].every((value) => Number.isFinite(value)),
						'color 需要 red / green / blue 三个 0–255 的整数。',
					);
					method = 'setColor';
					params = [name, Math.trunc(args.red), Math.trunc(args.green), Math.trunc(args.blue)];
					break;
				case 'value':
					need(Number.isFinite(args.value), 'value 需要 value（数字）。');
					method = 'setValue';
					params = [name, args.value];
					break;
				case 'coords':
					need(Number.isFinite(args.x) && Number.isFinite(args.y), 'coords 至少需要 x 和 y。');
					method = 'setCoords';
					params = Number.isFinite(args.z) ? [name, args.x, args.y, args.z] : [name, args.x, args.y];
					break;
				case 'caption':
					need(typeof args.text === 'string', 'caption 需要 text。');
					method = 'setCaption';
					params = [name, args.text];
					break;
				case 'displayStyle':
					need(typeof args.text === 'string', 'displayStyle 需要 text：parametric / explicit / implicit / specific。');
					method = 'setDisplayStyle';
					params = [name, args.text];
					break;
				case 'labelVisible':
					need(typeof args.flag === 'boolean', 'labelVisible 需要 flag。');
					method = 'setLabelVisible';
					params = [name, args.flag];
					break;
				case 'fixed':
					need(typeof args.flag === 'boolean', 'fixed 需要 flag。');
					method = 'setFixed';
					params = [name, args.flag, false];
					break;
				case 'trace':
					need(typeof args.flag === 'boolean', 'trace 需要 flag。');
					method = 'setTrace';
					params = [name, args.flag];
					break;
				case 'auxiliary':
					need(typeof args.flag === 'boolean', 'auxiliary 需要 flag。');
					method = 'setAuxiliary';
					params = [name, args.flag];
					break;
				case 'animating':
					need(typeof args.flag === 'boolean', 'animating 需要 flag。');
					method = 'setAnimating';
					params = [name, args.flag];
					break;
				case 'animationSpeed':
					need(Number.isFinite(args.value), 'animationSpeed 需要 value。');
					method = 'setAnimationSpeed';
					params = [name, args.value];
					break;
				case 'filling':
					need(Number.isFinite(args.value), 'filling 需要 value（0–1）。');
					method = 'setFilling';
					params = [name, args.value];
					break;
				case 'layer':
				case 'labelStyle':
				case 'lineStyle':
				case 'lineThickness':
				case 'pointStyle':
				case 'pointSize':
					need(Number.isFinite(args.level), `${args.property} 需要 level（整数）。`);
					method = {
						layer: 'setLayer',
						labelStyle: 'setLabelStyle',
						lineStyle: 'setLineStyle',
						lineThickness: 'setLineThickness',
						pointStyle: 'setPointStyle',
						pointSize: 'setPointSize',
					}[args.property];
					params = [name, Math.trunc(args.level)];
					break;
				default:
					throw new BridgeError(`不支持的属性 ${args.property}。`);
			}
			await call('invoke', { method, args: params }, { timeoutMs: TIMEOUT.read });
			return textResult(`${name}：${args.property} 已设置（${method}(${params.join(', ')})）。`);
		}),
	);

	// ------------------------------------------------------------------ edit

	server.registerTool(
		'edit',
		{
			title: '构造编辑：删除/改名/清空/撤销/重做',
			description:
				'delete 删一个对象；rename 改名；clear 清空整个构造（不可撤销，先确认）；undo / redo 撤销重做一步；showall 调整视野放下所有对象。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					action: z.enum(['delete', 'rename', 'clear', 'undo', 'redo', 'showall']).describe('要做的编辑动作'),
					object: z.string().optional().describe('delete / rename 要操作的对象名'),
					newName: z.string().optional().describe('rename 的新名字'),
				}),
			),
		},
		canvasTool(async ({ action, object, newName }, call) => {
			const name = String(object ?? '').trim();
			if (action === 'delete' || action === 'rename') {
				if (!name) throw new BridgeError(`${action} 需要 object（对象名）。`);
			}
			if (action === 'rename' && !String(newName ?? '').trim()) throw new BridgeError('rename 需要 newName。');
			switch (action) {
				case 'delete': {
					const out = await call('eval', { command: `Delete(${name})` }, { timeoutMs: TIMEOUT.eval });
					if (out?.ok === false) throw new BridgeError(`删除 ${name} 没成功：对象可能不存在。先用 objects 看清单。`);
					return textResult(`已删除 ${name}。${typeof out?.objectCount === 'number' ? `构造现有 ${out.objectCount} 个对象。` : ''}`);
				}
				case 'rename': {
					const target = String(newName).trim();
					const out = await call('invoke', { method: 'renameObject', args: [name, target] }, { timeoutMs: TIMEOUT.read });
					if (out?.result !== true) {
						throw new BridgeError(`改名失败：${target} 可能已被占用，或 ${name} 不允许改名。`);
					}
					return textResult(`已把 ${name} 改名为 ${target}。`);
				}
				case 'clear': {
					await call('invoke', { method: 'newConstruction', args: [] }, { timeoutMs: TIMEOUT.read });
					return textResult('已清空构造。');
				}
				case 'undo': {
					await call('invoke', { method: 'undo', args: [] }, { timeoutMs: TIMEOUT.read });
					return textResult('已撤销一步。');
				}
				case 'redo': {
					await call('invoke', { method: 'redo', args: [] }, { timeoutMs: TIMEOUT.read });
					return textResult('已重做一步。');
				}
				case 'showall': {
					await call('invoke', { method: 'showAllObjects', args: [] }, { timeoutMs: TIMEOUT.read });
					return textResult('已调整视野放下所有对象。');
				}
				default:
					throw new BridgeError(`不支持的 action ${action}。`);
			}
		}),
	);

	// ----------------------------------------------------------------- state

	server.registerTool(
		'state',
		{
			title: '整份构造的存取',
			description:
				'get 取整份构造（format=xml 只含构造文本、base64 是完整 .ggb、json 含图片）；set 用同样的 format 灌回去（会先清空当前构造）；save 直接写成本机文件；load 从本机文件读回来。构造大时用 save/load，别把 base64 塞进对话。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					action: z.enum(['get', 'set', 'save', 'load']).describe('要做的操作'),
					format: z.enum(['xml', 'base64', 'json']).optional().describe('数据格式，默认 base64；load 时省略则按扩展名判断（.ggb→base64，.xml/.ggb.xml→xml）'),
					path: z.string().optional().describe('save / load 的本机文件路径'),
					data: z.string().optional().describe('set 时要灌入的文本（xml / base64 / json）'),
				}),
			),
		},
		canvasTool(async ({ action, path: filePath, data, format }, call) => {
			if (action === 'get') {
				const out = await call('getState', { format: format ?? 'base64' }, { timeoutMs: TIMEOUT.state });
				const text = String(out?.data ?? '');
				return textResult(
					`构造状态（${out?.format ?? format ?? 'base64'}，${Buffer.byteLength(text, 'utf8')} 字节）：\n\n${text}`,
				);
			}
			if (action === 'set') {
				if (typeof data !== 'string' || data.length === 0) throw new BridgeError('set 需要 data（要灌入的文本）。');
				await call('setState', { format: format ?? 'base64', data }, { timeoutMs: TIMEOUT.state });
				return textResult(`已用 ${format ?? 'base64'} 数据替换当前构造（先清空后重建）。`);
			}
			if (action === 'save') {
				if (!filePath) throw new BridgeError('save 需要 path。');
				const chosen = format ?? (filePath.endsWith('.ggb') ? 'base64' : filePath.endsWith('.xml') ? 'xml' : 'base64');
				const out = await call('getState', { format: chosen }, { timeoutMs: TIMEOUT.state });
				const text = String(out?.data ?? '');
				const target = path.resolve(filePath);
				if (chosen === 'base64') {
					await writeFile(target, Buffer.from(text, 'base64'));
				} else {
					await writeFile(target, text, 'utf8');
				}
				const bytes = chosen === 'base64' ? Buffer.from(text, 'base64').length : Buffer.byteLength(text, 'utf8');
				return textResult(`已保存到 ${target}（${chosen}，${bytes} 字节）。`);
			}
			if (action === 'load') {
				if (!filePath) throw new BridgeError('load 需要 path。');
				const target = path.resolve(filePath);
				const buffer = await readFile(target).catch((error) => {
					throw new BridgeError(`读不到 ${target}：${error?.message ?? error}`);
				});
				const chosen = format ?? (target.endsWith('.ggb') ? 'base64' : 'xml');
				const payload = chosen === 'base64' ? buffer.toString('base64') : buffer.toString('utf8');
				await call('setState', { format: chosen, data: payload }, { timeoutMs: TIMEOUT.state });
				return textResult(`已从 ${target} 载入（${chosen}，${buffer.length} 字节），当前构造被替换。`);
			}
			throw new BridgeError(`不支持的 action ${action}。`);
		}),
	);

	// ---------------------------------------------------------------- export

	server.registerTool(
		'export',
		{
			title: '导出 PNG / SVG / PDF',
			description:
				'把图形区导出成文件或直接返回内容。format=png 时给了 path 就写文件、否则作为图片返回；svg 返回矢量文本（path 可写文件）；pdf 必须给 path。scale 是倍率，transparent 只对 png 有效。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('画布 id（canvas_create 返回的那个）'),
					format: z.enum(['png', 'svg', 'pdf']).describe('导出格式'),
					path: z.string().optional().describe('写到本机这个路径；pdf 必给，png/svg 省略则直接返回内容'),
					scale: z.number().optional().describe('倍率，默认 1（pdf 也是）'),
					transparent: z.boolean().optional().describe('png 是否透明背景，默认 false'),
					view: z
						.enum(['graphics', 'applet'])
						.optional()
						.describe('png 导哪一块：graphics（默认）只要图形区，适合当插图；applet 整窗（含 3D 面板）'),
				}),
			),
			annotations: readOnly,
		},
		canvasTool(async ({ format, path: filePath, scale, transparent, view = 'graphics' }, call) => {
			const factor = Number.isFinite(scale) ? scale : 1;
			if (format === 'pdf' && !filePath) throw new BridgeError('pdf 导出要给出 path（base64 塞进对话没有意义）。');
			if (format === 'png') {
				const whole = view === 'applet';
				const out = whole
					? await call('screenshotApplet', { scale: factor }, { timeoutMs: TIMEOUT.export })
					: await call('exportPNG', { scale: factor, transparent: transparent === true }, { timeoutMs: TIMEOUT.export });
				const base64 = String(out?.base64 ?? '');
				if (!base64) throw new BridgeError('GeoGebra 没有返回 PNG。');
				const label = whole ? '整个 applet 窗口（含全部可见面板）' : '图形区';
				if (filePath) {
					const target = path.resolve(filePath);
					const buffer = Buffer.from(base64, 'base64');
					await writeFile(target, buffer);
					const size = pngSize(buffer);
					return textResult(`PNG 已保存到 ${target}（${label}，${buffer.length} 字节${size ? `，${size.width}×${size.height}` : ''}）。`);
				}
				return imageResult(base64, `PNG（${label}）`);
			}
			if (format === 'svg') {
				const out = await call('exportSVG', {}, { timeoutMs: TIMEOUT.export });
				const svg = out?.svg;
				if (svg === null || svg === undefined) throw new BridgeError('当前视图不支持导出 SVG（3D 视图导出为 null）；改用 png 或 pdf。');
				if (filePath) {
					const target = path.resolve(filePath);
					await writeFile(target, String(svg), 'utf8');
					return textResult(`SVG 已保存到 ${target}（${Buffer.byteLength(String(svg), 'utf8')} 字节）。`);
				}
				return textResult(`SVG（${Buffer.byteLength(String(svg), 'utf8')} 字节）：\n\n${String(svg)}`);
			}
			const out = await call('exportPDF', { scale: factor }, { timeoutMs: TIMEOUT.export });
			const base64 = String(out?.base64 ?? '');
			if (!base64) throw new BridgeError('GeoGebra 没有返回 PDF。');
			const target = path.resolve(filePath);
			const buffer = Buffer.from(base64, 'base64');
			await writeFile(target, buffer);
			return textResult(`PDF 已保存到 ${target}（${buffer.length} 字节）。`);
		}),
	);

	// --------------------------------------------------------- canvas_create

	server.registerTool(
		'canvas_create',
		{
			title: '新建画布（返回 id）',
			description:
				'建一个空白画布并返回 id，之后所有操作都要带这个 id。app 决定界面（页面加载时定死，之后改不了），按顺序选、命中就停：①要画 3D/立体（空间点、曲面、立体几何）→ 3d；②不需要坐标网格的几何问题（作图、证明、尺规、角度、圆）→ geometry；③只用 suite 就能完成（函数、数列、统计、表格、符号计算）→ suite；④其它 → classic。3d 需要浏览器有可用的 WebGL。\n选错 app 只能 canvas_release 后重建，所以建画布前先把 app 定下来，不要建了再改。\n默认流程：会先在用户网页界面上弹一个确认框，把画布地址（蓝色可点）给用户；用户打开地址、页面连上之后再点「已打开」，这个调用才会返回。所以这个工具可能等上几十秒到几分钟，属于正常现象——在它返回之前不要重复建画布。\n用户点了「跳过」、或没人能点确认（没有图形界面 / 客户端界面插件不在）时会立刻走老路径：本进程自己能拉起浏览器就拉起，拉不起就把地址给用户自己打开。headless:true 或 confirm:false 跳过确认框。用完记得 canvas_release。',
			inputSchema: inputSchema(
				z.object({
					app: z
						.enum(['classic', '3d', 'suite', 'geometry'])
						.optional()
						.describe(
							'界面，默认 classic。按顺序选、命中就停：①要画 3D/立体 → 3d；②不需要坐标网格的几何问题 → geometry（它的网格与坐标轴默认关闭）；③只用 suite 就能完成（函数/数列/统计/表格/符号计算）→ suite；④其它 → classic',
						),
					headless: z.boolean().optional().describe('用无界面浏览器打开（没有窗口，只适合自动化验证）；等于同时关掉确认框'),
					browser: z.string().optional().describe('浏览器命令行，可带参数，例如 "firefox --new-window"；默认依次试 firefox、xdg-open'),
					confirm: z.boolean().optional().describe('是否弹确认框等用户点「已打开」，默认 true；headless:true 时自动为 false'),
					confirmTimeoutMs: z.number().optional().describe('等用户确认的上限毫秒数，默认 300000（5 分钟）'),
				}),
			),
		},
		tool(async ({ app, headless, browser, confirm, confirmTimeoutMs }) => {
			const canvas = hub.createCanvas({ app: app ?? 'classic' });
			const target = hub.canvasUrl(canvas.id, canvas.app);
			const lines = [`画布 ${canvas.id} 已建好（${canvas.app} 界面）。`, `地址：${target}`];

			// 默认先在用户界面上弹确认框：用户点开地址、页面连上，再点「已打开」。
			const wantsConfirm = confirm !== false && headless !== true;
			if (wantsConfirm) {
				const timeoutMs = Number.isFinite(confirmTimeoutMs)
					? Math.min(Math.max(confirmTimeoutMs, 5_000), 1_800_000)
					: openRequests.timeoutMs;
				const item = openRequests.create({ canvasId: canvas.id, url: target, app: canvas.app });
				const outcome = await openRequests.wait(item, { timeoutMs });
				if (outcome.reason === 'confirmed') {
					const page = hub.pageInfo(canvas.id);
					lines.push('用户已在网页界面的确认框里点过「已打开」。');
					lines.push(
						page
							? `页面已连上（GeoGebra ${page.version ?? '?'}，对象 ${page.objectCount ?? '?'}）。`
							: '页面还没连上来（用户可能刚点开、GeoGebra 还在加载）。先用 status 看连接状态，不要重复建画布。',
					);
					lines.push(`之后所有操作都带 id="${canvas.id}"。`);
					return textResult(lines.join('\n'));
				}
				if (outcome.reason === 'skipped') {
					lines.push('用户在确认框里选了「跳过」：没有等页面连上就继续了。');
					lines.push('要用这个画布请自己打开上面的地址；页面一连上就能用，连接状态用 status 查看。');
					lines.push(`之后所有操作都带 id="${canvas.id}"。`);
					return textResult(lines.join('\n'));
				}
				if (outcome.reason === 'gone') {
					lines.push('这个画布在确认之前已经被释放了（canvas_release），请求作废。');
					return textResult(lines.join('\n'));
				}
				if (outcome.reason === 'timeout') {
					lines.push(`等用户在确认框里点「已打开」，超过 ${Math.round(timeoutMs / 1000)} 秒没有回应。`);
					lines.push('画布已经建好了：继续做后面的事即可，需要页面时先 status 看连接状态，不要重复建画布。');
					lines.push(`之后所有操作都带 id="${canvas.id}"。`);
					return textResult(lines.join('\n'));
				}
				// reason === 'no-ui'：没有人能点确认，退回老路径（自己拉起浏览器 / 把地址交给用户）。
			}

			lines.push(...(await openLocally(hub, canvas, target, { headless, browser })));
			return textResult(lines.join('\n'));
		}),
	);

	// -------------------------------------------------------- canvas_release

	server.registerTool(
		'canvas_release',
		{
			title: '释放画布（回收 id）',
			description:
				'释放一个画布：让页面里的 GeoGebra applet 自我拆除（真正回收内核内存）并断开通道，桥这边删掉这个 id。之后再用这个 id 会报「没有这个画布」。不再需要某个画布时调用它；浏览器标签页本身要用户自己关。',
			inputSchema: inputSchema(
				z.object({
					id: z.string().describe('要释放的画布 id'),
				}),
			),
		},
		tool(async ({ id }) => {
			// 还有确认框在等这个画布的话，先作废，别让 canvas_create 一直等下去。
			openRequests.dropCanvas(id);
			const out = await hub.releaseCanvas(id);
			const lines = [`画布 ${out.id} 已释放，记录已删除。`];
			if (out.pageTold) lines.push('页面里的 applet 已拆除、通道已断开（那个标签页可以自己关掉了）。');
			else if (out.pageError) lines.push(`没能让页面自己拆除（${out.pageError}）；记录已删除，那个页面会自行断开。`);
			else lines.push('这个画布当时没有页面连着，只删了记录。');
			return textResult(lines.join('\n'));
		}),
	);

	return server;
}

/**
 * 启动一个进程并等它「稳住」：
 *   - spawn 直接失败（命令不存在）→ 抛错；
 *   - 进程很快退出 → 返回 {exited:true, code, signal}（浏览器把 URL 交给已有实例
 *     时就是这样退出的，所以退出本身不算失败）；
 *   - 900ms 还活着 → 返回 {exited:false} 并 unref，让它自己跑。
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{exited: boolean, code?: number|null, signal?: string|null}>}
 */
function launch(command, args) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, { detached: true, stdio: 'ignore' });
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.unref();
			resolve({ exited: false });
		}, 900);
		timer.unref?.();
		child.once('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', (code, signal) => finish({ exited: true, code: code ?? null, signal: signal ?? null }));
	});
}

/**
 * 老路径：直接在本机拉起浏览器，并用「页面有没有真的连上来」判定成败。
 *
 * 只有在没人能点确认框时才会走到这里：非 DSH 的 MCP 客户端、网页界面插件不在、
 * headless，或调用方明确不要确认。
 *
 * @param {ClientHub} hub
 * @param {{id: string, app: string}} canvas
 * @param {string} target 画布地址
 * @param {{headless?: boolean, browser?: string}} options
 * @returns {Promise<string[]>} 追加到工具返回值里的行
 */
async function openLocally(hub, canvas, target, options = {}) {
	const lines = [];

	// 无图形环境时 spawn 不会报错（进程只是立刻退出），所以先直接判断并说清楚。
	const neverShowsWindow = options.headless !== true && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
	if (neverShowsWindow) {
		lines.push('本进程没有图形环境（DISPLAY / WAYLAND_DISPLAY 都没设），弹不出浏览器窗口：请自己打开上面的地址。');
		return lines;
	}

	const candidates = options.browser ? [options.browser.trim()] : ['firefox', 'xdg-open'];
	const errors = [];
	for (const spec of candidates) {
		const [command, ...preArgs] = spec.split(/\s+/).filter(Boolean);
		if (!command) continue;
		const launchedAt = Date.now();
		try {
			const outcome = await launch(command, [...preArgs, target]);
			const page = await waitForCanvas(hub, canvas.id, launchedAt);
			if (page) {
				lines.push(`已用 ${spec} 打开，页面已连上（GeoGebra ${page.info?.version ?? '?'}，对象 ${page.info?.objectCount ?? '?'}）。`);
				lines.push(`之后所有操作都带 id="${canvas.id}"。`);
				return lines;
			}
			errors.push(
				`${spec}: 命令起来了，但 ${PAGE_WAIT_MS / 1000} 秒内没有页面连上来${outcome?.exited ? `（进程已退出，code=${outcome.code}）` : ''}`,
			);
		} catch (error) {
			errors.push(`${spec}: ${error?.message ?? error}`);
		}
	}
	lines.push(`没能自动打开（${errors.join('；')}）：请自己打开上面的地址。`);
	lines.push(`画布 ${canvas.id} 已经建好了，页面一连上就能用。`);
	return lines;
}

/** 服务端 instructions：随 initialize 返回。 */
const instructionsFor = (viewerUrl) => `本桥把浏览器里的 GeoGebra（离线包 5.4.932.1）交给模型，查看器地址 ${viewerUrl()}。

一个「画布」= 一个浏览器里跑着的 GeoGebra 页面，用短 id 指代（c1、c2…）。流程：
1. canvas_create 建空白画布并拿到 id。app 在页面加载时定死，按顺序选、命中就停：
   ①要画 3D/立体 → 3d；②不需要坐标网格的几何问题 → geometry；③只用 suite 就能完成 → suite；④其它 → classic。
   选错只能释放后重建，所以先定 app 再建画布；3d 需要浏览器有可用的 WebGL。
   这一步默认会在用户的网页界面上弹确认框，等用户打开地址并点「已打开」才返回；慢是正常的，不要因为没返回就重复建画布。
2. 之后每个操作都要带这个 id：objects / object / events / screenshot / view / eval / set / edit / state / export；
3. 不再需要时 canvas_release 释放它（页面里的 applet 会真正拆除）。
status 列出所有画布的 id、界面、地址与连接状态。

1. 先看再动：动手前用 objects / view 了解现状，动完用它俩或 screenshot 对账。
2. eval 里命令名必须英文。GeoGebra 不返回错误文本，所以 eval 用「构造/视图有没有变化」判断成败。
3. 自动命名会撞车：Segment(A,B) 可能自动叫 f，之后再写 f(x)=x^2 就把那条线段改掉了；给对象显式命名。
4. 用户可能在画布上自己动手：读 events 才知道他拖了哪个滑块、点了哪个对象。
5. 一次只做一个动作，别把一串互不相关的命令堆在一次 eval 里。
6. 3D 视图与 3D 计算器都需要浏览器有可用的 WebGL；没有时 3D 面板一片空白，view 会报出来。
7. 服务异常、画布没连上时先跑 status。`;

/** 等指定画布在 launchedAt 之后连上页面——这才是 canvas_create 成功与否的真实判据。 */
async function waitForCanvas(hub, canvasId, launchedAt) {
	const deadline = Date.now() + PAGE_WAIT_MS;
	for (;;) {
		const canvas = hub.snapshot().find((entry) => entry.id === canvasId);
		if (canvas?.connected && Number(canvas.lastSeenAt ?? 0) >= launchedAt) return canvas;
		if (Date.now() > deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

export async function start(options = {}) {
	const ggbRoot = path.resolve(options.ggbRoot ?? process.env.GGB_ROOT ?? DEFAULT_GGB_ROOT);
	const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
	const log = (line) => process.stderr.write(`${line}\n`);

	// hub 要先建：HTTP 服务的 /events、/rpc 都挂在它上面。查看器地址在监听
	// 成功之前还不知道，所以用一个可变变量 + getter 传给 hub。
	let viewerUrl = '';
	const hub = new ClientHub({
		callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
		viewerUrl: () => viewerUrl,
	});

	// 「等用户确认已打开」的登记表：HTTP 的 /api/pending 与 canvas_create 共用同一个实例。
	const openRequests = new OpenRequests({
		timeoutMs: Number(options.confirmTimeoutMs ?? process.env.GGB_CONFIRM_TIMEOUT_MS ?? DEFAULT_CONFIRM_TIMEOUT_MS),
	});

	let http = null;
	let httpError = null;
	try {
		http = await startHttpServer({
			hub,
			openRequests,
			ggbRoot,
			webDir,
			host: options.host ?? process.env.GGB_BRIDGE_HOST ?? DEFAULT_HOST,
			port: Number(options.port ?? process.env.GGB_BRIDGE_PORT ?? DEFAULT_PORT),
			log,
		});
		viewerUrl = http.url;
	} catch (error) {
		httpError = error;
		log(`[geogebra-bridge] HTTP 查看器启动失败：${error?.message ?? error}`);
	}

	const sessions = serveStdio(
		() =>
			createServer({
				hub,
				openRequests,
				viewerUrl: () => viewerUrl,
				ggbRoot: http?.ggbRoot ?? ggbRoot,
				ggbRootOk: http?.ggbRootOk,
			}),
		{ onerror: (error) => log(`[geogebra-bridge] ${error?.stack ?? error}`) },
	);

	let closing = false;
	/**
	 * MCP 客户端断开（stdin EOF/close）或收到信号时自己退出。
	 *
	 * 这不是可选项：HTTP 服务的监听 socket 会把事件循环撑住，进程不会因为
	 * stdin 关闭而自然结束。DSH 卸载 preset 时如果不杀子进程，就会留下一个
	 * 仍占着查看器端口的孤儿，把下一个实例挤到别的端口上，而用户浏览器里那个
	 * 页面还连着没人管的旧进程。所以通道一断就必须退出并释放端口。
	 *
	 * @param {string} reason
	 */
	const shutdown = (reason) => {
		if (closing) return;
		closing = true;
		log(`[geogebra-bridge] ${reason}，退出并释放 ${viewerUrl || '端口'}`);
		const done = () => process.exit(0);
		// 兜底：万一 close 卡住，500ms 后照样退出。
		const timer = setTimeout(done, 500);
		timer.unref?.();
		Promise.resolve(sessions?.close?.())
			.catch(() => {})
			.then(() => http?.close?.())
			.catch(() => {})
			.finally(done);
	};

	process.stdin.on('end', () => shutdown('MCP 客户端关闭了 stdin'));
	process.stdin.on('close', () => shutdown('stdin 已关闭'));
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		process.on(signal, () => shutdown(`收到 ${signal}`));
	}

	return {
		http,
		httpError,
		hub,
		sessions,
		close: async () => {
			await http?.close();
		},
	};
}
