#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * geogebra-mcp-bridge 的命令行入口。
 *
 * 只用 Node 内置模块解析参数，然后把 stdin/stdout 交给 MCP stdio 服务，
 * 同时起查看器 HTTP 服务。`--help` / `--version` 在本地回答，不启动任何服务。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const USAGE = `geogebra-mcp-bridge ${pkg.version} — 用 MCP over stdio 操作浏览器里的 GeoGebra

用法
  geogebra-mcp-bridge [选项]

选项
  --ggb-root <目录>   GeoGebra 离线包目录（含 GeoGebra/deployggb.js），
                      默认与本仓库同级的 geogebra-math-apps-bundle/
  --port <端口>       查看器 HTTP 端口，默认 3460；被占用时向后顺延
  --host <地址>       监听地址，默认 127.0.0.1（只监听回环）
  -h, --help          显示本说明
  -V, --version       显示版本

环境变量
  GGB_ROOT            同 --ggb-root
  GGB_BRIDGE_PORT     同 --port
  GGB_BRIDGE_HOST     同 --host

说明
  本程序不跑 GeoGebra 内核：它托管一个查看器页面，页面里加载离线 GeoGebra
  并通过 SSE 连回来，页面上的 ggbApplet API 就是全部可操作能力。
  启动后在浏览器打开打印出来的查看器地址（或用 open 工具拉起），页面加载完
  即可用 mcp__geogebra__* 工具。stdin/stdout 是 MCP 协议通道，日志走 stderr。
`;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{help?: true, version?: true, port?: string, host?: string, ggbRoot?: string, error?: string}}
 */
function parseArgv(argv) {
	const result = {};
	const takeValue = (arg, index, name) => {
		const value = argv[index + 1];
		if (value === undefined) return { error: `${name} 后面要跟一个值` };
		return { value };
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '-h' || arg === '--help') return { help: true };
		if (arg === '-V' || arg === '--version') return { version: true };
		if (arg === '--port' || arg === '--host' || arg === '--ggb-root') {
			const taken = takeValue(arg, index, arg);
			if (taken.error) return taken;
			const key = { '--port': 'port', '--host': 'host', '--ggb-root': 'ggbRoot' }[arg];
			result[key] = taken.value;
			index += 1;
			continue;
		}
		const match = /^--(port|host|ggb-root)=(.*)$/.exec(arg);
		if (match) {
			const key = { port: 'port', host: 'host', 'ggb-root': 'ggbRoot' }[match[1]];
			result[key] = match[2];
			continue;
		}
		return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
	}
	return result;
}

const parsed = parseArgv(process.argv.slice(2));

if (parsed.error !== undefined) {
	process.stderr.write(`geogebra-mcp-bridge: ${parsed.error}\n\n${USAGE}`);
	process.exit(2);
}
if (parsed.help === true) {
	process.stdout.write(USAGE);
	process.exit(0);
}
if (parsed.version === true) {
	process.stdout.write(`${pkg.version}\n`);
	process.exit(0);
}

const { start, DEFAULT_PORT, DEFAULT_GGB_ROOT, DEFAULT_HOST } = await import('../src/server.mjs');

await start({
	host: parsed.host ?? process.env.GGB_BRIDGE_HOST ?? DEFAULT_HOST,
	port: Number(parsed.port ?? process.env.GGB_BRIDGE_PORT ?? DEFAULT_PORT),
	ggbRoot: parsed.ggbRoot ?? process.env.GGB_ROOT ?? DEFAULT_GGB_ROOT,
});
