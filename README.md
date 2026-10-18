<!-- SPDX-License-Identifier: CC-BY-NC-SA-4.0 -->

# geogebra-mcp-bridge

独立程序：**MCP over stdio**，把浏览器里的 GeoGebra 交给任何支持 stdio 的 MCP 客户端。
不依赖 DeepSeek Harness。

GeoGebra 是浏览器里的 GWT 应用，只认页面上的 `ggbApplet` JS API，没有跨进程接口。
所以本程序自己托管一个查看器页面，页面加载完 GeoGebra 后经 SSE 连回来，
页面上的 API 就是全部可操作能力：

```
        MCP client (stdio) ──►  geogebra-mcp-bridge  ──► 127.0.0.1:3460
                                  │                        ├─ /            查看器页面
                                  │                        ├─ /client.js   页面侧的桥
                                  │                        ├─ /GeoGebra/** GeoGebra 离线包
                                  │                        ├─ /events      SSE 下行（发命令）
                                  │                        ├─ /rpc         页面回投结果
                                  └────── MCP tools ───────┴─ /api/status   自检
                                       mcp__geogebra__*        /api/pending  等用户确认「已打开」
                                                               /api/pending/confirm  用户的选择
```

## 下载

| 内容 | 地址 |
| --- | --- |
| 本仓库（MCP server） | <https://github.com/myLiLingyun/GeoGebraMCPServer> |
| 最新源码 ZIP | <https://github.com/myLiLingyun/GeoGebraMCPServer/archive/refs/heads/main.zip> |
| DSH 插件仓库 | <https://github.com/myLiLingyun/GeoGebraDSHPlug> |

```bash
git clone https://github.com/myLiLingyun/GeoGebraMCPServer.git
```

**本仓库不包含 GeoGebra 离线包**。GeoGebra 官方离线包约 32 MB、解压后 100 MB 以上，
按 GeoGebra 自己的非商业许可分发，所以请从官方地址单独下载（见下）。

## 要求

- **Node.js ≥ 20**（`node --version` 确认）
- **Git**（或直接下载上面的 ZIP）
- **一个本机浏览器**：Firefox / Chromium / Edge 均可，用来打开查看器页面
- **GeoGebra 离线包 5.4.932.1**：解压后含 `GeoGebra/deployggb.js`
  与 `GeoGebra/HTML5/5.0/web3d/`
- 可选：DeepSeek Harness，用来获得「数学模式 / 数学模式+」和网页确认框；
  不装 DSH 也能作为普通 MCP server 使用

程序**不启动浏览器**，也不跑 GeoGebra 内核：没有页面连上来时，工具返回一句可读的
中文，并给出查看器地址。`canvas_create` 会先把地址交给用户的网页界面（确认框），
本机有图形环境时也可以自己把浏览器拉起来（见下）。

MCP 客户端断开（stdin 收到 EOF/close）或进程收到 SIGTERM / SIGINT / SIGHUP 时，
桥会关掉 HTTP 服务并退出，把查看器端口放掉——HTTP 监听会把事件循环撑住，不主动退出
就会留下一个仍占着端口的孤儿进程。

## 安装

推荐把两个仓库和离线包放在同一个父目录里，这样桥的默认路径能直接找到离线包：

```
geogebra/
├── GeoGebraMCPServer/            ← 本仓库
├── GeoGebraDSHPlug/              ← DSH 插件（可选）
└── geogebra-math-apps-bundle/    ← GeoGebra 官方离线包
    ├── README.txt
    └── GeoGebra/
        ├── deployggb.js
        └── HTML5/5.0/web3d/
```

### 1. 下载两个仓库

```bash
mkdir -p ~/geogebra && cd ~/geogebra
git clone https://github.com/myLiLingyun/GeoGebraMCPServer.git
git clone https://github.com/myLiLingyun/GeoGebraDSHPlug.git   # 只用 MCP server 时可跳过
```

只想用 MCP server 时，也可以把 ZIP 解压到任意目录，后面的路径按实际位置替换。

