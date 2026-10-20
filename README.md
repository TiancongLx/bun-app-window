# bun-app-window

Windows 上用系统 WebView2 承载界面的原生窗口壳，供 Bun 应用使用。

只负责窗口：开窗、几何、DPI、边框、消息通道。业务逻辑与 UI 都在壳之外。

---

**English** — A native window shell for Bun on Windows. Your web UI runs in the
system WebView2 runtime (no bundled browser); window control, DPI-aware geometry,
typed IPC and a Windows 11 title bar are exposed to TypeScript over `bun:ffi`.

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS } from "bun-app-window";

const server = serveOnSafePort({ fetch: () => new Response("<h1>Hello</h1>") });
await openShell({ url: `http://127.0.0.1:${server.port}`, flags: FLAG_FRAMELESS });
```

---

## 采用前请先读这三条

| 事实 | 后果 |
| --- | --- |
| 仅 Windows x64 | `os` / `cpu` 字段会直接拒绝为其他平台安装。包名的平台中立是预留，不是能力 |
| 发布的是 TypeScript 源码 | 必须使用 Bun ≥ 1.4.3。Node.js 装得上，跑不了 |
| `bun:ffi` 在 Bun 中标注为 experimental | Bun 官方建议生产环境改用 Node-API，本项目的取舍是换取零第三方依赖 |

另有两条运行前提：需要交互式桌面会话（Session 0 的服务里 WebView2 起不来），系统需已安装 WebView2 Runtime（Win11 自带）。

## 安装

```bash
bun add bun-app-window
```

## 最小用法

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

shell.post(JSON.stringify({ t: "ready" }));   // 宿 → 页面
shell.setTitle("Doing work…");
```

`createShell(opts)` 只解析原生库、不开窗；`openShell(opts)` 是创建并启动，失败抛错。

## API

| 成员 | 说明 |
| --- | --- |
| `start()` | 开窗，返回 `{ rc, error }`。立即返回，UI 在原生线程 |
| `stop()` | 销毁窗口，可重复调用 |
| `post(json)` | 宿 → 页面，单向投递，不等结果 |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | 窗口操作，返回 rc |
| `drag()` | 页面 `pointerdown` → 原生拖拽（保留贴边分屏） |
| `beginResize(edge)` | 页面 `pointermove` → 边框缩放，edge 取 `RESIZE_EDGE.*` |
| `setMinSize(w, h)` | 最小尺寸，逻辑像素 |
| `show()` | 配合 `FLAG_DEFER_SHOW`：页面就绪后再显示 |
| `state()` | `{ maximized, minimized, focused, dark, raw }` |
| `isAlive()` | 窗口是否仍存在。`state()` 无法区分「未启动」与「已销毁」 |
| `lastError()` | 最近失败原因，无错为空串 |
| `pickFolder(title?)` | 原生文件夹选择框。同步阻塞调用线程 |
| `setZoom(f)` / `getZoom()` | 页面缩放 0.25–3.0，越界自动钳制 |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | 等同 Ctrl+R / F12 / F11 |
| `setBrowserUi(mask)` | 关闭浏览器行为，取 `BROWSER_UI_*` 按位或 |
| `showContextMenu(x, y, items)` | 弹原生上下文菜单，见下 |
| `libInfo` | 原生库解析结果（路径、来源、sha256） |
| `symbols` | 逃生舱：直接访问 dlopen 出来的符号 |

标志位（按位或）：

| 标志 | 作用 |
| --- | --- |
| `FLAG_FRAMELESS` | 自建无边框窗口，标题栏由页面绘制 |
| `FLAG_RESIZABLE` | 可缩放 |
| `FLAG_CENTER` | 启动时居中到工作区，两种窗口模式都生效 |
| `FLAG_TOPMOST` | 置顶 |
| `FLAG_DEFER_SHOW` | 创建后不显示，等 `show()` |
| `FLAG_ACCEPT_DROP` | 接受文件/文件夹拖放 |
| `FLAG_START_MAXIMIZED` | 首次出现即最大化，无中间帧 |

## 子路径入口

主入口之外的能力放在独立子路径，按需引入。

### `bun-app-window/ipc` — 类型化调用与事件

宿主与页面共享一份类型声明，客户端用泛型在编译期校验：

```ts
// api.ts —— 宿主与页面 import 同一个文件
export type Api = { greet(name: string): string };
export type Events = { windowState: { maximized: boolean } };
```

```ts
// 宿主
import { createIpcServer } from "bun-app-window/ipc";

const ipc = createIpcServer({
  service: { greet: (name: string) => `Hello ${name}` },
});

serveOnSafePort({
  fetch(req) { /* 页面与鉴权 */ },
  websocket: {
    open: (ws) => ipc.attach(ws),
    message: (ws, raw) => ipc.handle(ws, raw),
    close: (ws) => ipc.detach(ws),
  },
});

ipc.emit("windowState", { maximized: false });   // 主动推送
```

```ts
// 页面
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada");                        // string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

`connect` 从页面 URL 的 `?t=` 取 token 连 `/ws`。要接到别处就传 `url` 或现成的 `channel`。

### `bun-app-window/titlebar` — Win 11 标题栏

```ts
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
  title: "我的应用",
  icon: "/icon.svg",
  bridge: bridgeFromWindowService(api.window),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

对应的宿主服务需要四个方法：

