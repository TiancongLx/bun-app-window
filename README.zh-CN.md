# bun-app-window

[![npm version](https://img.shields.io/npm/v/bun-app-window?color=cb3837&logo=npm)](https://www.npmjs.com/package/bun-app-window)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.4.3-f472b6?logo=bun&logoColor=white)](https://bun.sh)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#系统要求与设计边界)
[![WebView2](https://img.shields.io/badge/WebView2-System%20Runtime-008080)](#系统要求与设计边界)
[![License](https://img.shields.io/badge/License-MIT-2ea44f)](./LICENSE)

简体中文 | [正體中文](./README.zh-TW.md) | [English](./README.md)

面向 Bun 应用的 Windows 原生窗口壳，基于系统内置 WebView2 运行时承载前端界面。

本项目遵循极简职责边界：仅负责窗口生命周期、几何尺寸、DPI 缩放适配、无边框窗口定制及底层消息通道；业务逻辑与 UI 渲染完全解耦于壳层之外。

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS } from "bun-app-window";

const server = serveOnSafePort({ fetch: () => new Response("<h1>Hello</h1>") });
await openShell({ url: `http://127.0.0.1:${server.port}`, flags: FLAG_FRAMELESS });
```

---

## 系统要求与设计边界

在引入本项目前，请确认以下技术前提与架构取舍是否符合你的应用场景：

| 维度 | 限制与说明 |
| --- | --- |
| 仅支持 Windows x64 | `package.json` 中的 `os` 与 `cpu` 字段已做硬性限制，拒绝在其他平台安装（包名保持平台中立仅为预留命名空间）。预编译动态库 `libshell.dll` 随包分发，无需在安装期编译 |
| 仅支持 Bun 运行时 | 包内直接发布 TypeScript 源码，要求 Bun ≥ 1.4.3。Node.js 环境虽可完成包安装，但无法直接运行 |
| 类型检查需自备 `@types/bun` | 包内是 `.ts` 源文件，消费方的 `bun check` 会一并编译它们。需执行 `bun add -d @types/bun`，否则类型检查会在 `node_modules` 内报 `TS2868: Cannot find name 'Bun'` |
| 基于 `bun:ffi` 构建 | `bun:ffi` 在 Bun 中仍标记为实验性特性（Experimental）。官方建议生产环境优先采用 Node-API，本项目选择 `bun:ffi` 是为了换取零第三方依赖的轻量架构 |

运行环境与能力边界：

- 依赖系统 WebView2 Runtime：目标机器需已安装 WebView2 运行时（Windows 11 默认内置）。
- 要求交互式桌面会话：受 Windows 会话隔离机制限制，WebView2 无法在 Session 0（如系统服务）中启动；但实测在 High 完整性级别的管理员提权进程中可正常运行。
- 明确不包含的特性：系统托盘（Tray）、原生顶部菜单栏、自动更新、多窗口管理、跨平台支持。

## 安装

```bash
bun add bun-app-window
```

### 包内包含什么

发布的 tarball 只有预编译的 `dist/libshell.dll` 与 TypeScript 源码，共 21 个文件（约 0.4 MB）。原生 C++ 层（`native/`）与上游 vendored 头文件（`vendor/`）**不随包分发**：它们只在重编 `libshell.dll` 时需要，而重编必须 clone 仓库。因此 `bun run build:native` 与 `build:exe` 是本仓库专用脚本，装进 `node_modules` 后执行没有意义。

## 快速开始

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";

const server = serveOnSafePort({
  fetch: () => new Response("<h1>Hello</h1>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  }),
});

const shell = await openShell({
  url: `http://127.0.0.1:${server.port}`,
  title: "My App",
  width: 1000,
  height: 680,
  flags: FLAG_FRAMELESS | FLAG_CENTER,
  minWidth: 480,
  minHeight: 320,
});

shell.post(JSON.stringify({ t: "ready" }));   // 宿主 → 页面单向消息
shell.setTitle("Doing work…");
```

说明：`createShell(opts)` 仅解析并加载原生动态库，不创建窗口；`openShell(opts)` 则一步完成实例创建与窗口启动，若启动失败将直接抛出异常。

## 核心 API

### 实例方法与属性

| 成员 | 说明 |
| --- | --- |
| `start()` | 创建并启动窗口，返回 `{ rc, error }`。调用后立即返回，UI 消息循环运行于独立原生线程 |
| `stop()` | 销毁窗口并释放底层资源，支持幂等重复调用 |
| `show()` | 显示窗口。常配合 `FLAG_DEFER_SHOW` 使用，实现在页面渲染就绪后再展现窗口 |
| `isAlive()` | 检测窗口是否存活（注：`state()` 无法区分「尚未启动」与「已销毁」状态）。等窗口关闭请用 `pollEvents()` 的 `CLOSED`，别轮询它 |
| `pollEvents(max?)` | 批量拉取窗口生命周期事件（`STATE` / `CLOSED`），同步、消费式。详见下文「窗口事件」 |
| `state()` | 获取当前窗口状态：`{ maximized, minimized, focused, dark, raw }` |
| `lastError()` | 获取最近一次操作失败的错误信息，无错误时返回空字符串 |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | 基础窗口控制操作，返回状态码 `rc` |
| `setMinSize(w, h)` | 设置窗口最小尺寸（单位：逻辑像素） |
| `drag()` | 触发原生窗口拖拽（在页面 `pointerdown` 事件中调用，完整保留 Windows 贴边分屏特性） |
| `beginResize(edge)` | 触发原生边框缩放（在页面 `pointermove` 事件中调用，`edge` 取值见 `RESIZE_EDGE.*`） |
| `post(json)` | 宿主向页面单向投递 JSON 消息，异步发送且不等待返回结果 |
| `setZoom(f)` / `getZoom()` | 设置或获取页面缩放比例（有效范围 `0.25`–`3.0`，越界值自动钳制） |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | 页面重载、打开开发者工具、切换全屏（分别对应 `Ctrl+R` / `F12` / `F11`） |
| `setBrowserUi(mask)` | 禁用指定的浏览器默认行为，传入 `BROWSER_UI_*` 标志位的按位或组合 |
| `showContextMenu(x, y, items)` | 在指定屏幕坐标弹出 Win32 原生上下文菜单（详见下文用法） |
| `pickFolder(title?)` | 调用原生文件夹选择对话框（同步阻塞当前调用线程） |
| `libInfo` | 原生动态库解析元数据（包含实际路径、加载来源、SHA-256 校验值） |
| `symbols` | 底层直通接口：直接访问通过 `dlopen` 导出的底层 C 符号 |

### 窗口标志位（Flags）

通过按位或（`|`）组合传入 `opts.flags`：

| 标志位 | 作用说明 |
| --- | --- |
| `FLAG_FRAMELESS` | 无边框窗口模式，移除系统默认标题栏，交由前端页面自行绘制 |
| `FLAG_RESIZABLE` | 允许用户调整窗口大小 |
| `FLAG_CENTER` | 启动时在当前显示器工作区居中显示（有边框与无边框模式均生效） |
| `FLAG_TOPMOST` | 窗口始终置顶 |
| `FLAG_DEFER_SHOW` | 创建窗口后保持隐藏状态，等待显式调用 `show()` |
| `FLAG_ACCEPT_DROP` | 允许窗口接收外部文件或文件夹拖放事件 |
| `FLAG_START_MAXIMIZED` | 窗口首次显示即处于最大化状态，避免从普通尺寸跳变到最大化的中间闪烁帧 |
| `FLAG_ALLOW_EXTERNAL_NAV` | 放弃外部导航拦截——用于本身就是浏览器的应用 |

### 外部导航默认被拦截

不给 `FLAG_ALLOW_EXTERNAL_NAV` 时，一个跨源链接再也无法把应用导航走。壳会取消这次导航，
把地址交给系统默认浏览器：

- **同源**（启动地址是 `file://` 等无 origin 的形态时，改为判断「同文档」，即剥掉
  `#fragment` 后与启动地址逐字相同）留在窗口内导航，应用自己的路由不受影响。
- **跨源**会取消导航并交给系统浏览器——但只有 `http:` / `https:`。`file:`、
  `javascript:`、`ms-*:` 以及自定义 scheme 一律静默取消，绝不触达协议处理器；
  `mailto:` / `tel:` 也**不在**放行之列。
- **`window.open` / `target=_blank`** 始终被拦下并外开，即使给了
  `FLAG_ALLOW_EXTERNAL_NAV` 也一样。那是能力边界而非策略：壳只持有一个顶层窗口
  （原生层是进程级单例），多开出来的窗口没有任何宿主 API 能管它。

桌面壳没有地址栏、没有后退按钮，也没有任何宿主 API 能把页面导航回来——所以一次误点
外链就等于应用被换成了那个网站。这就是默认值选安全一侧的原因。

## 子路径模块

核心窗口控制之外的扩展能力均拆分在独立子路径下，可按需引入。

### `bun-app-window/app` — 应用骨架

用这个包写第一个应用时，业务代码可能只有 30 行，但**宿主样板是 180 行**：挑安全端口、
生成鉴权 token、处理 WebSocket 升级、把 HTML 当字符串吐出去、把 `createIpcServer`
接到 Bun 的 websocket 回调上、拼窗口 flags、处理 `openShell` 失败、等窗口关闭
（`EVENT_CLOSED`）、按顺序 `stop()` 两个东西。每一段单看都不难，但它们**只在特定顺序下正确**
（`stop()` 不先等窗口真的销毁就关服务，下次启动会撞上 "already started"）。
`app` 把这些收成一次调用：

```ts
// main.ts
import { createApp } from "bun-app-window/app";
import { BROWSER_UI_ALL, FLAG_FRAMELESS } from "bun-app-window";
import htmlText from "./index.html" with { type: "text" };

// `with { type: "text" }` 让 Bun 在打包期把文件内联进去，所以 `bun build --compile` 后仍然成立。
// TS 7.0.2 看不到这条声明——bun-types 把它 gate 在 `typesVersions >= 7.1` 后面，
// 于是这个 import 被解析成 `HTMLBundle` 而不是 `string`。桥梁就落在这里。
const html = htmlText as unknown as string;

const app = await createApp({
  html,
  title: "我的应用",
  flags: FLAG_FRAMELESS,          // 想要自绘标题栏就显式加
  browserUi: BROWSER_UI_ALL,
  service: {
    greet: (name: string) => `hi ${name}`,
    pickFolder: () => app.shell.pickFolder(),
  },
});

await app.wait();                  // 窗口关闭时 resolve
await app.stop();                  // 释放事件泵与服务；幂等，已关闭时立即返回
```

```ts
// page.ts —— index.html 的 bundle 里
import { connect } from "bun-app-window/ipc";
const api = await connect();       // token 从页面 URL 的 ?t= 取
await api.greet("Ada");
```

它替你做的事：

- 绑定浏览器安全的端口（绝不会是 `ERR_UNSAFE_PORT` 那几个），并把 HTML 服务出去。
- 每次运行生成一个 token，并在**升级之前**用它校验 `/ws` —— 升级之后就没有机会拒绝了。
  `ipc` 没开时 `/ws` 是 `404` 而不是 `403`：403 等于告诉对方「这里有通道」。
- 把 `createIpcServer` 接到 websocket 的 `open` / `message` / `close` 上，`ipc.emit()` 才能到页面。
- `stop()` 有序且幂等：`shell.stop()` → 等 `EVENT_CLOSED`（带 5 秒上限）→ `server.stop()`。
- 起一个窗口事件泵并且只起一个：`app.events`。它同时承担「等窗口关闭」，
  所以是唯一的事件消费者；`attachPlacementStore` 要用它时传 `{ events: app.events }`。
- 启动失败不留半启动状态：`openShell` 抛错时，已绑定的端口会被释放。

注意事项：

- **默认不带 `FLAG_FRAMELESS`。** 无边框窗口没有系统标题栏就拖不动，必须由页面先挂上
  `mountTitleBar`。默认值选的是「页面什么都不做也能用」的那一侧。
- **`wait()` 只负责等。** 它在 `EVENT_CLOSED` 上 resolve，但不会停事件泵、也不会关服务——而
  事件泵的定时器是 ref 的（`keepAlive: true`），所以停在这一行的进程会在窗口消失后继续挂着。
  必须跟一句 `stop()`：它幂等，且关闭已被观察到时会立即返回。
- **静态资源只吃内联字符串。** `with { type: "text" }` 得到的是编译期常量：不碰文件系统、
  不产生临时文件、`bun build --compile` 后仍然成立。TS 7.0.2 会把这条 import 解析成
  `HTMLBundle` 而不是 `string`（`bun-types` 把正确的声明 gate 在 `typesVersions >= 7.1`
  后面），示例里的 `as unknown as string` 就是为此而写。别用 `Bun.file().text()` 去「修」它：
  那是运行期读盘，HTML 就不在编译产物里了。要从磁盘读东西就写个 `routes` 函数 —— 五行，
  而且路径解析的问题留在你这边，不会渗进骨架。
- **不从主入口导出。** 它和 `./state`、`./ipc` 一样是子路径。它从 `./index` 导入
  `openShell`；若 `index.ts` 反过来导出它，就成了循环。

**这不是 `Bun.WebView` 的替代品。** 那个是 headless 浏览器，做自动化 / 测试 / 抓取 ——
没有窗口，而且只能截自己的页面。本项目画的是真实桌面窗口：系统标题栏、DPI 感知、
贴边分屏、任务栏归属。两者不在同一条赛道上。

### `bun-app-window/ipc` — 类型化双向通信与事件总线

宿主与前端页面共享同一份 TypeScript 类型声明，客户端通过泛型在编译期完成方法签名与事件负载校验：

```ts
// api.ts —— 宿主与页面共同引入的类型契约
export type Api = { greet(name: string): string };
export type Events = { windowState: { maximized: boolean } };
```

```ts
// 宿主端
import { createIpcServer } from "bun-app-window/ipc";

const ipc = createIpcServer({
  service: { greet: (name: string) => `Hello ${name}` },
});

serveOnSafePort({
  fetch(req) { /* 处理静态页面与鉴权 */ },
  websocket: {
    open: (ws) => ipc.attach(ws),
    message: (ws, raw) => ipc.handle(ws, raw),
    close: (ws) => ipc.detach(ws),
  },
});

ipc.emit("windowState", { maximized: false });   // 向页面主动推送事件
```

```ts
// 页面端
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada");                        // 返回类型自动推导为 string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

默认情况下，`connect` 会从当前页面 URL 的查询参数 `?t=` 中读取鉴权 Token 并连接至 `/ws`。若需自定义连接方式，可显式传入 `url` 或自定义 `channel` 实例。

#### 客户端保留名

客户端是一个 `Proxy`：有几个名字会解析到客户端自己身上，永远到不了远端方法。服务表里若有
同名方法，**那个服务端方法就永远调不到**——页面调的是客户端自己的成员，两端都不会报错。

| 名字 | 页面实际拿到的东西 |
| --- | --- |
| `on` / `off` | 事件订阅辅助函数 |
| `close()` | 关闭 WebSocket 通道——之后所有调用都会被 reject |
| `connected` | `boolean`，通道当前是否可用 |
| `pending` | `number`，尚未收到回复的调用数 |
| `then` | `undefined`，否则 `await client` 会把这个永不兑现的 thenable 等下去 |

Symbol 键同样保留。给服务方法换个名字（`winClose` 而不是 `close`），在页面侧映射回去 ——
见下面的标题栏一节。

### `bun-app-window/titlebar` — Windows 11 风格标题栏

用于在无边框模式下快速挂载符合 Windows 11 视觉规范的自定义标题栏。IPC 服务是**扁平的**——
没有 `window` 这一层命名空间——而且四个最自然的名字里有一个被客户端自己占了，所以宿主端
暴露 `winClose`，页面侧再映射回去：

```ts
// 宿主端 —— 扁平服务；`close` 是 IPC 客户端的保留名
createIpcServer({
  service: {
    minimize: () => shell.minimize(),
    toggleMaximize: () => shell.toggleMaximize(),
    winClose: () => shell.close(),
    drag: () => shell.drag(),
  },
});
```

```ts
// 页面端 —— 显式拼出 bridge
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
  title: "我的应用",
  icon: "/icon.svg",
  bridge: bridgeFromWindowService({
    minimize: () => api.minimize(),
    toggleMaximize: () => api.toggleMaximize(),
    close: () => api.winClose(),          // 桥接时再映射回 close
    drag: () => api.drag(),
  }),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

实现细节：

- 原生拖拽体验：拖拽操作通过调用 `shell.drag()` 交由底层发送 `WM_NCLBUTTONDOWN`（`HTCAPTION`）消息处理，完整保留 Windows 11 贴边分屏（Snap Layouts）与双击最大化等系统级行为。
- 样式定制与图标方案：颜色与尺寸均通过 CSS 变量（`--ws-tb-*`）控制，覆盖变量即可实现换肤。按钮图标默认采用兼容性更好的几何矢量符号；若配置 `icons: "fluent"` 则切换为 `Segoe Fluent Icons` 字体渲染（注意：若目标系统缺失该字体，按钮将回退显示为缺字方框）。

### `bun-app-window/state` — 窗口位置与尺寸持久化

用于自动记录并在下次启动时恢复窗口的坐标、尺寸及最大化状态：

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE);   // 订阅窗口事件，拖动停手后写一次盘
process.on("beforeExit", () => store.flush());
```

底层原生实现已妥善处理以下边界场景：

- 最大化状态下保存的是窗口「还原后的正常矩形（Restore Rect）」而非全屏尺寸。
- 跨显示器不同缩放比下的 DPI 坐标换算。
- 屏幕拓扑变化（如拔除副屏）后的屏外坐标越界校验与修正。

写入是事件驱动的：收到状态变化**立刻**取快照（微秒级），写盘攒到停手 300 ms 后做一次。
窗口静止时既没有原生调用也没有磁盘写入。用 `debounceMs` 调整写盘延迟；用 `pumpMs`
调整内部事件泵的拉取节奏。

若已有事件泵（例如用了 `createApp`），把它传进来，避免两个消费者争抢同一批事件：

```ts
import { createApp } from "bun-app-window/app";
import { attachPlacementStore } from "bun-app-window/state";

const app = await createApp({ html });
const store = attachPlacementStore(app.shell, FILE, { events: app.events });
```

若无需后台订阅，也可直接调用 `capturePlacement` 与 `savePlacement` 执行单次手动读写。

### 窗口事件

宿主要知道「窗口状态变了」，不必轮询——`pollEvents()` 直接给出事件流：

```ts
import { EVENT_CLOSED, EVENT_STATE } from "bun-app-window/events";

for (const e of shell.pollEvents()) {
  if (e.type === EVENT_CLOSED) break;          // 窗口已销毁，原生单例已释放
  if (e.type === EVENT_STATE && e.maximized) { /* ... */ }
}
```

`pollEvents()` 是**消费式**的：读走的记录不会再来。所以一个进程只应有一个消费者。
想要固定节奏与多路订阅时，用 `./events` 的 `attachEventPump()`：

```ts
import { EVENT_CLOSED, attachEventPump } from "bun-app-window/events";

const pump = attachEventPump(shell, { intervalMs: 16 });
pump.on((e) => { if (e.type === EVENT_CLOSED) pump.stop(); });
pump.onGap((missing) => console.warn(`漏了 ${missing} 条事件`));
```

- `STATE` 载荷是**快照**：`width` / `height` / `dpi` 与四位状态（`maximized` / `minimized` / `focused` / `dark`）。
- `CLOSED` 是终态。它由原生侧在 teardown 全部做完、窗口句柄已置空之后写出，所以
  「看到 `CLOSED`」等价于「可以安全重启窗口」——这是它优于 `isAlive()` 的地方。
- 原生侧环形队列容量 128 条，满时丢最旧。丢失量通过 `seq` 缺口如实上报（`onGap`），
  不会伪装成「什么都没发生」。
- 事件泵的定时器默认 `unref`（不阻止进程退出）。若靠它等窗口关闭，传 `keepAlive: true`。

### `bun-app-window/debug` — 诊断与排障接口

提供底层窗口度量与命中测试信息。注意：诊断接口不属于稳定 API 契约，后续版本可能随时调整。

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics();   // → "pos=196,196 win=1960x1400 client=1960x1400 work=3072x1824 border=13x13 round=1"
d.dpi();       // → "awareness=-1 dpi=192 scale=200%"
d.hittest(x, y);
```

`metrics()` 与 `dpi()` 返回的是**格式化文本**，不是对象。真要解析就写进一次性脚本里，别把解析器
塞进生产代码——这个格式不属于任何契约。

### `bun-app-window/native` — 预编译动态库本体

该子路径解析到 `dist/libshell.dll` 本身，`import.meta.resolve()` 拿到的是可直接拷到 exe 旁边的真实路径：

```ts
import nativeLibPath from "bun-app-window/native" with { type: "file" };

await Bun.write(join(dirname(process.execPath), "libshell.dll"), Bun.file(nativeLibPath));
```

`with { type: "file" }` 不能省，否则打包器会把 DLL 当模块解析。此入口用于自行封装的场景；走 `bun build --compile` 请直接用 `bun-app-window/embedded`，它不必碰文件系统。

## 常见场景与最佳实践

### 1. 禁用浏览器默认行为

WebView2 默认保留了完整的浏览器交互语义。构建桌面应用时，通常建议将其全部禁用：

```ts
import { BROWSER_UI_ALL } from "bun-app-window";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

也可按需组合以下标志位：

| 标志位 | 禁用的浏览器行为 |
| --- | --- |
| `BROWSER_UI_MENU` | 默认网页右键菜单（Edge 上下文菜单） |
| `BROWSER_UI_KEYS` | 浏览器内置快捷键（如 `Ctrl+P` / `Ctrl+F` / `Ctrl+S`） |
| `BROWSER_UI_STATUSBAR` | 左下角链接悬停状态栏 |
| `BROWSER_UI_SWIPE` | 触控板双指横滑前进 / 后退手势 |
| `BROWSER_UI_AUTOFILL` | 表单自动填充提示 |

注：`F11`、`F12` 及 `Ctrl±` 缩放由窗口壳层直接接管，不受上述标志位影响。

### 2. 原生右键上下文菜单

禁用默认浏览器菜单后，可通过 `showContextMenu` 唤起基于 Win32 `TrackPopupMenu` 绘制的原生菜单。页面无法直接调用它——需要先在 IPC 服务上暴露：

```ts
// 宿主端：把菜单能力挂到扁平服务上
createIpcServer({
  service: {
    showContextMenu: (x: number, y: number, items: string) => shell.showContextMenu(x, y, items),
  },
});
```

```ts
// 页面端触发菜单
document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  await api.showContextMenu(
    Math.round(e.screenX),
    Math.round(e.screenY),
    "open|打开\nrefresh|刷新\n-\nquit|退出"
  );
});