### 2. 下载并解压 GeoGebra 离线包

官方下载地址（当前指向 `geogebra-math-apps-bundle-5-4-932-1.zip`）：

```bash
cd ~/geogebra
curl -L -o geogebra-math-apps-bundle.zip \
  https://download.geogebra.org/package/geogebra-math-apps-bundle
unzip geogebra-math-apps-bundle.zip -d geogebra-math-apps-bundle
```

也可以从 <https://www.geogebra.org/download> 的 “GeoGebra Math Apps Bundle” 下载。
解压后确认这一层文件存在：

```bash
test -f ~/geogebra/geogebra-math-apps-bundle/GeoGebra/deployggb.js && echo OK
```

> 离线包放在别处也可以，只要启动时用 `--ggb-root` 或 `GGB_ROOT` 指过去。
> 仓库的 `.gitignore` 已排除它，**不要把离线包提交进 git**。

### 3. 安装 Node 依赖

```bash
cd ~/geogebra/GeoGebraMCPServer
npx --yes pnpm@12 install
```

没有 pnpm 时 `npm install` 也可以（会生成 `package-lock.json`，已被忽略）。
运行时依赖只有 `@modelcontextprotocol/server` 与 `zod`。

### 4. 自检

```bash
node test/list-tools.mjs
```

这条不需要浏览器和 GeoGebra 内核，会按 stdio 启动桥、列出 14 个工具、跑完协议断言。
要连真浏览器和真 GeoGebra 再跑：

```bash
node test/e2e-browser.mjs       # 需要 firefox；产物写到 ./verify/
```

## 接到 MCP 客户端

任何支持 **stdio** 的 MCP 客户端都可以直接用。配置里的路径换成你机器上的绝对路径：

```json
{
  "mcpServers": {
    "geogebra": {
      "command": "node",
      "args": ["/home/you/geogebra/GeoGebraMCPServer/bin/geogebra-mcp-bridge.mjs"],
      "env": {
        "GGB_ROOT": "/home/you/geogebra/geogebra-math-apps-bundle"
      }
    }
  }
}
```

- 按上面的推荐布局安装时，`GGB_ROOT` 可以省略（桥默认找仓库上一级的
  `geogebra-math-apps-bundle/`）。
