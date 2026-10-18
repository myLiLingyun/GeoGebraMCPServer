// SPDX-License-Identifier: GPL-3.0-only
/**
 * 「请用户打开画布」的确认登记表。
 *
 * canvas_create 建好画布之后不立刻返回，而是登记一条请求：
 *   - 浏览器界面（DSH Web 的弹窗）轮询 `GET /api/pending` → noteUiSeen()；
 *   - 用户点开地址、页面连上画布，再在弹窗里点「已打开」→
 *     `POST /api/pending/confirm {id, action:"opened"}` → confirm()；
 *   - 工具这才把 id 交给模型，继续后面的动作。
 *
 * 三条兜底，保证任何情况下都不会把模型永久卡住：
 *   1. 超时（默认 5 分钟）→ reason=timeout，工具照常返回 id，让模型用 status 自己看；
 *   2. 没有人在看弹窗（界面没轮询过，或已经超过 uiLiveMs 没轮询）→
 *      等一小段 uiGraceMs 后 reason=no-ui，退回「自己试着拉起浏览器 / 把地址给你」的老路径；
 *   3. 画布被 release → reason=gone。
 *
 * 这里只记状态，不认识 GeoGebra，也不碰 HTTP：http.mjs 负责把接口接上，
 * server.mjs 决定结果怎么写进工具返回值。
 */

import { BridgeError } from './errors.mjs';

/** 等用户确认的上限，默认 5 分钟。 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;

/** 没有任何界面在轮询时，先等这么久看看界面会不会出现，再判定「没人能确认」。 */
export const DEFAULT_UI_GRACE_MS = 4_000;

/** 界面轮询间隔比这个久，就认为没有人在看弹窗（客户端正常 2 秒内会问一次）。 */
export const DEFAULT_UI_LIVE_MS = 10_000;

/** 等待循环的步长；确认是本地状态，够快就行。 */
const POLL_MS = 200;

/** 确认请求的两种动作。 */
export const CONFIRM_ACTIONS = Object.freeze(['opened', 'skip']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRequests {
	/** @type {Map<string, {id: string, canvasId: string, url: string, app: string|null, createdAt: number, settled: {reason: string, at: number}|null}>} */
	#items = new Map();
	#seq = 0;
	#uiSeenAt = 0;
	#timeoutMs;
	#uiGraceMs;
	#uiLiveMs;

	/**
	 * @param {{timeoutMs?: number, uiGraceMs?: number, uiLiveMs?: number}} [options]
	 */
	constructor(options = {}) {
		this.#timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_CONFIRM_TIMEOUT_MS;
		this.#uiGraceMs = Number.isFinite(options.uiGraceMs) ? options.uiGraceMs : DEFAULT_UI_GRACE_MS;
		this.#uiLiveMs = Number.isFinite(options.uiLiveMs) ? options.uiLiveMs : DEFAULT_UI_LIVE_MS;
	}

	/** 默认等多久。工具没给参数时用它，也用来写超时文案。 */
	get timeoutMs() {
		return this.#timeoutMs;
	}

	/** 界面最近一次来问的时间戳（0 表示从来没问过）。 */
	get uiSeenAt() {
		return this.#uiSeenAt;
	}

	/** 现在有没有人在看弹窗。 */
	get uiLive() {
		return Date.now() - this.#uiSeenAt <= this.#uiLiveMs;
	}

	/** 界面来问过一次——这就是「有人在看弹窗」的证据。 */
	noteUiSeen() {
		this.#uiSeenAt = Date.now();
	}

	/**
	 * 登记一条等待确认的请求。
	 *
	 * @param {{canvasId: string, url: string, app?: string|null}} request
	 * @returns {{id: string, canvasId: string, url: string, app: string|null, createdAt: number, settled: null}}
	 */
	create(request) {
		const id = `o${++this.#seq}`;
		const item = {
			id,
			canvasId: String(request?.canvasId ?? '').trim(),
			url: String(request?.url ?? ''),
			app: request?.app ?? null,
			createdAt: Date.now(),
			settled: null,
		};
		this.#items.set(item.id, item);
		return item;
	}

	/** 给弹窗看的清单（不含内部字段）。 */
	list() {
		return [...this.#items.values()]
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((item) => ({
				id: item.id,
				canvasId: item.canvasId,
				url: item.url,
				app: item.app,
				createdAt: item.createdAt,
			}));
	}

	/** 现在有几条在等确认。 */
	get size() {
		return this.#items.size;
	}

	/**
	 * 用户在弹窗里做了选择。
	 *
	 * @param {string} id
	 * @param {string} action `opened`（已打开）/ `skip`（跳过）
	 * @returns {{ok: boolean, accepted: boolean, reason: string}}
	 */
	confirm(id, action) {
		const key = String(id ?? '').trim();
		const item = this.#items.get(key);
		if (!item) {
			return { ok: false, accepted: false, reason: `没有等待确认的请求 ${key || '(空)'}：可能已经确认过、超时，或桥刚重启过。` };
		}
		if (!CONFIRM_ACTIONS.includes(action)) {
			return { ok: false, accepted: false, reason: `不认识的动作 ${action}：只接受 ${CONFIRM_ACTIONS.join(' / ')}。` };
		}
		item.settled = { reason: action === 'opened' ? 'confirmed' : 'skipped', at: Date.now() };
		this.#items.delete(item.id);
		return { ok: true, accepted: true, reason: item.settled.reason };
	}

	/**
	 * 等这一条请求有结果。
	 *
	 * @param {ReturnType<OpenRequests['create']>} item create() 返回的那一条
	 * @param {{timeoutMs?: number}} [options] 覆盖默认上限
	 * @returns {Promise<{reason: 'confirmed'|'skipped'|'timeout'|'no-ui'|'gone', at: number}>}
	 */
	async wait(item, options = {}) {
		if (!item || typeof item !== 'object') throw new BridgeError('内部错误：没有要等的确认请求。');
		const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.#timeoutMs;
		const deadline = item.createdAt + timeoutMs;
		for (;;) {
			if (item.settled) return item.settled;
			const now = Date.now();
			if (now >= deadline) {
				this.#items.delete(item.id);
				return { reason: 'timeout', at: now };
			}
			if (now - item.createdAt >= this.#uiGraceMs && now - this.#uiSeenAt > this.#uiLiveMs) {
				this.#items.delete(item.id);
				return { reason: 'no-ui', at: now };
			}
			await sleep(POLL_MS);
		}
	}

	/**
	 * 画布被释放时，把等它的请求一并结掉（工具会看到 gone，不会一直等）。
	 *
	 * @param {string} canvasId
	 */
	dropCanvas(canvasId) {
		const key = String(canvasId ?? '').trim();
		for (const item of [...this.#items.values()]) {
			if (item.canvasId !== key) continue;
			item.settled = { reason: 'gone', at: Date.now() };
			this.#items.delete(item.id);
		}
	}

	/** 桥要退出时全部结掉（正常路径用不到，留个明确出口）。 */
	closeAll() {
		for (const item of [...this.#items.values()]) {
			item.settled = { reason: 'gone', at: Date.now() };
		}
		this.#items.clear();
	}
}