// 页面端监听菜单点击结果
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "menu") console.log("选中菜单项 ID:", e.detail.id);
});
```

菜单项定义采用换行符分隔的字符串格式：每行格式为 `id|显示文本`，单独一行 `-` 表示分隔线。

### 3. 接收外部文件拖放

启用 `FLAG_ACCEPT_DROP` 后，窗口即可接收来自资源管理器的文件或文件夹拖放：

```ts
// 宿主端
const shell = await openShell({ url, flags: FLAG_ACCEPT_DROP });
```

```js
// 页面端接收路径列表
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "drop") console.log("拖入文件路径:", e.detail.paths);
});
```

针对管理员提权场景（High 完整性级别进程接收来自 Medium 级别资源管理器的消息），底层已通过 `ChangeWindowMessageFilterEx` 自动放行 UIPI 消息过滤。

### 4. 前端页面桌面化样式建议

窗口壳层不会向页面隐式注入任何 DOM 或全局样式。为消除「网页感」，建议应用在前端自行补充以下基础规则：

```css
html, body { cursor: default; }
body { user-select: none; }
input, textarea, .log { user-select: text; cursor: auto; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">
```

尤其建议为输入框设置 `spellcheck="false"`，否则浏览器拼写检查极易在文件路径或专业数值下绘制红色波浪线，破坏桌面应用的原生观感。

### 5. 编译为单文件可执行程序（.exe）

使用 `bun build --compile` 打包时，可通过引入 `bun-app-window/embedded` 将原生 DLL 一并内嵌至产物中：

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded";   // 将 DLL 字节内嵌至打包产物

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

提示：

- 仅通过副作用导入 `import "bun-app-window/embedded";` 同样生效。
- 打包桌面端应用时请务必添加 `--windows-hide-console` 参数，否则启动时将伴随弹出黑色命令行控制台窗口。

### 6. 两个类型检查抓不到的坑

这两条都不会让 `bun check` 变红，但都会得到一个「渲染正常、什么也不做」的窗口。

- **页面 bundle 是 ES 模块，`<script>` 标签必须写 `type="module"`。** 带顶层 `await` 的构建
  产物塞进经典 `<script>` 就是语法错，**整个脚本一行都不执行**——而页面照样渲染，因为 HTML
  是静态的。屏幕上没有任何东西指向这个原因。
- **自己的 `data-*` 选择器要给命名空间。** 标题栏的按钮用
  `data-act="minimize|maximize|close"`，并在 `document` 上挂 click 监听。宿主如果也绑
  `button[data-act]`，同一次点击会被接两遍，然后打出自己那句「未知动作：maximize」。给自己的
  属性加前缀（`data-mvp-act`）——泛化属性名是共享命名空间，不是你的地盘。

## 底层机制与交互参考

### 原生动态库加载顺序

运行时按以下优先级依次查找并加载 `libshell.dll`：

1. 显式路径：若传入 `opts.nativeLibPath`，则直接加载该路径并跳过后续推断。
2. 内嵌字节释放：若包含编译期内嵌字节，将其释放至 `%LOCALAPPDATA%\<appName>\runtime` 目录下（采用内容哈希命名，自动清理历史旧版本）。
3. 可执行文件同级目录：查找当前 `.exe` 所在目录下的 `libshell.dll`。
4. 开发态路径：依次查找包根目录下的 `.build/libshell.dll` 与 `dist/libshell.dll`。

### 内置快捷键与鼠标行为

| 触发方式 | 默认行为 |
| --- | --- |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | 页面缩放：放大一档 / 缩小一档 / 重置为 100% |
| `Ctrl + 鼠标滚轮` | 页面缩放：放大 / 缩小 |
| `F11` | 切换全屏模式（隐藏窗口边框并覆盖系统任务栏） |
| `F5` / `Ctrl + R` | 重新加载当前页面 |
| `F12` | 打开 WebView2 开发者工具 |
| `Alt + Space` / 标题栏右键 | 弹出 Windows 系统窗口菜单 |

## 开发与验证

本项目工具链基于 Bun 1.4.3 与 TypeScript 7.0.2 构建，`tsconfig.json` 开启全量严格模式检查。

**本项目不使用远端 CI。** 该账户的 GitHub Actions 因 billing lock 无法分配 runner；而项目本身是单平台、单人开发、零外部服务依赖的依赖包，远端 CI 的边际价值低于其维护成本，因此质量门禁改为本地执行。推荐入口：

```powershell
bun run scripts/gate.ts              # 对当前工作区跑三段门禁
bun run scripts/gate.ts --clean      # 同上，但在 HEAD 的干净副本里跑
```

`-Clean` 复现了托管 runner 的条件：把 `HEAD` clone 到 `%TEMP%`，按 lockfile 安装依赖，再在其中跑门禁。这样本地产物（`.build/`、`node_modules/`、`vendor/webview2/`）就无法掩盖缺失的文件。耗时约两秒。未提交改动会被提示并排除在干净副本之外——如需验证工作区现状，请去掉 `-Clean`。

门禁分三段：`bun check`、`bun test`，以及消费方验收（`scripts/verify-pack.ts`）。第三段会把 tarball 打进 `%TEMP%`，装进一个临时工程，对那个工程做类型检查，再运行 `scripts/consumer-probe.ts`——断言覆盖全部子路径、DLL 是否真从 `node_modules` 里被 `dlopen`、以及 `libInfo.source` 是否为 `package`（条数由探针自报）。离线可跑，约 0.4 秒，且默认拒绝：任何没在允许清单里登记的文件被打进包，门禁就红。只有在改动门禁自身时才用 `-SkipPack`。

底层命令仍可直接调用：

```bash
bun check          # 执行 TypeScript 类型检查
bun test           # 运行自动化测试套件（位于 tests/）
bun run demo       # 启动交互式自检示例程序（需在桌面会话下运行）
```

需要注意：`bun run demo` 与「编译为单文件可执行程序」的验收（`AGENTS.md` 中的形态 B）都需要交互式桌面，本就不具备 CI 可行性，属于构造上的本地专属项。

注意：每当修改 `src/shell/` 或 `package.json` 后，「作为外部工程依赖安装」这条链路（`AGENTS.md` 中的形态 A）已由消费方验收阶段自动覆盖——它随门禁一起跑，不需要额外记得。只剩形态 B（编译单文件 `.exe`）仍需在桌面会话下手动执行一次。

自动化测试或截图脚本若需通过 Win32 `EnumWindows` 过滤窗口句柄，请根据窗口模式匹配对应的窗口类名（Window Class）：

| 窗口模式 | 对应窗口类名 |
| --- | --- |
| 标准带边框模式（未传 `FLAG_FRAMELESS`） | `webview` |
| 无边框模式（传入 `FLAG_FRAMELESS`） | `webview_shell` |

## 致谢

- 底层跨平台窗口抽象源自 [webview/webview](https://github.com/webview/webview) `0.12.0`（MIT 许可，作者 Serge Zaitsev · Steffen André Langnes）。仓库内 `vendor/webview/` 目录为其源码原样拷贝，未作任何侵入式修改。
- WebView2 C/C++ SDK 源自 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.4258.31`（NuGet 包随仓库分发以支持离线构建），运行时由操作系统提供。
- Co-authored-by DeepSeek

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。`vendor/webview/` 目录同样遵循 MIT 许可，其原始著作权声明完整保留于对应源文件中。