- Windows 把 `command` 改成 `node.exe` 的绝对路径，路径分隔符用 `\\` 或 `/`。
- 客户端连上后会出现 `mcp__geogebra__*` 工具；先调 `canvas_create`，再打开它返回的地址。
- 接 DeepSeek Harness 不用手写这段配置，装
  [GeoGebraDSHPlug](https://github.com/myLiLingyun/GeoGebraDSHPlug) 即可，
  它会在「数学模式 / 数学模式+」里自动挂载本桥。

## 运行

```bash
cd ~/geogebra/GeoGebraMCPServer

node bin/geogebra-mcp-bridge.mjs                       # 在 stdin/stdout 上提供 MCP
node bin/geogebra-mcp-bridge.mjs --help                # 用法
node bin/geogebra-mcp-bridge.mjs --version             # 版本
node bin/geogebra-mcp-bridge.mjs --port 3461 --ggb-root /path/to/geogebra-math-apps-bundle
```

| 选项 / 环境变量 | 说明 |
| --- | --- |
| `--ggb-root <目录>` / `GGB_ROOT` | GeoGebra 离线包目录，默认与本仓库同级的 `geogebra-math-apps-bundle/` |
| `--port <端口>` / `GGB_BRIDGE_PORT` | 查看器 HTTP 端口，默认 `3460`；被占用时往后顺延（最多 20 个） |
| `--host <地址>` / `GGB_BRIDGE_HOST` | 监听地址，默认 `127.0.0.1`（只监听回环） |
| `-h, --help` / `-V, --version` | 本地回答，不启动任何服务 |

启动后按 stderr 上打印的地址打开查看器，页面加载完 GeoGebra 就会自动连上桥。
用 `canvas_create` 工具建画布时，工具返回里会带上该画布专属的地址（`?canvas=cN&app=…`）。

## 查看器页面

页面参数都在 URL 查询串里：

| 参数 | 说明 |
| --- | --- |
| `app` | `classic`（默认，带 CAS）/ `3d` / `suite`（带 CAS）/ `geometry`。选择流程见下方「界面」 |
| `toolbar` | `off` 隐藏工具栏 |
| `input` | `off` 隐藏代数输入栏 |
| `menu` | `on` 显示菜单栏（默认隐藏） |
| `lang` | 界面语言，默认 `zh_CN` |
| `perspective` | 初始布局串（如 `G`）；给了它，CAS 预热结束后会切回它 |

页面右上角有个连接状态小徽章，显示 GeoGebra 版本与对象数；控制台里
`window.__GGB_BRIDGE__` 暴露 `clientId`、`api()` 与 `events()` 便于手工排查。

页面侧只做四件事：保证 applet 就绪、把方法名映射到 API、把异常变成可读文本、
把构造与用户交互记成事件流。所有业务判断与排版都在 MCP 进程里。

## 工具（14 个）

| 工具 | 说明 |
| --- | --- |
| `status` | 自检：HTTP 服务、离线资源、**画布清单**（id / 界面 / 地址 / 是否连上）；不碰页面，随时可跑 |
| `canvas_create` | 建画布：返回 **id** + 要打开的地址；`app` 决定界面。**默认会登记一条「等你打开画布」的请求并挂住这次调用**，用户在 DSH 网页界面的弹窗里点「已打开」之后才返回（见「确认框」一节） |
| `canvas_release` | 释放画布：让页面 `ggbApplet.remove()` 真正拆除，再删掉这个 id（顺带作废还在等确认的请求） |
| `help` | 五段说明：`bridge` / `commands` / `cas` / `views` / `events` |
| `objects`（需 `id`） | 对象清单（名称/类型/可见/颜色/值/定义），可按类型过滤 |
| `object`（需 `id`） | 单个对象详情（定义、非本地化写法、LaTeX、坐标、样式…） |
| `events`（需 `id`） | 用户操作与构造变化，**读取即清空** |
| `screenshot`（需 `id`） | 出图给用户看：`view: "applet"`（默认）截整个 applet 窗口，`view: "graphics"` 只截活动图形视图（干净的 2D 插图） |
| `view`（需 `id`） | 读：工具、可见坐标范围、网格/坐标轴、视口像素、布局；写：范围/网格/轴/布局/工具/缩放 |
| `eval`（需 `id`） | 执行 GeoGebra 命令（主力）；`engine: "cas"` 走符号计算 |
| `set`（需 `id`） | 按属性名设对象样式或数值（19 种属性） |
| `edit`（需 `id`） | `delete` / `rename` / `clear` / `undo` / `redo` / `showall` |
| `state`（需 `id`） | 整份构造的 `get` / `set` / `save` / `load`（xml / base64 / json） |
| `export`（需 `id`） | PNG / SVG / PDF，写文件或直接返回内容；png 可用 `view` 选图形区（默认）或整窗 |

### GeoGebra 没有「成功/失败」信号，eval 用的是「有没有变化」

这一点值得单独说清楚，因为它决定了 `eval` 的返回怎么写：

- `evalCommand(cmd)` 对 `SetColor` / `Delete` / `ZoomIn` 这类**不新建对象**的命令返回 `false`，
  哪怕它确实执行成功了；
- `evalCommandGetLabels(cmd)` 对这类命令与**真正的语法错误**返回的都是 `null`。

所以页面侧的判据是「有没有产生可观察的变化」：新建了对象，或者构造/视图 XML 变了，
就算成功；什么都没变，才报「没有产生任何变化，多半是语法或参数错了」。
构造 XML 超过 1 MB（比如内嵌了图片）时放弃比对，返回「无法判断」，让模型自己用
`objects` 复核。代价是每次 `eval` 多取一次 `getXML()`，对正常规模的构造可以忽略。

另一个实测结论：**自动命名会撞车**。`Segment(A,B)` 会自己挑一个空闲小写字母
（常常正好是 `f`），此后 `f(x)=x^2` 会把那条线段改写成函数。`eval` 的返回里会列出
新建对象的真实名字，照它往下写就不会错；要更稳就给对象显式命名（`s=Segment(A,B)`）。

### CAS 需要先打开一次 CAS 视图

`evalCommandCAS` 在 CAS 视图从未打开过时一律返回 `"?"`。查看器因此在加载时做一次
预热：短暂打开 CAS 视图，探到引擎就绪（用 `evalCommandCAS("1+1")` 探）再切回目标布局。
只有 `classic` / `suite` 带 CAS；`3d` / `geometry` 会明确报「CAS 没有返回结果」。
另外 CAS 会把结果行（例如积分常数 `c_{1}`）作为对象放进构造，返回里会列出这些新对象名。

### `canvas_create` 不说假话

它默认分两步：先在**用户的网页界面**弹确认框（登记请求 → 等用户打开地址 → 等用户
点「已打开」），确认之后才返回 id；没人能点确认时退回老路径。老路径的判据是**结果**：

- 本进程没有图形环境（linux 且 `DISPLAY` / `WAYLAND_DISPLAY` 都没设）→ 立刻告诉你
  弹不出窗口、请手动打开地址，不去做注定失败的尝试；
- 否则依次试 `browser`（命令行，可带参数，如 `"firefox --new-window"`，默认
  `firefox`、`xdg-open`），**再用最多 8 秒等页面连上来**：连上了才算成功，没连上
  就报错并给出地址与退出码。

浏览器进程「启动成功」不等于「有窗口看得见」：在没有 `DISPLAY` 的进程里，`firefox`
会立刻退出，`spawn` 却不会报错。这条是实测改出来的：DSH 进程没有 `DISPLAY`，早期
实现回了「已用 firefox 打开」，模型为此白跑了 5 步、最后只能问用户要地址。

## 确认框（等用户把画布打开）

`canvas_create` 建好画布之后默认**不立刻返回**，而是登记一条请求并挂住这次调用，
让用户真的把画布打开、再确认已经打开，然后才把 id 交给模型：

```
Agent: canvas_create
   │  桥建好 c1，登记一条等待请求（默认最多等 5 分钟）
   │
   ├─ 浏览器界面（DSH 的 geogebra-bridge-ui 插件）轮询 GET /api/pending
   ├─ 弹窗里给出蓝色可点的画布地址；页面连上之前「已打开，继续」是灰的
   ├─ 用户点开地址 → 页面连回桥 → 弹窗状态变「页面已连上」
   └─ 用户点「已打开，继续」→ POST /api/pending/confirm {id, action:"opened"}
         → 挂住的调用解除，工具返回「用户已在…确认框里点过「已打开」」
```

工具参数：

| 参数 | 说明 |
| --- | --- |
| `confirm` | 是否弹确认框，默认 `true`；`false` 直接走老路径 |
| `confirmTimeoutMs` | 等用户点确认的上限，默认 `300000`（5 分钟）；夹在 5 秒 – 30 分钟之间 |
| `headless` | 自动化路径：用无界面浏览器打开，同时等于关掉确认框 |

三条兜底（都不会把模型永久卡住）：

| 情况 | `reason` | 结果 |
| --- | --- | --- |
| 用户点「跳过，先继续」/ 按 Esc | `skipped` | 立刻返回 id，说明用户跳过了 |
| 等了一小段（默认 4 秒）仍没有任何界面在轮询；或界面已经超过 10 秒没来问过 | `no-ui` | 走老路径：自己试 `firefox` / `xdg-open`，拉不起就把地址给用户 |
| 界面在，但用户一直没点 | `timeout` | 超时返回 id，提示用 `status` 看连接状态，不要重复建画布 |
| 期间画布被 `canvas_release` | `gone` | 返回「请求作废」 |

「界面在不在」是**实际观测**出来的：`GET /api/pending` 每被问一次就刷新一次时间戳。
所以脱离 DSH 单独用这个桥（没有界面插件）时，行为就是老行为，不会白等。

挂到 DSH 时 `toolCallTimeoutMs` 要大于 `confirmTimeoutMs`，否则等确认的调用会先被
宿主掐断（bundle 里用 `600000`）。

### 画布（canvas）：显式句柄

一个「画布」= 一个浏览器里跑着的 GeoGebra 页面，用短 id 指代（`c1`、`c2`…）。
这是为了消掉「同时开着好几个页面时，工具到底操作哪一个」的歧义——以前按「最近活跃」
猜，现在由调用方明确指定：

```
canvas_create {app: "3d"}     →  画布 c1 已建好（3d 界面）。
                                  地址：http://127.0.0.1:3460/?canvas=c1&app=3d
                                  默认先在网页界面的确认框里等用户点「已打开」；
                                  没人能点确认时退回「自己拉起浏览器 / 把地址给用户」
objects {id: "c1"}            →  读 c1 的画布
eval    {id: "c1", command: "A=(1,2)"}
canvas_release {id: "c1"}     →  页面里的 applet 被真正拆除，记录删除
```

- 页面通过 URL 上的 `?canvas=c1` 认领画布；`/events`、`/hello` 都把 id 带回来，
  桥据此把 SSE 通道绑到画布上。一个画布同时只认最后一条连接（页面刷新会重连）。
- 地址里没有 `canvas` 参数的手工页面会被自动分配 `auto-1`、`auto-2`…，也能用。
- 画布在页面断开后**记录保留**（用户刷新后还能接回来），只有 `canvas_release` 才删。
  释放时桥会先让页面自己调 `ggbApplet.remove()`（真正回收内核内存）**再**删记录；
  页面也是在结果回投送达之后才拆通道。

### 界面：classic 与新版

**同一个离线包里装着两套界面**，用查看器 URL 的 `?app=`（工具的 `app` 参数）选：

| app | 界面 |
| --- | --- |
| `3d` | **3D 计算器**（新版界面里专门画 3D 的那个）；需要可用的 WebGL |
| `geometry` | 几何应用：网格与坐标轴默认关闭，命令面是「几何 + 无 CAS」 |
| `suite` | 计算器套件（新版现代界面）：函数、数列、统计、表格、符号计算，带 CAS |
| `classic`（默认） | 老式 Classic：顶部一整条工具栏、左侧代数区、菜单挤在顶上一行，多视图布局最全 |

**推荐的选择流程**（按顺序判断，命中就停；插件提示词里也要求模型照此执行）：

1. 需要 3D 绘图 / 立体 → `3d`
2. 不需要坐标网格的几何问题 → `geometry`
3. 可以只用 suite 完成任务 → `suite`
4. 其它（要经典多视图布局、构形协议，或用户点名要经典界面）→ `classic`

选错 app 只能 `canvas_release` 后重建（`appName` 在页面加载时定死），所以建画布前先定下来。

带 CAS 的只有 `classic` / `suite`；`3d` / `geometry` 的符号计算会明确报「CAS 没有返回结果」。

`appName` 只能在页面加载时决定，**换 app 就是新开一个页面**：那是一份空构造，而且之后的
工具会操作新页面。所以要换界面之前先 `state save`，切过去再 `state load`，或者干脆
`canvas_create` 建第二个画布（各个画布互不干扰），换完用 `canvas_release` 收掉旧的。

`3d` 就是 **3D 计算器**（新版界面里专门画 3D 的那个）。它和 3D 视图一样**依赖浏览器有可用的
WebGL**：没有 WebGL 时页面根本起不来（`appName: "3d"` 实测 180 秒也连不上桥），
`suite`/`classic` 里的 3D 视图则会渲染成一片空白。`status` 与 `view` 会直接把这件事报出来
（`3D 渲染：不可用（…）` / `浏览器 WebGL：不可用（…）`），不要靠猜。

### 关于 3D：先看 WebGL，再谈别的

**3D 视图、3D 计算器（`?app=3d`）、以及 3D 内容的导出，前提都是浏览器有可用的 WebGL。**
本机的无界面 Firefox 实测就是 `WebGL：不可用`（`about:config` 里 `webgl.disabled` 或驱动被禁），
所以在这个环境里：`?app=3d` 连不上、3D 视图像一片空白、导出也拿不到 3D 内容。

在真实浏览器里请先确认：

- 打开 `about:support`，看 Graphics → **WebGL 1 Driver Renderer** 是不是正常值（不是
  “WebGL is disabled / unavailable”）；
- 或者访问 <https://get.webgl.org/>，它直接告诉你浏览器支不支持；
- 被禁了就在 `about:config` 里把 `webgl.disabled` 设为 `false`、`webgl.force-enabled` 设为
  `true` 再重启浏览器（无 GPU 的虚拟机/远程桌面通常还要软件渲染兜底）。

WebGL 可用之后，`?app=3d` 才是真正的 3D 计算器，`view(perspective: "3D")` 才会真的画出 3D。

### 导出 3D 内容（在无 WebGL 环境下的结论，有 WebGL 时未复测）

在**没有 WebGL** 的环境里，导出接口拿到的是图形视图（2D）的画布：

### 为什么 3D 出不了图

实测结论：**GeoGebra 的导出接口只能读图形视图（2D）的画布，3D 视图（WebGL 画布）的内容
拿不到。** 三条路径都验证过：

| 调用 | 在无 WebGL 环境里的结果 |
| --- | --- |
| `getPNGBase64(scale, transparent, DPI, copyToClipboard, greyscale)` | 只有图形区，参数里没有选视图的余地 |
| `getScreenshotBase64(callback, scale)` | 整个 applet 的布局（代数面板 + 图形面板），3D 面板位置是空的 |
| `getThumbnailBase64()` | 同样是图形视图的渲染 |

在 `perspective: "3D"`（视图 XML 确认「视图 1 关、视图 16 开」，即只剩 3D）下截图，出来的
仍然是那张 2D 网格，平面与法向量都不在图里。

**注意这个结论的适用范围**：它是在没有 WebGL 的环境（本机无界面 Firefox）里得到的——3D 面板
本来就没渲染出东西，自然也无从抓取。用户的真实浏览器**已确认支持 WebGL**，那里的表现尚未
定论；切布局后不重算画布是另一个很可能的原因，现在 `view` 工具会补
`recalculateEnvironments`，待复测。
**WebGL 可用时这里没有复测过**，不能断言 GeoGebra 一定抓不到 3D。所以 `screenshot` /
`export` 的说明只写「本环境下 3D 面板拿不到」，并让你先用 `status` 看 WebGL 那一行。

给 3D 内容出图的实际做法：先确认 WebGL 可用并复测导出；不行再把 3D 几何投影到 2D 重画，
或者让用户自己截窗口。

### 超时

| 情况 | 上限 |
| --- | --- |
| 观测类（objects / object / events / view / set） | 20s |
| `eval`（含 CAS） | 60s |
| `state get/set/save/load` | 120s |
| `export` / `screenshot` | 60s |
| `canvas_create` 等用户在确认框里点「已打开」 | 默认 300s（`confirmTimeoutMs` 可调） |

挂到 DSH 时 `toolCallTimeoutMs` 要大于这里最长的那一项（bundle 里用的是 `600000`），
否则长调用会先被宿主掐断。

## HTTP 接口（调试用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 查看器页面 |
| GET | `/client.js` | 页面侧的桥 |
| GET | `/GeoGebra/**` | GeoGebra 离线包（严格限制在该目录内） |
| GET | `/events?clientId=…` | SSE 下行通道，页面在这里收命令 |
| POST | `/hello` | 页面自报身份 |
| POST | `/rpc` | 页面回投命令结果 |
| GET | `/api/status` | 纯 HTTP 自检（`curl` 也能看）：`name` / `protocol` / `startedAt` / 画布清单 |
| GET | `/api/pending` | 现在有哪些画布在等用户确认打开；被问一次就刷新「有人在看弹窗」的时间戳 |
| POST | `/api/pending/confirm` | 用户在弹窗里的选择：`{id, action:"opened"｜"skip"}`；请求已不在时返回 409 |

```bash
curl -s http://127.0.0.1:3460/api/status | head -c 400
curl -s http://127.0.0.1:3460/api/pending
curl -s -X POST -H 'content-type: application/json' \
  -d '{"id":"o1","action":"opened"}' http://127.0.0.1:3460/api/pending/confirm
```

DSH 侧的界面插件通过**同源**路由 `/api/dsh-geogebra-bridge/{pending,confirm,status}`
访问这几条（见 [GeoGebraDSHPlug](https://github.com/myLiLingyun/GeoGebraDSHPlug)）；
桥自身仍然只监听回环地址。

## 当库用

`exports` 指向 `src/server.mjs`：

```js
import { createServer, start, OpenRequests, SERVER_INFO, DEFAULT_GGB_ROOT } from 'geogebra-mcp-bridge';

// 只要 MCP server 实例（自己接传输）。不传 openRequests 时确认框永远走「没人看」的分支，
// 也就是老行为：自己拉起浏览器 / 把地址交给用户。
const server = createServer({ hub, viewerUrl: () => 'http://127.0.0.1:3460/' });

// 想自己接了确认界面，就把登记表也传进去（HTTP 侧的 /api/pending 也用它）：
const openRequests = new OpenRequests({ timeoutMs: 300_000 });
const server2 = createServer({ hub, openRequests, viewerUrl: () => 'http://127.0.0.1:3460/' });

// 或完整启动（HTTP 查看器 + stdio MCP + 确认接口）。
// confirmTimeoutMs 是等用户点「已打开」的上限，默认 300000。
await start({ port: 3460, confirmTimeoutMs: 300_000 });
```

## 自检

```bash
node test/list-tools.mjs        # 离线：不需要浏览器与 GeoGebra 内核
node test/e2e-browser.mjs       # 真机：无界面 Firefox + 真 GeoGebra，产物写到 ./verify/
```

- `test/list-tools.mjs`：检查命令行开关；按 stdio 启动桥并列出 14 个工具，把每个
  `inputSchema` 送进 DSH 的 schema 子集校验器（宿主只支持
  `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解，
  多一个关键字就整体注册失败）；再起一个「假页面」按同一份协议回投结果，
  跑完 97 条断言，覆盖成功路径、错误路径、文件读写、页面断线，以及确认框的
  全流程（登记 → 不存在/非法动作被拒 → 确认「已打开」→ 确认「跳过」→ 超时 →
  `headless` 不登记）。
- `test/e2e-browser.mjs`：用无界面 Firefox 打开查看器，让真 GeoGebra 5.4.932.1 连上来，
  再用 MCP 工具画图、读对象、改样式、算 CAS、导出 PNG/SVG/PDF、存取构造、撤销重做，
  产物落在 `./verify/`（已在 `.gitignore` 里）。

schema 子集校验器取自 DSH 安装目录（`DSH_CHECKOUT` 可覆盖），没有就自动跳过那一步。

## 许可证

- **代码**（`src/`、`bin/`、`web/`、`test/`、`package.json`）：GPL-3.0-only，见 [LICENSE](LICENSE)
- **文档**（`README.md`）：CC BY-NC-SA 4.0，见 [LICENSE.CC-BY-NC-SA-4.0](LICENSE.CC-BY-NC-SA-4.0)

GeoGebra 离线包本身为非商业用途许可，见 <https://www.geogebra.org/license>。
