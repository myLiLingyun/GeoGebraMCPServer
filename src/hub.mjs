// SPDX-License-Identifier: GPL-3.0-only
/**
 * 画布（canvas）注册表与 RPC 中枢。
 *
 * 一个「画布」= 一个浏览器里跑着的 GeoGebra 页面，用一个短 id（`c1`、`c2`…）
 * 指代。显式句柄解决的是「同时开着好几个页面时，工具到底操作哪一个」的歧义：
 * 页面不带 canvas 参数也能用，那种会被自动分配 `auto-1` 这样的 id。
 *
 * 数据流：
 *   - `GET /events?clientId=…&canvas=…` 挂 SSE 下行通道，一个画布同时只认最后一条；
 *   - `POST /hello {clientId, canvas, info}` 页面自报身份，拿到生效的 canvasId；
 *   - `call(canvasId, method, params)` 往那个画布的通道写一条命令，
 *     页面执行完用 `POST /rpc` 按 callId 回投结果。
 *
 * 画布记录在页面断开后**保留**（用户刷新/重开还能接上），只有 release 才丢。
 */

import { BridgeError } from './errors.mjs';

/** 默认等待页面回应的时长；GeoGebra 大多数 API 是同步的，30s 已经很宽。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class ClientHub {
	/** @type {Map<string, any>} canvasId -> 画布记录 */
	#canvases = new Map();
	/** @type {Map<string, string>} clientId -> canvasId */
	#clientCanvas = new Map();
	#callSeq = 0;
	#canvasSeq = 0;
	#autoSeq = 0;
	#callTimeoutMs;
	#viewerUrl;

	/**
	 * @param {{callTimeoutMs?: number, viewerUrl?: () => string}} [options]
	 */
	constructor(options = {}) {
		this.#callTimeoutMs = Number.isFinite(options.callTimeoutMs)
			? options.callTimeoutMs
			: DEFAULT_CALL_TIMEOUT_MS;
		this.#viewerUrl = typeof options.viewerUrl === 'function' ? options.viewerUrl : () => '';
	}

	/** 查看器根地址（HTTP 服务真正监听到的地址），用于错误提示与画布地址。 */
	get viewerUrl() {
		return this.#viewerUrl();
	}

	/** 画布在浏览器里的地址；带上 canvas 与 app，打开后就会绑到这个画布上。 */
	canvasUrl(canvasId, app) {
		const base = this.viewerUrl || '';
		const query = new URLSearchParams();
		query.set('canvas', canvasId);
		if (app) query.set('app', app);
		return `${base}?${query.toString()}`;
	}

	/**
	 * 铸一个新画布。不会打开浏览器——那一步由调用方（canvas_create 工具）做。
	 *
	 * @param {{app?: string, createdBy?: string}} [options]
	 */
	createCanvas(options = {}) {
		const id = `c${++this.#canvasSeq}`;
		const canvas = {
			id,
			app: options.app ?? 'classic',
			createdBy: options.createdBy ?? 'tool',
			createdAt: Date.now(),
			clientId: null,
			clients: new Map(),
			lastSeenAt: null,
		};
		this.#canvases.set(id, canvas);
		return canvas;
	}

	/** 页面没带 canvas 参数时的隐式画布。 */
	#autoCanvas() {
		const id = `auto-${++this.#autoSeq}`;
		const canvas = {
			id,
			app: null,
			createdBy: 'auto',
			createdAt: Date.now(),
			clientId: null,
			clients: new Map(),
			lastSeenAt: null,
		};
		this.#canvases.set(id, canvas);
		return canvas;
	}

	#requireCanvas(canvasId) {
		const id = String(canvasId ?? '').trim();
		if (id === '') throw new BridgeError(`要带画布 id（canvas_create 返回的那个）。现在有：${this.#describeCanvases()}`);
		const canvas = this.#canvases.get(id);
		if (!canvas) throw new BridgeError(`没有这个画布：${id}。现在有：${this.#describeCanvases()}`);
		return canvas;
	}

	#describeCanvases() {
		if (this.#canvases.size === 0) return '(一个都没有，用 canvas_create 建一个)';
		return [...this.#canvases.values()].map((canvas) => `${canvas.id}(${canvas.app ?? '?'})`).join('、');
	}

	#openHint(canvas) {
		return `请打开 ${this.canvasUrl(canvas.id, canvas.app)}`;
	}

	#bindClient(clientId, canvasHint) {
		const id = String(clientId ?? '').trim() || `anon-${++this.#callSeq}`;
		const hint = String(canvasHint ?? '').trim();
		let canvas = null;
		if (hint) {
			canvas = this.#canvases.get(hint) ?? null;
			if (!canvas) {
				// 页面带着一个桥不认识的 canvas 参数（例如桥重启过）：按它给的 id 建回来，
				// 免得用户手里那个地址失效。
				canvas = {
					id: hint,
					app: null,
					createdBy: 'page',
					createdAt: Date.now(),
					clientId: null,
					clients: new Map(),
					lastSeenAt: null,
				};
				this.#canvases.set(hint, canvas);
				const numeric = /^[a-zA-Z](\d+)$/.exec(hint);
				if (numeric) this.#canvasSeq = Math.max(this.#canvasSeq, Number(numeric[1]));
			}
		} else {
			const bound = this.#clientCanvas.get(id);
			canvas = bound ? this.#canvases.get(bound) ?? null : null;
			if (!canvas) canvas = this.#autoCanvas();
		}
		this.#clientCanvas.set(id, canvas.id);
		let client = canvas.clients.get(id);
		if (!client) {
			client = { clientId: id, stream: null, connectedAt: null, lastSeenAt: Date.now(), pending: new Map() };
			canvas.clients.set(id, client);
		}
		return { canvas, client, id };
	}

	/** 画布上当前那条连接。 */
	#clientOf(canvas) {
		if (!canvas?.clientId) return null;
		return canvas.clients.get(canvas.clientId) ?? null;
	}

	#detachStream(client, reason) {
		client.stream = null;
		client.lastSeenAt = Date.now();
		for (const [id, pending] of client.pending) {
			clearTimeout(pending.timer);
			pending.reject(new BridgeError(`${reason}：${pending.method} 的结果丢失，请重试。`));
			client.pending.delete(id);
		}
	}

	#rejectPendingOfCanvas(canvasId, reason) {
		const canvas = this.#canvases.get(canvasId);
		if (!canvas?.clients) return;
		for (const client of canvas.clients.values()) {
			if (client.pending.size > 0) this.#detachStream(client, reason);
		}
	}

	/**
	 * 页面挂上 SSE 流（新连接或重连）。同一个画布只认最后一条流。
	 *
	 * @param {string} clientId
	 * @param {string} canvasHint 页面 URL 里的 canvas 参数，可为空
	 * @param {import('node:http').ServerResponse} res
	 * @returns {{clientId: string, canvasId: string}}
	 */
	registerStream(clientId, canvasHint, res) {
		const { canvas, client, id } = this.#bindClient(clientId, canvasHint);
		const previous = canvas.clientId && canvas.clientId !== id ? canvas.clientId : null;
		if (previous) {
			// 同一个画布被第二个页面顶掉：旧连接只解除绑定，画布本身保留。
			this.#clientCanvas.delete(previous);
			canvas.clients.delete(previous);
			this.#rejectPendingOfCanvas(canvas.id, '这个画布被另一个页面接管了');
		}
		if (client.stream && client.stream !== res) this.#detachStream(client, '页面重新连接');
		client.stream = res;
		client.connectedAt = client.connectedAt ?? Date.now();
		canvas.clientId = id;
		canvas.lastSeenAt = Date.now();
		return { clientId: id, canvasId: canvas.id };
	}

	/**
	 * 页面断线：只解除连接，画布记录保留（用户刷新后还能接回来）。
	 *
	 * @param {string} clientId
	 */
	unregisterStream(clientId) {
		const id = String(clientId ?? '').trim();
		const canvasId = this.#clientCanvas.get(id);
		this.#clientCanvas.delete(id);
		if (!canvasId) return;
		const canvas = this.#canvases.get(canvasId);
		const client = canvas?.clients?.get(id);
		if (client) this.#detachStream(client, '浏览器页面已关闭或刷新');
		if (canvas && canvas.clientId === id) canvas.clientId = null;
		canvas?.clients?.delete(id);
	}

	/**
	 * 页面自报身份。没带 canvas 的页面在这里拿到自动分配的 id。
	 *
	 * @param {string} clientId
	 * @param {string} canvasHint
	 * @param {Record<string, unknown>} info
	 * @returns {{clientId: string, canvasId: string}}
	 */
	hello(clientId, canvasHint, info) {
		const { canvas, client } = this.#bindClient(clientId, canvasHint);
		client.info = info && typeof info === 'object' ? info : {};
		client.lastSeenAt = Date.now();
		if (canvas.clientId === null) canvas.clientId = client.clientId;
		canvas.lastSeenAt = client.lastSeenAt;
		return { clientId: client.clientId, canvasId: canvas.id };
	}

	/**
	 * 页面回投一条命令的结果。
	 *
	 * @param {{clientId?: string, id?: number|string, ok?: boolean, result?: unknown, error?: string}} message
	 */
	reply(message) {
		const id = String(message?.clientId ?? '').trim();
		const canvasId = this.#clientCanvas.get(id);
		const canvas = canvasId ? this.#canvases.get(canvasId) : null;
		const client = canvas?.clients?.get(id) ?? null;
		if (!client) return { accepted: false, reason: `未知的客户端 ${message?.clientId}` };
		client.lastSeenAt = Date.now();
		if (canvas) canvas.lastSeenAt = client.lastSeenAt;
		const callId = Number(message?.id);
		const pending = client.pending.get(callId);
		if (!pending) return { accepted: false, reason: `没有等待中的命令 ${message?.id}（可能已超时）` };
		client.pending.delete(callId);
		clearTimeout(pending.timer);
		if (message.ok === false) {
			pending.reject(new BridgeError(`GeoGebra 页面执行 ${pending.method} 失败：${message.error ?? '未给出原因'}`));
		} else {
			pending.resolve(message.result);
		}
		return { accepted: true };
	}

	/**
	 * 让某个画布执行一个方法并等结果。
	 *
	 * @param {string} canvasId
	 * @param {string} method
	 * @param {Record<string, unknown>} [params]
	 * @param {{timeoutMs?: number}} [options]
	 * @returns {Promise<any>}
	 */
	async call(canvasId, method, params = {}, options = {}) {
		const canvas = this.#requireCanvas(canvasId);
		const client = this.#clientOf(canvas);
		if (!client?.stream) {
			throw new BridgeError(
				`画布 ${canvas.id}（${canvas.app ?? '?'} 界面）还没有页面连上来。${this.#openHint(canvas)}，页面加载完 GeoGebra 后即可用。`,
			);
		}
		const callId = ++this.#callSeq;
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.#callTimeoutMs;

		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				client.pending.delete(callId);
				reject(
					new BridgeError(
						`等待画布 ${canvas.id} 执行 ${method} 超过 ${timeoutMs}ms 没有回应：页面可能被挂起、GeoGebra 还在加载，或命令太重。稍后可重试。`,
					),
				);
			}, timeoutMs);
			timer.unref?.();
			client.pending.set(callId, { resolve, reject, timer, method });
			try {
				client.stream.write(`data: ${JSON.stringify({ id: callId, method, params })}\n\n`);
				client.lastSeenAt = Date.now();
				canvas.lastSeenAt = client.lastSeenAt;
			} catch (error) {
				clearTimeout(timer);
				client.pending.delete(callId);
				reject(error);
			}
		});
	}

	/**
	 * 释放一个画布：先让页面自己把 applet 拆掉（真正释放内核内存并断开通道），
	 * 再把记录丢掉。
	 *
	 * @param {string} canvasId
	 * @returns {Promise<{id: string, pageTold: boolean, pageError: string|null}>}
	 */
	async releaseCanvas(canvasId) {
		const canvas = this.#requireCanvas(canvasId);
		let pageTold = false;
		let pageError = null;
		if (this.#clientOf(canvas)?.stream) {
			try {
				await this.call(canvas.id, 'release', {}, { timeoutMs: 3_000 });
				pageTold = true;
			} catch (error) {
				pageError = error instanceof BridgeError ? error.message : String(error?.message ?? error);
			}
		}
		this.#rejectPendingOfCanvas(canvas.id, '画布已被 release');
		for (const [clientId] of canvas.clients) this.#clientCanvas.delete(clientId);
		canvas.clients.clear();
		this.#canvases.delete(canvas.id);
		return { id: canvas.id, pageTold, pageError };
	}

	/**
	 * 某个画布现在有没有页面连着。
	 *
	 * @param {string} canvasId
	 */
	isConnected(canvasId) {
		const canvas = this.#canvases.get(String(canvasId ?? '').trim());
		return Boolean(canvas && this.#clientOf(canvas)?.stream);
	}

	/**
	 * 连着这个画布的页面自报的身份（版本、对象数…）；没连上返回 null。
	 *
	 * @param {string} canvasId
	 */
	pageInfo(canvasId) {
		const canvas = this.#canvases.get(String(canvasId ?? '').trim());
		const client = canvas ? this.#clientOf(canvas) : null;
		return client?.stream ? client.info ?? null : null;
	}

	/** 给 status 工具看的快照。 */
	snapshot() {
		return [...this.#canvases.values()]
			.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
			.map((canvas) => {
				const client = this.#clientOf(canvas);
				const connected = Boolean(client?.stream);
				return {
					id: canvas.id,
					app: canvas.app,
					createdBy: canvas.createdBy,
					url: this.canvasUrl(canvas.id, canvas.app),
					connected,
					clientId: connected ? client.clientId : null,
					info: connected ? client.info ?? null : null,
					pending: client?.pending?.size ?? 0,
					lastSeenAt: canvas.lastSeenAt,
				};
			});
	}

	/** 画布总数。 */
	get size() {
		return this.#canvases.size;
	}
}
