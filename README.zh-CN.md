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
| 基于 `bun:ffi` 构建 | `bun:ffi` 在 Bun 中仍标记为实验性特性（Experimental）。官方建议生产环境优先采用 Node-API，本项目选择 `bun:ffi` 是为了换取零第三方依赖的轻量架构 |

运行环境与能力边界：

- 依赖系统 WebView2 Runtime：目标机器需已安装 WebView2 运行时（Windows 11 默认内置）。
- 要求交互式桌面会话：受 Windows 会话隔离机制限制，WebView2 无法在 Session 0（如系统服务）中启动；但实测在 High 完整性级别的管理员提权进程中可正常运行。
- 明确不包含的特性：系统托盘（Tray）、原生顶部菜单栏、自动更新、多窗口管理、跨平台支持。

## 安装

```bash
bun add bun-app-window
```

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
| `isAlive()` | 检测窗口是否存活（注：`state()` 无法区分「尚未启动」与「已销毁」状态） |
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

## 子路径模块

核心窗口控制之外的扩展能力均拆分在独立子路径下，可按需引入。

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

### `bun-app-window/titlebar` — Windows 11 风格标题栏

用于在无边框模式下快速挂载符合 Windows 11 视觉规范的自定义标题栏：

```ts
// 页面端
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
  title: "我的应用",
  icon: "/icon.svg",
  bridge: bridgeFromWindowService(api.window),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

宿主端需在 IPC 服务中暴露对应的四个窗口控制方法：

```ts
// 宿主端
createIpcServer({
  service: {
    window: {
      minimize: () => shell.minimize(),
      toggleMaximize: () => shell.toggleMaximize(),
      close: () => shell.close(),
      drag: () => shell.drag(),
    },
  },
});
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

const store = attachPlacementStore(shell, FILE);   // 定时轮询状态，窗口静止时不触发写盘
process.on("beforeExit", () => store.flush());
```

底层原生实现已妥善处理以下边界场景：

- 最大化状态下保存的是窗口「还原后的正常矩形（Restore Rect）」而非全屏尺寸。
- 跨显示器不同缩放比下的 DPI 坐标换算。
- 屏幕拓扑变化（如拔除副屏）后的屏外坐标越界校验与修正。

若无需后台轮询，也可直接调用 `capturePlacement` 与 `savePlacement` 执行单次手动读写。

### `bun-app-window/debug` — 诊断与排障接口

提供底层窗口度量与命中测试信息。注意：诊断接口不属于稳定 API 契约，后续版本可能随时调整。

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics();   // 获取 pos / win / client / work / border / round 等几何度量
d.dpi();       // 获取当前 DPI 感知级别与缩放因子
d.hittest(x, y);
```

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
// 宿主端：把菜单能力挂到 window 服务上
createIpcServer({
  service: {
    window: {
      showContextMenu: (x: number, y: number, items: string) =>
        shell.showContextMenu(x, y, items),
    },
  },
});
```

```ts
// 页面端触发菜单
document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  await api.window.showContextMenu(
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
pwsh -File scripts/gate.ps1          # 对当前工作区跑 bun check + bun test
pwsh -File scripts/gate.ps1 -Clean   # 同上，但在 HEAD 的干净副本里跑
```

`-Clean` 复现了托管 runner 的条件：把 `HEAD` clone 到 `%TEMP%`，按 lockfile 安装依赖，再在其中跑门禁。这样本地产物（`.build/`、`node_modules/`、`vendor/webview2/`）就无法掩盖缺失的文件。耗时约两秒。未提交改动会被提示并排除在干净副本之外——如需验证工作区现状，请去掉 `-Clean`。

底层命令仍可直接调用：

```bash
bun check          # 执行 TypeScript 类型检查
bun test           # 运行自动化测试套件（位于 tests/，共 108 个用例）
bun run demo       # 启动交互式自检示例程序（需在桌面会话下运行）
```

需要注意：`bun run demo` 与 `AGENTS.md` 中描述的「外部消费方验收」都需要交互式桌面，本就不具备 CI 可行性，属于构造上的本地专属项。

注意：每当修改 `src/shell/` 或 `package.json` 后，除运行上述测试外，还需执行一次「作为外部工程依赖安装」的集成冒烟测试，具体流程详见 `AGENTS.md` 中的「依赖包验收」章节。

自动化测试或截图脚本若需通过 Win32 `EnumWindows` 过滤窗口句柄，请根据窗口模式匹配对应的窗口类名（Window Class）：

| 窗口模式 | 对应窗口类名 |
| --- | --- |
| 标准带边框模式（未传 `FLAG_FRAMELESS`） | `webview` |
| 无边框模式（传入 `FLAG_FRAMELESS`） | `webview_shell` |

## 致谢

- 底层跨平台窗口抽象源自 [webview/webview](https://github.com/webview/webview) `0.12.0`（MIT 许可，作者 Serge Zaitsev · Steffen André Langnes）。仓库内 `vendor/webview/` 目录为其源码原样拷贝，未作任何侵入式修改。
- WebView2 C/C++ SDK 源自 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.1150.38`（NuGet 包随仓库分发以支持离线构建），运行时由操作系统提供。
- Co-authored-by DeepSeek

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。`vendor/webview/` 目录同样遵循 MIT 许可，其原始著作权声明完整保留于对应源文件中。