```ts
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

拖拽走 `shell.drag()`，由原生发 `WM_NCLBUTTONDOWN HTCAPTION`，贴边分屏与双击最大化均保留。

配色与尺寸全走 CSS 变量（`--ws-tb-*`），覆盖即可换肤。按钮字形默认用几何符号；`icons: "fluent"` 走 Segoe Fluent Icons，该字体缺失时会显示成豆腐块。

### `bun-app-window/state` — 窗口位置持久化

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE);   // 轮询，静止时不写盘
process.on("beforeExit", () => store.flush());
```

原生侧已处理最大化存还原矩形、DPI 换算、屏外坐标校验三种情况。一次性读写用 `capturePlacement` / `savePlacement`，不需要开定时器。

### `bun-app-window/debug` — 排障面

诊断接口不属稳定契约，随时可能变化：

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics();   // pos / win / client / work / border / round
d.dpi();       // 感知级别与缩放
d.hittest(x, y);
```

## 常见任务

### 关掉浏览器行为

WebView2 默认是浏览器语义。桌面应用通常全关：

```ts
import { BROWSER_UI_ALL } from "bun-app-window";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

| 位 | 关掉的东西 |
| --- | --- |
| `BROWSER_UI_MENU` | 默认右键菜单（Edge 菜单） |
| `BROWSER_UI_KEYS` | `Ctrl+P` / `Ctrl+F` / `Ctrl+S` |
| `BROWSER_UI_STATUSBAR` | 左下角悬停状态栏 |
| `BROWSER_UI_SWIPE` | 触控板横滑前进/后退 |
| `BROWSER_UI_AUTOFILL` | 表单自动填充 |

`F11` / `F12` / `Ctrl±` 由壳自己处理，不受影响。

### 右键菜单

关掉默认菜单后，右键需应用提供：

```ts
// 页面
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  shell.showContextMenu(Math.round(e.screenX), Math.round(e.screenY),
    "open|打开\nrefresh|刷新\n-\nquit|退出");
});

window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "menu") console.log("选中", e.detail.id);
});
```

`items` 用行描述，`id|label` 每行一项，单独 `-` 是分隔线。菜单由 Win32 `TrackPopupMenu` 绘制。

### 拖放

```ts
const shell = await openShell({ url, flags: FLAG_ACCEPT_DROP });
```

```js
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "drop") console.log(e.detail.paths);
});
```

提权进程下资源管理器属 Medium，壳已用 `ChangeWindowMessageFilterEx` 放行。

### 页面侧建议

壳不注入 DOM，这三条要应用自己做：

```css
html, body { cursor: default; }
body { user-select: none; }
input, textarea, .log { user-select: text; cursor: auto; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">
```

拼写检查会给路径与数值标红波浪线，是最容易暴露「这是个网页」的一条。

### 打成单文件 exe

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded";   // 把 DLL 带进包

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

只写 `import "bun-app-window/embedded";` 也可以。不加 `--windows-hide-console` 会出现黑色控制台窗口。

## 原生库怎么被找到

按顺序尝试：

1. `opts.nativeLibPath` —— 显式指定，跳过一切推断
2. 编译产物内嵌字节 —— 释放到 `%LOCALAPPDATA%\<appName>\runtime`，内容哈希命名，旧版本自动清理
3. 编译产物同级 —— exe 旁放 `libshell.dll`
4. 开发态 —— 包根 `.build/libshell.dll` → `dist/libshell.dll`

## 内置的键盘与鼠标行为

| 操作 | 行为 |
| --- | --- |
| `Ctrl+` / `Ctrl-` / `Ctrl+0` | 页面缩放：上/下一档 / 复位 |
| `Ctrl+滚轮` | 同上 |
| `F11` | 全屏（连边框与任务栏一起让出） |
| `F5` / `Ctrl+R` | 重新加载 |
| `F12` | 开发者工具 |
| `Alt+Space` / 右键标题栏 | 系统菜单 |

## 平台与边界

- 仅 Windows x64。`libshell.dll` 预编译随包分发，不在安装期编译。
- 需要交互式会话：Session 0 里 WebView2 起不来，属 Windows 会话隔离。
- 提权不影响 WebView2：实测 High 完整性级别下正常。
- 不支持：托盘、系统菜单、自动更新、多窗口、跨平台。

## 开发与验证

工具链：Bun 1.4.3 + TypeScript 7.0.2，`tsconfig.json` 开启全套严格项。门禁为原生命令，不设同名脚本：

```bash
bun check          # 类型
bun test           # 行为（tests/，103 例）
bun run demo       # 自检程序，需要交互式会话
```

改 `src/shell/` 或 `package.json` 后还要跑一次「装进外部工程」的冒烟，见 `AGENTS.md` 的「依赖包验收」。

窗口类名按模式不同，`EnumWindows` 过滤或截图脚本要用对应值：

| 模式 | 类名 |
| --- | --- |
| 带边框（不传 `FLAG_FRAMELESS`） | `webview` |
| 无边框（传 `FLAG_FRAMELESS`） | `webview_shell` |

## 致谢

平台层为 [webview/webview](https://github.com/webview/webview) `0.12.0`（MIT，Serge Zaitsev · Steffen André Langnes）。`vendor/webview/` 是其原样拷贝，未做源码改动。

WebView2 SDK 来自 [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.1150.38`（NuGet 包随仓库分发供离线构建）。Runtime 由系统提供。

Co-authored-by DeepSeek

## 许可

MIT，见 [LICENSE](./LICENSE)。`vendor/webview/` 亦为 MIT，其著作权声明保留在原文件中。
