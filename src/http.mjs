// SPDX-License-Identifier: GPL-3.0-only
/**
 * 桥的 HTTP 服务：一个端口上同时提供四样东西。
 *
 *   GET  /                     查看器页面（本包 web/index.html）
 *   GET  /client.js            页面侧的桥接脚本
 *   GET  /GeoGebra/**          GeoGebra 离线包（默认 ../geogebra-math-apps-bundle）
 *   GET  /events?clientId=…    SSE 下行通道，页面在这里收命令
 *   POST /hello                页面自报身份
 *   POST /rpc                  页面回投命令结果
 *   GET  /api/status           纯 HTTP 自检（curl 也能看）
 *   GET  /api/pending          有人在等用户确认「已打开画布」时列出它们（界面轮询这个）
 *   POST /api/pending/confirm  用户在弹窗里的选择（opened / skip）
 *
 * 只监听回环地址。静态资源严格限制在 GeoGebra 离线包目录内。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { PENDING_PROTOCOL, SERVER_INFO } from './identity.mjs';

/** 静态资源的 Content-Type；GeoGebra 离线包里的扩展名基本都在这里。 */
const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.properties': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.pdf': 'application/pdf',
	'.wasm': 'application/wasm',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.zip': 'application/zip',
	'.ggb': 'application/octet-stream',
	'.jar': 'application/java-archive',
	'.csv': 'text/csv; charset=utf-8',
};

/** 请求体上限：一整个构造的 base64 可能很大，但 128MB 足够且防止打爆内存。 */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const contentTypeFor = (filePath) => MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

/**
 * 把 URL 路径解析到静态根目录下的绝对路径；越界（`..`、绝对路径）返回 null。
 *
 * @param {string} root 已 resolve 的静态根
 * @param {string} urlPath
 * @returns {string|null}
 */
function resolveWithin(root, urlPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(urlPath);
	} catch {
		return null;
	}
	const full = path.resolve(root, `.${path.posix.normalize(decoded.split('?')[0])}`);
	if (full === root) return full;
	return full.startsWith(root + path.sep) ? full : null;
}

