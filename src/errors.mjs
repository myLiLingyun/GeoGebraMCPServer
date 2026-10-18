// SPDX-License-Identifier: GPL-3.0-only
/**
 * 桥接层自身的失败：没有浏览器页面连上来、等待页面回应超时、页面执行报错。
 * 消息一律写成模型能直接照着补救的中文，工具把它原样以 isError 返回。
 */
export class BridgeError extends Error {}
