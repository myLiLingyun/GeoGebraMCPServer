// SPDX-License-Identifier: GPL-3.0-only
/**
 * GeoGebra 桥的页面侧：把 ggbApplet 的 API 接到桥的 SSE + POST 通道上。
 *
 * 下行：GET /events 上收 {id, method, params}。
 * 上行：POST /rpc 回 {clientId, id, ok, result|error}；POST /hello 自报身份。
 *
 * 这里不实现业务判断（谁该调什么、结果怎么排版都在 MCP 进程里），
 * 只做四件事：保证 applet 就绪、把方法名映射到 API、把异常变成可读文本、
 * 把构造与用户交互记成事件流供 events 工具读走。
 */
(function () {
	'use strict';

	var query = new URLSearchParams(window.location.search);
	var CLIENT_ID =
		window.crypto && typeof window.crypto.randomUUID === 'function'
			? window.crypto.randomUUID()
			: 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
	var APP = query.get('app') || 'classic';
	/** 请求的画布 id（可为空，桥会给一个 auto-N）；生效值以 /hello 的回复为准。 */
	var CANVAS = query.get('canvas') || '';
	var CODEBASE = '/GeoGebra/HTML5/5.0/web3d/';
	var EVENT_LIMIT = 500;
	/** 高频事件在这么多毫秒内的同名重复会被合并。 */
	var DEDUP_MS = 120;

	/** @type {any} ggbApplet 的 API 对象 */
	var api = null;
	var loadedAt = 0;
	var beaconTimer = null;
	var readyResolve = null;
	var readyPromise = new Promise(function (resolve) {
		readyResolve = resolve;
	});
	/** CAS 预热结果；evalCAS 要先等它。null 表示还没开始预热。 */
	var casReady = null;

	/** @type {{at: number, kind: string, target?: string, detail?: string}[]} */
	var eventLog = [];
	var lastRecordAt = Object.create(null);

	// ------------------------------------------------------------------ 小工具

	function safe(fn, fallback) {
		try {
			var value = fn();
			return value === undefined ? fallback : value;
		} catch (error) {
			return fallback;
		}
	}

	function safeString(value) {
		if (value === null || value === undefined) return '';
		try {
			return String(value);
		} catch (error) {
			return '';
		}
	}

	function safeNumber(value) {
		var n = Number(value);
		return Number.isFinite(n) ? n : null;
	}

	function sleep(ms) {
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	function containerSize() {
		return {
			width: Math.max(480, window.innerWidth),
			height: Math.max(360, window.innerHeight),
		};
	}

	function setBadge(text, ok) {
		var badge = document.getElementById('bridge-badge');
		var label = document.getElementById('bridge-badge-text');
		if (label) label.textContent = text;
		if (badge) badge.className = ok ? 'ok' : '';
	}

	function showError(text) {
		var box = document.getElementById('bridge-error');
		if (!box) return;
		box.hidden = false;
		box.textContent = text;
	}

	// ------------------------------------------------------------------ 事件流

	function record(kind, target, detail) {
		var now = Date.now();
		var key = kind + '|' + (target || '') + '|' + (detail || '');
		if (kind === 'update' || kind === 'movingGeos' || kind === 'viewChanged2D') {
			if (now - (lastRecordAt[key] || 0) < DEDUP_MS) return;
		}
		lastRecordAt[key] = now;
		eventLog.push({ at: now, kind: kind, target: target || undefined, detail: detail || undefined });
		if (eventLog.length > EVENT_LIMIT) eventLog.splice(0, eventLog.length - EVENT_LIMIT);
	}

	/**
	 * 注册构造与交互监听器。清空构造会注销 update 类监听器，
	 * 所以每次清空（含 setState）后都要再调一次本函数。
	 *
	 * @param {any} a
	 */
	function registerListeners(a) {
		safe(function () {
			a.registerAddListener(function (name) {
				record('add', safeString(name));
			});
		});
		safe(function () {
			a.registerRemoveListener(function (name) {
				record('remove', safeString(name));
			});
		});
		safe(function () {
			a.registerUpdateListener(function (name) {
				record('update', safeString(name));
			});
		});
		safe(function () {
			a.registerRenameListener(function (oldName, newName) {
				record('rename', safeString(oldName) + '→' + safeString(newName));
			});
		});
		safe(function () {
			a.registerClearListener(function () {
				record('clear');
				// 清空后 update 类监听器被注销，重新挂上。
				registerListeners(a);
			});
		});
		safe(function () {
			a.registerClickListener(function (name) {
				record('click', safeString(name));
			});
		});
		safe(function () {
			a.registerClientListener(function (evt) {
				if (!evt || !evt.type) return;
				switch (evt.type) {
					case 'select':
						record('select', safeString(evt.target));
						break;
					case 'deselect':
						record('deselect', safeString(evt.target));
						break;
					case 'setMode':
						record('setMode', undefined, '工具 ' + safeString(evt.argument));
						break;
					case 'dragEnd':
						record('dragEnd');
						break;
					case 'movingGeos':
						record('movingGeos', undefined, safeString(evt.argument));
						break;
					case 'undo':
						record('undo');
						break;
					case 'redo':
						record('redo');
						break;
					case 'updateStyle':
						record('updateStyle', safeString(evt.target));
						break;
					case 'perspectiveChange':
						record('perspectiveChange');
						break;
					case 'editorStart':
						record('editorStart', safeString(evt.target));
						break;
					case 'editorStop':
						record('editorStop', safeString(evt.target));
						break;
					case 'dropdownOpened':
						record('dropdownOpened', safeString(evt.target));
						break;
					case 'dropdownClosed':
						record('dropdownClosed', safeString(evt.target), evt.index === undefined ? undefined : '选中第 ' + (Number(evt.index) + 1) + ' 项');
						break;
					case 'openMenu':
						record('openMenu', undefined, safeString(evt.argument));
						break;
					case 'openDialog':
						record('openDialog', undefined, safeString(evt.argument));
						break;
					case 'sidePanelOpened':
					case 'sidePanelClosed':
					case 'toolsPanelSelected':
					case 'algebraPanelSelected':
					case 'tablePanelSelected':
						record(evt.type);
						break;
					case 'mouseDown':
						record('mouseDown', undefined, '像素 (' + safeString(evt.x) + ', ' + safeString(evt.y) + ')');
						break;
					default:
						// viewChanged2D / viewChanged3D 等一律忽略：量太大，且 view 工具会现算。
						break;
				}
			});
		});
	}

	// ------------------------------------------------------------------ 读构造

	function objectSummary(a, name) {
		var definition = safeString(safe(function () {
			return a.getDefinitionString(name);
		}));
		if (definition === '') {
			// 函数这类对象 getDefinitionString 可能为空，退回非本地化命令串。
			definition = safeString(safe(function () {
				return a.getCommandString(name, false);
			}));
		}
		return {
			name: name,
			type: safeString(safe(function () {
				return a.getObjectType(name);
			})),
			visible: safe(function () {
				return a.getVisible(name) === true;
			}, false),
			color: safeString(safe(function () {
				return a.getColor(name);
			})),
			value: safeString(safe(function () {
				return a.getValueString(name, false);
			})),
			definition: definition,
		};
	}

	function objectDetail(a, name) {
		var detail = objectSummary(a, name);
		detail.independent = safe(function () {
			return a.isIndependent(name) === true;
		}, null);
		detail.defined = safe(function () {
			return a.isDefined(name) === true;
		}, null);
		detail.command = safeString(safe(function () {
			return a.getCommandString(name, false);
		}));
		detail.latex = safeString(safe(function () {
			return a.getLaTeXString(name);
		}));
		detail.layer = safeNumber(safe(function () {
			return a.getLayer(name);
		}));
		detail.lineStyle = safeNumber(safe(function () {
			return a.getLineStyle(name);
		}));
		detail.lineThickness = safeNumber(safe(function () {
			return a.getLineThickness(name);
		}));
		detail.pointStyle = safeNumber(safe(function () {
			return a.getPointStyle(name);
		}));
		detail.pointSize = safeNumber(safe(function () {
			return a.getPointSize(name);
		}));
		detail.filling = safeNumber(safe(function () {
			return a.getFilling(name);
		}));
		detail.labelStyle = safeNumber(safe(function () {
			return a.getLabelStyle(name);
		}));
		detail.labelVisible = safe(function () {
			var value = a.getLabelVisible(name);
			return typeof value === 'boolean' ? value : null;
		}, null);
		detail.caption = safeString(safe(function () {
			return a.getCaption(name, false);
		}));
		// 只有点/向量有真正意义上的坐标；对线段、圆调 getXcoord 会拿到无意义的值。
		if (detail.type === 'point' || detail.type === 'vector') {
			var coords = {
				x: safeNumber(safe(function () {
					return a.getXcoord(name);
				})),
				y: safeNumber(safe(function () {
					return a.getYcoord(name);
				})),
			};
			var z = safeNumber(safe(function () {
				return a.getZcoord(name);
			}));
			if (z !== null && z !== 0) coords.z = z;
			detail.coords = coords;
		}
		return detail;
	}

	// ------------------------------------------------------------------ eval

	/**
	 * 执行一条命令。
	 *
	 * 用 `evalCommand` 的布尔返回值判断成败（这是 GeoGebra 唯一可靠的成败信号），
	 * 新建对象用「执行前后对象数 + getObjectName(i)」推出来。
	 *
	 * @param {any} a
	 * @param {string} command
	 */
	/** 构造快照的字符上限：超过就放弃「有没有变化」的比对（构造里可能嵌了图片）。 */
	var SNAPSHOT_LIMIT = 1000000;

	function constructionSnapshot(a) {
		var xml = safeString(safe(function () {
			return a.getXML();
		}));
		return xml.length === 0 || xml.length > SNAPSHOT_LIMIT ? null : xml;
	}

	/**
	 * 执行一条命令。
	 *
	 * GeoGebra 没有「这条命令成功了没」的可靠信号：
	 *   - `evalCommand` 对 SetColor / Delete 这类不新建对象的命令返回 false；
	 *   - `evalCommandGetLabels` 对它们和真正的语法错误一样返回 null。
	 * 所以判据是「有没有产生可观察的变化」：新建了对象，或者构造/视图 XML 变了。
	 *
	 * @param {any} a
	 * @param {string} command
	 */
	function doEval(a, command) {
		var text = safeString(command);
		if (text.trim().length === 0) throw new Error('命令不能为空');
		safe(function () {
			a.setErrorDialogsActive(false);
		});
		var before = safeNumber(safe(function () {
			return a.getObjectNumber();
		})) || 0;
		var beforeXml = constructionSnapshot(a);
		var rawLabels;
		var pageError = null;
		try {
			rawLabels = a.evalCommandGetLabels(text);
		} catch (error) {
			pageError = safeString((error && error.message) || error);
		}
		var after = safeNumber(safe(function () {
			return a.getObjectNumber();
		})) || before;
		var labelText = safeString(rawLabels).trim();
		var created = [];
		var names = labelText.length > 0 ? labelText.split(',') : [];
		for (var index = 0; index < names.length; index += 1) {
			var label = safeString(names[index]).trim();
			if (label && !created.some(function (item) {
				return item.name === label;
			})) created.push(objectSummary(a, label));
		}
		var changed = after !== before;
		var ok;
		if (pageError !== null) {
			ok = false;
		} else if (labelText.length > 0 || changed) {
			ok = true;
		} else {
			var afterXml = constructionSnapshot(a);
			if (beforeXml === null || afterXml === null) ok = null; // 构造太大，不比对
			else {
				changed = beforeXml !== afterXml;
				ok = changed;
			}
		}
		return { ok: ok, error: pageError, changed: changed, created: created, objectCount: after };
	}

	// ------------------------------------------------------------------ 视图

	/** 从一段标签文本里抠出所有属性。 */
	function tagAttributes(text) {
		var out = {};
		var re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
		var match;
		while ((match = re.exec(text)) !== null) out[match[1]] = match[2];
		return out;
	}

	function firstTag(xml, name) {
		var match = new RegExp('<' + name + '\\b[^>]*>').exec(xml);
		return match ? tagAttributes(match[0]) : null;
	}

	function allTags(xml, name) {
		var out = [];
		var re = new RegExp('<' + name + '\\b[^>]*>', 'g');
		var match;
		while ((match = re.exec(xml)) !== null) out.push(tagAttributes(match[0]));
		return out;
	}

	/** 从构造 XML 的 <euclidianView> 里算出可见坐标范围与坐标轴状态。 */
	function parseView(xml) {
		var blockMatch = /<euclidianView\b[^>]*>([\s\S]*?)<\/euclidianView>/.exec(xml);
		var block = blockMatch ? blockMatch[1] : xml;
		var size = firstTag(block, 'size');
		// 注意：横轴缩放的属性名是 scale，纵轴才是 yscale（geoGebra 的 XML 就是这样）。
		var coords = firstTag(block, 'coordSystem');
		var axes = allTags(block, 'axis');
		var width = size ? safeNumber(size.width) : null;
		var height = size ? safeNumber(size.height) : null;
		var range = null;
		if (coords) {
			var xZero = safeNumber(coords.xZero);
			var yZero = safeNumber(coords.yZero);
			var xscale = safeNumber(coords.xscale !== undefined ? coords.xscale : coords.scale);
			var yscale = safeNumber(coords.yscale);
			var viewport = containerSize();
			var w = width || viewport.width;
			var h = height || viewport.height;
			if (xZero !== null && yZero !== null && xscale && yscale) {
				range = {
					xmin: (0 - xZero) / xscale,
					xmax: (w - xZero) / xscale,
					ymin: (yZero - h) / yscale,
					ymax: yZero / yscale,
				};
			}
		}
		return {
			width: width,
			height: height,
			range: range,
			axes: axes.length > 0 ? axes.some(function (axis) {
				return axis.show === 'true';
			}) : null,
		};
	}

	/** getGraphicsOptions(1) 返回 JSON（有时是字符串）；网格与坐标轴以它为准。 */
	function readGraphicsOptions(a) {
		var raw = safe(function () {
			return a.getGraphicsOptions(1);
		}, null);
		if (raw === null) return null;
		if (typeof raw === 'string') {
			return safe(function () {
				return JSON.parse(raw);
			}, null);
		}
		return raw;
	}

	function summarizePerspective(xml) {
		var views = allTags(xml, 'view');
		if (views.length === 0) return xml.slice(0, 300);
		return views
			.map(function (view) {
				return '视图 ' + safeString(view.id) + (view.visible === 'true' ? ' 开' : ' 关');
			})
			.join('，');
	}

	function collectInfo() {
		var viewport = containerSize();
		return {
			version: safeString(safe(function () {
				return api.getVersion();
			})),
			appName: APP,
			objectCount: safeNumber(safe(function () {
				return api.getObjectNumber();
			})),
			mode: safeNumber(safe(function () {
				return api.getMode();
			})),
			width: viewport.width,
			height: viewport.height,
			loadedAt: loadedAt,
			url: window.location.href,
		};
	}

	// ------------------------------------------------------- 状态：base64/XML

	/** getBase64 的异步版；回调不来就退回同步版。 */
	function readBase64(a) {
		return new Promise(function (resolve, reject) {
			var settled = false;
			var timer = setTimeout(function () {
				if (settled) return;
				settled = true;
				try {
					resolve(safeString(a.getBase64()));
				} catch (error) {
					reject(error);
				}
			}, 15000);
			try {
				a.getBase64(function (value) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(safeString(value));
				});
			} catch (error) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					resolve(safeString(a.getBase64()));
				} catch (inner) {
					reject(error);
				}
			}
		});
	}

	function writeBase64(a, data) {
		return new Promise(function (resolve, reject) {
			var settled = false;
			var timer = setTimeout(function () {
				if (settled) return;
				settled = true;
				resolve();
			}, 20000);
			try {
				a.setBase64(data, function () {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve();
				});
			} catch (error) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	// ----------------------------------------------------------- invoke 白名单

	/** 允许模型经 invoke 直接调用的 API 方法。只放设置类与少量读取类。 */
	var API_METHODS = [
		'setVisible',
		'setLabelVisible',
		'setLabelStyle',
		'setColor',
		'setValue',
		'setCoords',
		'setCaption',
		'setFixed',
		'setTrace',
		'setLayer',
		'setLayerVisible',
		'setLineStyle',
		'setLineThickness',
		'setPointStyle',
		'setPointSize',
		'setFilling',
		'setDisplayStyle',
		'setAuxiliary',
		'setAnimating',
		'setAnimationSpeed',
		'startAnimation',
		'stopAnimation',
		'renameObject',
		'deleteObject',
		'newConstruction',
		'undo',
		'redo',
		'showAllObjects',
		'refreshViews',
		'setRepaintingActive',
		'setErrorDialogsActive',
		'setOnTheFlyPointCreationActive',
		'setCoordSystem',
		'setGridVisible',
		'setAxesVisible',
		'setAxisLabels',
		'setAxisSteps',
		'setAxisUnits',
		'setMode',
		'setPerspective',
		'setPointCapture',
		'setRounding',
		'setUndoPoint',
		'setSize',
		'setWidth',
		'setHeight',
		'recalculateEnvironments',
		'setEditorState',
		'getEditorState',
		'getGraphicsOptions',
		'setGraphicsOptions',
		'setAlgebraOptions',
		'setXML',
		'evalXML',
		'setFileJSON',
		'reset',
		// 只读取数：给桥在需要时直接取值用，不改变任何状态。
		'getCommandString',
		'getDefinitionString',
		'getValueString',
		'getObjectType',
		'getObjectNumber',
		'getObjectName',
		'getAllObjectNames',
		'exists',
		'isDefined',
		'isIndependent',
		'getColor',
		'getVisible',
		'getValue',
		'getXcoord',
		'getYcoord',
		'getZcoord',
		'getLaTeXString',
		'getLabelStyle',
		'getFilling',
		'getPointSize',
		'getPointStyle',
		'getLineStyle',
		'getLineThickness',
		'getLayer',
		'getCaption',
		'getMode',
		'getGridVisible',
		'getXML',
		'getPerspectiveXML',
		'getVersion',
	];
	var API_METHOD_SET = Object.create(null);
	API_METHODS.forEach(function (name) {
		API_METHOD_SET[name] = true;
	});

	function normalizeResult(value) {
		if (value === undefined || value === null) return null;
		var type = typeof value;
		if (type === 'boolean' || type === 'number' || type === 'string') return value;
		return safeString(value);
	}

	// ------------------------------------------------------------- RPC 方法表

	/** @type {Record<string, (params: any) => Promise<any>>} */
	var METHODS = {
		ping: async function () {
			return { pong: true, ready: api !== null, clientId: CLIENT_ID };
		},

		info: async function () {
			await waitReady();
			return collectInfo();
		},

		eval: async function (params) {
			var a = await waitReady();
			return doEval(a, params.command);
		},

		evalCAS: async function (params) {
			var a = await waitReady();
			var text = safeString(params.command);
			if (text.trim().length === 0) throw new Error('命令不能为空');
			// CAS 引擎只有在 CAS 视图被打开过之后才会响应；等预热结果（见 warmUpCAS）。
			if (casReady) await casReady;
			var before = safe(function () {
				return a.getAllObjectNames();
			}, []) || [];
			var beforeSet = Object.create(null);
			for (var i = 0; i < before.length; i += 1) beforeSet[safeString(before[i])] = true;
			var result = safeString(safe(function () {
				return a.evalCommandCAS(text);
			})).trim();
			if (result === '' || result === '?') {
				throw new Error(
					'CAS 没有返回结果：geometry / 3d 这类应用本身没有 CAS；classic / suite 下如果刚打开页面，CAS 引擎可能还在初始化，稍后重试。',
				);
			}
			// CAS 会把结果行（含积分常数之类）作为对象放进构造，这里把新增的名字找出来。
			var after = safe(function () {
				return a.getAllObjectNames();
			}, []) || [];
			var created = [];
			for (var j = 0; j < after.length; j += 1) {
				var name = safeString(after[j]);
				if (name && !beforeSet[name]) created.push(name);
			}
			return { result: result, created: created };
		},

		objects: async function (params) {
			var a = await waitReady();
			var type = params.type === undefined || params.type === null ? '' : String(params.type).trim();
			var names = type
				? safe(function () {
						return a.getAllObjectNames(type);
				  }, [])
				: safe(function () {
						return a.getAllObjectNames();
				  }, []);
			var list = [];
			for (var index = 0; index < names.length; index += 1) {
				var name = safeString(names[index]);
				if (name) list.push(objectSummary(a, name));
			}
			return { count: safeNumber(safe(function () {
				return a.getObjectNumber();
			})) || list.length, objects: list };
		},

		object: async function (params) {
			var a = await waitReady();
			var name = safeString(params.name).trim();
			if (!name) throw new Error('对象名不能为空');
			var exists = safe(function () {
				return a.exists(name) === true;
			}, false);
			if (!exists) return { exists: false, name: name };
			return objectDetail(a, name);
		},

		events: async function () {
			await waitReady();
			var drained = eventLog.map(function (event) {
				if (event.kind === 'update' && event.target) {
					var value = safeString(safe(function () {
						return api.getValueString(event.target, false);
					}));
					return { at: event.at, kind: event.kind, target: event.target, detail: value ? '现在值 ' + value : undefined };
				}
				return event;
			});
			eventLog.length = 0;
			return { events: drained };
		},

		screenshot: async function (params) {
			var a = await waitReady();
			var scale = Number.isFinite(Number(params.scale)) && Number(params.scale) > 0 ? Number(params.scale) : 1;
			var base64 = safe(function () {
				return a.getPNGBase64(scale, params.transparent === true, undefined);
			}, null);
			if (!base64) throw new Error('导出 PNG 失败（图形视图可能还没渲染）');
			return { base64: safeString(base64), scale: scale };
		},

		/** 整个 applet 窗口的截图（含 2D / 3D / 代数等所有可见面板）。 */
		screenshotApplet: async function (params) {
			var a = await waitReady();
			var scale = Number.isFinite(Number(params.scale)) && Number(params.scale) > 0 ? Number(params.scale) : 1;
			return await new Promise(function (resolve, reject) {
				var settled = false;
				var timer = setTimeout(function () {
					if (settled) return;
					settled = true;
					reject(new Error('整窗截图超时（20s）：getScreenshotBase64 在当前浏览器可能不可用'));
				}, 20000);
				try {
					a.getScreenshotBase64(function (value) {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						// 不同版本可能给 data URL，也可能给纯 base64，两种都兜住。
						var base64 = safeString(value).replace(/^data:image\/png;base64,/, '');
						if (base64.length === 0) {
							reject(new Error('整窗截图返回空'));
							return;
						}
						resolve({ base64: base64, scale: scale });
					}, scale);
				} catch (error) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(error);
				}
			});
		},

		/** 释放这个画布：拆掉 applet（真正回收内核内存）并断开通道。 */
		release: async function () {
			var a = api;
			api = null;
			if (beaconTimer) clearInterval(beaconTimer);
			var canvasName = CANVAS || '?';
			pendingTeardown = function () {
				if (a) {
					safe(function () {
						a.remove();
					});
				}
				setBadge('画布 ' + canvasName + ' 已释放', false);
				showError(
					'这个画布已被 canvas_release 释放，applet 已拆除。要接着用请重新打开：' +
						window.location.origin +
						'/?canvas=' +
						encodeURIComponent(canvasName),
				);
				if (source) safe(function () { source.close(); });
			};
			return { released: true, canvasId: canvasName };
		},

		/** 浏览器到底有没有可用的 WebGL —— GeoGebra 的 3D 视图与 3D 计算器都靠它。 */
		webgl: async function () {
			var result = { webgl2: false, webgl: false, vendor: '', renderer: '', error: '' };
			try {
				var canvas = document.createElement('canvas');
				var gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
				if (!gl) {
					result.error = '浏览器没有给出 WebGL 上下文（about:config 里 webgl.disabled 或驱动被禁用）';
					return result;
				}
				result.webgl = true;
				result.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
				var ext = safe(function () {
					return gl.getExtension('WEBGL_debug_renderer_info');
				}, null);
				if (ext) {
					result.vendor = safeString(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
					result.renderer = safeString(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
				} else {
					result.vendor = safeString(gl.getParameter(gl.VENDOR));
					result.renderer = safeString(gl.getParameter(gl.RENDERER));
				}
			} catch (error) {
				result.error = safeString((error && error.message) || error);
			}
			return result;
		},

		view: async function () {
			var a = await waitReady();
			var xml = safeString(safe(function () {
				return a.getXML();
			}));
			var parsed = parseView(xml);
			var options = readGraphicsOptions(a);
			var grid = options && typeof options.grid === 'boolean' ? options.grid : null;
			var axes = parsed.axes;
			if (options && options.axes && options.axes.x) axes = options.axes.x.visible === true;
			return {
				appName: APP,
				has3DView: /<euclidianView3D/.test(xml),
				mode: safeNumber(safe(function () {
					return a.getMode();
				})),
				grid: grid,
				axes: axes,
				range: parsed.range,
				width: parsed.width || containerSize().width,
				height: parsed.height || containerSize().height,
				perspective: summarizePerspective(safeString(safe(function () {
					return a.getPerspectiveXML();
				}))),
			};
		},

		invoke: async function (params) {
			var a = await waitReady();
			var method = safeString(params.method).trim();
			if (!API_METHOD_SET[method]) throw new Error('不允许调用 API 方法 ' + method);
			if (typeof a[method] !== 'function') throw new Error('当前 GeoGebra 版本没有方法 ' + method);
			var args = Array.isArray(params.args) ? params.args : [];
			var out = a[method].apply(a, args);
			if (method === 'newConstruction' || method === 'setXML' || method === 'evalXML' || method === 'setFileJSON' || method === 'reset') {
				registerListeners(a);
			}
			return { method: method, result: normalizeResult(out) };
		},

		getState: async function (params) {
			var a = await waitReady();
			var format = safeString(params.format) || 'base64';
			if (format === 'xml') {
				return { format: 'xml', data: safeString(safe(function () {
					return a.getXML();
				})) };
			}
			if (format === 'json') {
				return { format: 'json', data: safeString(safe(function () {
					return a.getFileJSON();
				})) };
			}
			return { format: 'base64', data: await readBase64(a) };
		},

		setState: async function (params) {
			var a = await waitReady();
			var format = safeString(params.format) || 'base64';
			var data = safeString(params.data);
			if (data.length === 0) throw new Error('要载入的数据是空的');
			if (format === 'xml') {
				a.setXML(data);
			} else if (format === 'json') {
				a.setFileJSON(data);
			} else {
				await writeBase64(a, data);
			}
			registerListeners(a);
			return { ok: true, objectCount: safeNumber(safe(function () {
				return a.getObjectNumber();
			})) };
		},

		exportPNG: async function (params) {
			var a = await waitReady();
			var scale = Number.isFinite(Number(params.scale)) && Number(params.scale) > 0 ? Number(params.scale) : 1;
			var base64 = safe(function () {
				return a.getPNGBase64(scale, params.transparent === true, undefined);
			}, null);
			if (!base64) throw new Error('导出 PNG 失败');
			return { base64: safeString(base64), scale: scale };
		},

		exportSVG: async function () {
			var a = await waitReady();
			return await new Promise(function (resolve, reject) {
				var settled = false;
				var timer = setTimeout(function () {
					if (settled) return;
					settled = true;
					reject(new Error('导出 SVG 超时（30s）'));
				}, 30000);
				try {
					a.exportSVG(function (svg) {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve({ svg: svg === null || svg === undefined ? null : safeString(svg) });
					});
				} catch (error) {
					settled = true;
					clearTimeout(timer);
					reject(error);
				}
			});
		},

		exportPDF: async function (params) {
			var a = await waitReady();
			var scale = Number.isFinite(Number(params.scale)) && Number(params.scale) > 0 ? Number(params.scale) : 1;
			return await new Promise(function (resolve, reject) {
				var settled = false;
				var timer = setTimeout(function () {
					if (settled) return;
					settled = true;
					reject(new Error('导出 PDF 超时（30s）'));
				}, 30000);
				try {
					a.exportPDF(scale, function (pdf) {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve({ base64: safeString(pdf), scale: scale });
					});
				} catch (error) {
					settled = true;
					clearTimeout(timer);
					reject(error);
				}
			});
		},
	};

	// ------------------------------------------------------------- 通道与调度

	var commandChain = Promise.resolve();
	/** release 用：等结果回投送达之后再拆 applet / 关通道，否则桥会以为命令丢了。 */
	var pendingTeardown = null;

	/** 命令串行执行：GeoGebra 的 API 不是为并发调用设计的。 */
	function enqueue(work) {
		var next = commandChain.then(work, work);
		commandChain = next.then(
			function () {},
			function () {},
		);
		return next;
	}

	function post(path, body) {
		return fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}).catch(function () {
			// 桥不在或页面正在卸载：丢掉即可，工具侧会超时报错。
		});
	}

	var READY_TIMEOUT_MS = 90000;

	async function waitReady() {
		if (api) return api;
		var timedOut = await Promise.race([
			readyPromise.then(function () {
				return false;
			}),
			sleep(READY_TIMEOUT_MS).then(function () {
				return true;
			}),
		]);
		if (timedOut || !api) {
			throw new Error('GeoGebra 还没加载完成（或加载失败）：刷新页面看看，或检查 --ggb-root 指向的离线包是否完整。');
		}
		return api;
	}

	async function handleCommand(message) {
		var id = message && message.id;
		var method = message && message.method;
		try {
			var handler = METHODS[method];
			if (typeof handler !== 'function') throw new Error('桥发来了未知方法 ' + method);
			var params = message.params || {};
			var result = await enqueue(function () {
				return handler(params);
			});
			await post('/rpc', { clientId: CLIENT_ID, id: id, ok: true, result: result });
			if (pendingTeardown) {
				var teardown = pendingTeardown;
				pendingTeardown = null;
				safe(teardown);
			}
		} catch (error) {
			await post('/rpc', { clientId: CLIENT_ID, id: id, ok: false, error: safeString((error && error.message) || error) });
		}
	}

	var source = null;

	function connect() {
		source = new EventSource('/events?clientId=' + encodeURIComponent(CLIENT_ID) + '&canvas=' + encodeURIComponent(CANVAS));
		source.onopen = function () {
			setBadge(api ? badgeText() : '已连接桥，正在加载 GeoGebra…', api !== null);
		};
		source.onerror = function () {
			setBadge('桥断开，自动重连中…', false);
		};
		source.onmessage = function (event) {
			var message;
			try {
				message = JSON.parse(event.data);
			} catch (error) {
				return;
			}
			handleCommand(message);
		};
	}

	function badgeText() {
		var version = safeString(safe(function () {
			return api.getVersion();
		}));
		var count = safeNumber(safe(function () {
			return api.getObjectNumber();
		}));
		return (
			'桥已连接 · 画布 ' +
			(CANVAS || '?') +
			' · GeoGebra ' +
			(version || '?') +
			' · ' +
			(count === null ? '?' : count) +
			' 个对象'
		);
	}

	/** 定时把身份/对象数报给桥，status 里的信息就不会过时。 */
	function startBeacon() {
		if (beaconTimer) clearInterval(beaconTimer);
		beaconTimer = setInterval(function () {
			if (!api) return;
			setBadge(badgeText(), true);
			announce(collectInfo());
		}, 5000);
	}

	// --------------------------------------------------------------- 启动

	/** 有 CAS 的应用（geometry / 3d 没有）。 */
	var CAS_APPS = { classic: true, suite: true };

	/**
	 * 预热 CAS：GeoGebra 的 CAS 引擎只在 CAS 视图被打开过之后才开始响应
	 * `evalCommandCAS`，否则一律返回 "?"。这里在加载时短暂打开 CAS 视图，
	 * 探到引擎就绪后把布局切回目标值（默认 AG），之后 CAS 一直可用。
	 *
	 * @param {any} a
	 */
	function warmUpCAS(a) {
		if (!CAS_APPS[APP]) {
			casReady = Promise.resolve(false);
			return;
		}
		var target = query.get('perspective') || 'AG';
		safe(function () {
			a.setPerspective('C');
		});
		casReady = new Promise(function (resolve) {
			var tries = 0;
			var timer = setInterval(function () {
				tries += 1;
				var probe = safeString(safe(function () {
					return a.evalCommandCAS('1+1');
				})).trim();
				var ready = probe !== '' && probe !== '?';
				if (ready || tries >= 24) {
					clearInterval(timer);
					safe(function () {
						a.setPerspective(target);
					});
					resolve(ready);
				}
			}, 250);
		});
	}

	/** 把身份（含画布提示）报给桥；首次会拿到生效的 canvasId 并记下来。 */
	function announce(info) {
		return fetch('/hello', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientId: CLIENT_ID, canvas: CANVAS, info: info }),
		})
			.then(function (response) {
				return response.json();
			})
			.then(function (body) {
				if (body && body.canvasId) CANVAS = body.canvasId;
				return body;
			})
			.catch(function () {
				return null;
			});
	}

	function onAppletLoad(ggbApi) {
		api = ggbApi;
		loadedAt = Date.now();
		safe(function () {
			api.setErrorDialogsActive(false);
		});
		registerListeners(api);
		warmUpCAS(api);
		readyResolve(api);
		announce(collectInfo()).then(function () {
			setBadge(badgeText(), true);
			startBeacon();
		});
	}

	function boot() {
		if (typeof window.GGBApplet !== 'function') {
			showError(
				'没能加载 /GeoGebra/deployggb.js。\n' +
					'检查桥的 --ggb-root 是否指向 GeoGebra 离线包（应含 GeoGebra/deployggb.js 与 GeoGebra/HTML5/5.0/web3d/），' +
					'以及桥进程 stderr 上的日志。',
			);
			return;
		}
		var size = containerSize();
		var applet = new window.GGBApplet(
			{
				appName: APP,
				width: size.width,
				height: size.height,
				showToolBar: query.get('toolbar') !== 'off',
				showAlgebraInput: query.get('input') !== 'off',
				showMenuBar: query.get('menu') === 'on',
				showResetIcon: false,
				enableRightClick: true,
				errorDialogsActive: false,
				language: query.get('lang') || 'zh_CN',
				appletOnLoad: onAppletLoad,
			},
			true,
		);
		applet.setHTML5Codebase(CODEBASE);
		applet.inject('ggb-element');

		var resizeTimer = null;
		window.addEventListener('resize', function () {
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(function () {
				if (!api) return;
				var next = containerSize();
				safe(function () {
					api.setSize(next.width, next.height);
				});
				safe(function () {
					var recalculate = api.recalculateEnvironments;
					if (typeof recalculate === 'function') recalculate.call(api);
				});
			}, 250);
		});

		// 90s 还没起来就给一句能查的提示。
		setTimeout(function () {
			if (!api) {
				showError(
					'GeoGebra 内核 90 秒内没有初始化完成。\n' +
						'常见原因：离线包路径不对（页面上 404），或浏览器控制台里有模块加载错误。\n' +
						'先在浏览器开发者工具里看 Network / Console。',
				);
			}
		}, READY_TIMEOUT_MS);
	}

	// 给在页面控制台里手工排查用。
	window.__GGB_BRIDGE__ = {
		clientId: CLIENT_ID,
		api: function () {
			return api;
		},
		events: function () {
			return eventLog.slice();
		},
	};

	connect();
	if (document.readyState === 'complete' || document.readyState === 'interactive') {
		boot();
	} else {
		window.addEventListener('DOMContentLoaded', boot);
	}
})();
