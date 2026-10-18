// SPDX-License-Identifier: GPL-3.0-only
/**
 * 桥的身份常量。
 *
 * 单独一个模块是为了让 MCP 侧（server.mjs）与 HTTP 侧（http.mjs）共用同一份
 * 名字与协议号，而不必互相 import（那会形成循环）。宿主侧的界面插件用
 * `/api/status`、`/api/pending` 里的 `name` 认出「这是 GeoGebra 桥」，
 * 用 `protocol` 认出「这个桥带用户确认功能」。
 */

/** MCP 服务端身份，出现在 initialize 结果与 HTTP 自检里。 */
export const SERVER_INFO = Object.freeze({
	name: 'geogebra-math-bridge',
	title: 'GeoGebra 数学绘图桥',
	version: '0.1.0',
});

/**
 * 「等用户确认已打开画布」的协议号。
 *
 * 1 = 没有这个功能（更早的桥）；2 = 提供 `/api/pending` 与 `/api/pending/confirm`。
 * 界面插件只认 protocol ≥ 2 的桥，这样即使机器上还留着旧桥进程（占着更小的
 * 端口），也不会把弹窗接到一个永远不会有人回应的登记表上。
 */
export const PENDING_PROTOCOL = 2;