/** 读 JSON 请求体；空体返回 {}；超限或不是 JSON 抛错。 */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > MAX_BODY_BYTES) throw new Error('请求体过大');
		chunks.push(chunk);
	}
	if (total === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 起 HTTP 服务。端口被占用时在 `[port, port+attempts)` 里顺延，
 * 真正监听到的地址由返回值给出（hub 的错误提示要用它）。
 *
 * @param {{hub: import('./hub.mjs').ClientHub, openRequests?: import('./open-requests.mjs').OpenRequests, ggbRoot: string, webDir: string, host?: string, port?: number, attempts?: number, log?: (line: string) => void}} options
 * @returns {Promise<{url: string, port: number, ggbRoot: string, close: () => Promise<void>}>}
 */
export async function startHttpServer(options) {
	const { hub, openRequests, ggbRoot, webDir } = options;
	const host = options.host ?? '127.0.0.1';
	const basePort = Number(options.port ?? 3460);
	const attempts = Number(options.attempts ?? 20);
	const log = options.log ?? (() => {});
	const root = path.resolve(ggbRoot);
	/** 进程内起点；宿主侧界面用它挑「最新的那个桥」。 */
	const startedAt = Date.now();

	/** 离线包目录是否可用；status 会把它报出来。 */
	let ggbRootOk = false;
	try {
		ggbRootOk = (await stat(path.join(root, 'GeoGebra', 'deployggb.js'))).isFile();
	} catch {
		ggbRootOk = false;
	}

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
			res.end(`桥内部错误：${error?.stack ?? error}`);
		});
	});

	async function handle(req, res) {
		const url = new URL(req.url ?? '/', `http://${host}`);
		const pathname = url.pathname;

		if (req.method === 'GET' && pathname === '/api/status') {
			return sendJson(res, {
				ok: true,
				// 身份与协议号：宿主侧的界面插件靠这两行认出「带确认功能的 GeoGebra 桥」。
				name: SERVER_INFO.name,
				protocol: PENDING_PROTOCOL,
				startedAt,
				pid: process.pid,
				viewerUrl: `http://${host}:${boundPort}`,
				ggbRoot: root,
				ggbRootOk,
				canvases: hub.snapshot(),
			});
		}

		// 界面轮询：有人等确认时列出请求，顺带刷新「有人在看弹窗」的时间戳。
		if (req.method === 'GET' && pathname === '/api/pending') {
			openRequests?.noteUiSeen();
			return sendJson(res, {
				ok: true,
				name: SERVER_INFO.name,
				protocol: PENDING_PROTOCOL,
				startedAt,
				pending: (openRequests?.list() ?? []).map((item) => ({
					...item,
					connected: hub.isConnected(item.canvasId),
					page: hub.pageInfo(item.canvasId),
				})),
			});
		}

		// 用户在弹窗里点了「已打开」或「跳过」。
		if (req.method === 'POST' && pathname === '/api/pending/confirm') {
			const body = await readJsonBody(req);
			if (!openRequests) {
				return sendJson(res, { ok: false, accepted: false, reason: '这个桥没有开启确认功能。' });
			}
			const outcome = openRequests.confirm(body?.id, body?.action);
			log(`[geogebra-bridge] 确认请求 ${body?.id} → ${body?.action}：${outcome.accepted ? '已受理' : outcome.reason}`);
			// 找不到请求时给 409：界面据此知道「这一条已经不用再显示了」。
			return sendJson(res, outcome, outcome.ok ? 200 : 409);
		}

		if (req.method === 'GET' && pathname === '/events') {
			const clientId = url.searchParams.get('clientId') ?? '';
			const canvasHint = url.searchParams.get('canvas') ?? '';
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
				'x-accel-buffering': 'no',
			});
			res.write('retry: 1000\n\n');
			const bound = hub.registerStream(clientId, canvasHint, res);
			log(`[geogebra-bridge] 页面连接：画布 ${bound.canvasId}（client ${bound.clientId}）`);
			const heartbeat = setInterval(() => {
				if (res.writableEnded) return;
				res.write(': ping\n\n');
			}, 15_000);
			heartbeat.unref?.();
			req.on('close', () => {
				clearInterval(heartbeat);
				hub.unregisterStream(clientId);
				log(`[geogebra-bridge] 页面断开：${clientId}`);
			});
			return undefined;
		}

		if (req.method === 'POST' && pathname === '/hello') {
			const body = await readJsonBody(req);
			const bound = hub.hello(body.clientId, body.canvas, body.info);
			return sendJson(res, { ok: true, clientId: bound.clientId, canvasId: bound.canvasId });
		}

		if (req.method === 'POST' && pathname === '/rpc') {
			const body = await readJsonBody(req);
			const outcome = hub.reply(body);
			return sendJson(res, outcome);
		}

		if (req.method === 'GET' && (pathname === '/' || pathname === '/viewer' || pathname === '/index.html')) {
			return sendFile(res, path.join(webDir, 'index.html'), { contentType: 'text/html; charset=utf-8' });
		}

		if (req.method === 'GET' && pathname === '/client.js') {
			return sendFile(res, path.join(webDir, 'client.js'), { contentType: 'text/javascript; charset=utf-8' });
		}

		if (req.method === 'GET' && pathname === '/favicon.ico') {
			res.writeHead(204).end();
			return undefined;
		}

		if (req.method === 'GET') {
			const target = resolveWithin(root, pathname);
			if (!target) return sendText(res, 403, '路径越界');
			let info = await stat(target).catch(() => null);
			if (info?.isDirectory()) {
				const index = path.join(target, 'index.html');
				if (await stat(index).catch(() => null)) {
					return sendFile(res, index, { contentType: contentTypeFor(index) });
				}
				info = null;
			}
			if (!info?.isFile()) {
				return sendText(res, 404, `没有这个资源：${pathname}\n（GeoGebra 离线资源目录：${root}）`);
			}
			return sendFile(res, target, { contentType: contentTypeFor(target) });
		}

		return sendText(res, 405, `不支持 ${req.method} ${pathname}`);
	}

	async function sendFile(res, filePath, { contentType } = {}) {
		const info = await stat(filePath).catch(() => null);
		if (!info?.isFile()) return sendText(res, 404, `没有这个文件：${filePath}`);
		res.writeHead(200, {
			'content-type': contentType ?? contentTypeFor(filePath),
			'content-length': String(info.size),
			'cache-control': 'no-cache',
		});
		const stream = createReadStream(filePath);
		stream.on('error', () => res.destroy());
		stream.pipe(res);
		return undefined;
	}

	function sendText(res, status, text) {
		res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(`${text}\n`);
	}

	function sendJson(res, value, status = 200) {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': String(Buffer.byteLength(body)),
		});
		res.end(body);
	}

	// 端口顺延：默认端口被别的程序占了就往后找，最终地址以实际监听为准。
	let boundPort = 0;
	let lastError;
	for (let candidate = basePort; candidate < basePort + attempts; candidate += 1) {
		try {
			await new Promise((resolve, reject) => {
				const onError = (error) => {
					server.off('listening', onListening);
					reject(error);
				};
				const onListening = () => {
					server.off('error', onError);
					resolve();
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(candidate, host);
			});
			boundPort = candidate;
			break;
		} catch (error) {
			lastError = error;
			if (error?.code !== 'EADDRINUSE') throw error;
		}
	}
	if (boundPort === 0) {
		throw new Error(`从 ${basePort} 起试了 ${attempts} 个端口都被占用（最后一个错误：${lastError?.message ?? lastError}）`);
	}

	const url = `http://${host}:${boundPort}/`;
	log(`[geogebra-bridge] 查看器：${url}（GeoGebra 资源：${root}${ggbRootOk ? '' : ' ⚠ 未找到 deployggb.js'}）`);

	return {
		url,
		port: boundPort,
		ggbRoot: root,
		ggbRootOk,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
