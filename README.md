# webview-shell

Windows 上用系统 WebView2 承载界面的**原生窗口壳**，给 Bun 应用用。无边框、DPI 感知、缩放边框、双向消息通道，ABI 与原生层都在你自己的代码里。

不是 Electron 的替代品，也不是应用框架：它只负责一个窗口，业务与 UI 都在壳之外。

```
你的 Bun 进程
├─ 业务逻辑（原样）
├─ 本地 HTTP + WebSocket（自己起，或用 serveOnSafePort）
└─ webview-shell  ← 开窗、几何、DPI、消息桥
        └─ libshell.dll  →  WebView2
```

## 安装

```bash
bun add webview-shell
```

要求：Windows 10/11 x64、Bun ≥ 1.4、系统已安装 WebView2 Runtime（Win11 自带）。

## 最小用法

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "webview-shell";

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

## API

`createShell(opts)` → `Promise<Shell>`，只解析原生库不开窗；`openShell(opts)` = 创建 + 启动，失败抛错。

| 成员 | 说明 |
| --- | --- |
| `start()` | 开窗，返回 `{ rc, error }`；立即返回，UI 在原生线程 |
| `post(json)` | 宿 → 页面，单向投递，不等结果 |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | 窗口操作，返回 rc |
| `drag()` | 页面 `pointerdown` → 原生拖拽（保留贴边分屏） |
| `beginResize(edge)` | 页面 `pointermove` → 边框缩放，edge 取 `RESIZE_EDGE.*` |
| `setMinSize(w, h)` | 最小尺寸，逻辑像素 |
| `state()` | `{ maximized, minimized, focused, dark, raw }` |
| `isAlive()` | 窗口是否仍存在；`state()` 无法区分「未启动」与「已销毁」 |
| `lastError()` | 最近失败原因，无错为空串（互斥读出的拷贝，不受并发写影响） |
| `show()` | 配合 `FLAG_DEFER_SHOW`：页面就绪后再显示，消除首帧闪烁 |
| `pickFolder(title?)` | 原生文件夹选择框。**同步阻塞**调用线程，需要并发请放 Worker |
| `setZoom(f)` / `getZoom()` | 页面缩放 0.25–3.0，越界自动钳制 |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | 等同 Ctrl+R / F12 / F11 |
| `stop()` | 销毁窗口，可重复调用 |
| `libInfo` | 原生库解析结果（路径、来源、sha256） |
| `symbols` | 逃生舱：直接拿 dlopen 出来的符号 |

标志位（按位或）：`FLAG_FRAMELESS`、`FLAG_TOPMOST`、`FLAG_CENTER`、`FLAG_RESIZABLE`、
`FLAG_DEFER_SHOW`、`FLAG_ACCEPT_DROP`。

### 内置的键盘与鼠标行为

窗口建好即可用，不需要应用侧接线：

| 操作 | 行为 |
| --- | --- |
| `Ctrl` `+` / `Ctrl` `-` / `Ctrl+0` | 页面缩放：上/下一档 / 复位 |
| `Ctrl+滚轮` | 同上，按滚轮方向 |
| `F11` | 全屏切换（连边框与任务栏一起让出，与「最大化」不同） |
| `F5` / `Ctrl+R` | 重新加载 |
| `F12` | 打开 WebView2 开发者工具 |
| `Alt+Space` / 右键标题栏 | 系统菜单 |
| 拖入文件/文件夹 | 需 `FLAG_ACCEPT_DROP`，见下 |

### 拖放

```ts
const shell = await openShell({ url, flags: FLAG_ACCEPT_DROP });
```

落下的路径以 shell-msg 推送：

```js
window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "drop") console.log(e.detail.paths); // ["C:\\题库"]
});
```

提权进程（High 完整性）下资源管理器属 Medium，默认收不到 `WM_DROPFILES`；壳已用
`ChangeWindowMessageFilterEx` 放行，无需调用方处理。

### 排障面（独立入口）

诊断接口不放在主入口——留在主入口等于把它们也变成契约，改一次诊断输出就成了破坏性
变更。它们随时可能变化，生产代码不应依赖：

```ts
import { debugOf } from "webview-shell/debug";

const d = debugOf(shell);
d.metrics();   // pos / win / client / work / border / round
d.dpi();       // 感知级别与缩放
d.hittest(x, y);
```

## 原生库怎么被找到

按顺序尝试：

1. `opts.nativeLibPath` —— 显式指定，跳过一切推断
2. 编译产物内嵌字节 —— 释放到 `%LOCALAPPDATA%\<appName>\runtime`，内容哈希命名，旧版本自动清理
3. 编译产物同级 —— exe 旁放 `libshell.dll`
4. 开发态 —— 包根 `build/libshell.dll` → `dist/libshell.dll`

## 打成单文件 exe

```ts
import { createShell } from "webview-shell";
import { embeddedDll } from "webview-shell/embedded";   // 关键：把 DLL 带进包

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

只写 `import "webview-shell/embedded";` 也可以——resolve 会自动从 `Bun.embeddedFiles` 里找到它。

不需要 `--windows-hide-console` 之外的特殊参数；不加会出现黑色控制台窗口。

## 页面侧

页面是普通 web 页面，跟壳的接口只有一个 JSON 通道。约定由你定，本仓的自检页给了一份参考：

```js
// 页面 → 宿
ws.send(JSON.stringify({ t: "ui", action: "drag" }));
// 宿 → 页面
window.__shellRecv = (payload) => { /* ... */ };
```

`shell.post()` 投递的文本，页面侧用 WS 或 `window.__shellRecv` 接收——**这一点由你的页面侧实现决定，壳不注入 DOM**。

## 平台与边界

- 仅 Windows x64。`libshell.dll` 预编译随包分发，不在安装期编译（很多环境禁 lifecycle scripts）。
- 需要交互式会话：服务（Session 0）里 WebView2 起不来，这是 Windows 的会话隔离，不是本项目限制。
- 提权不影响 WebView2：实测 High 完整性级别下正常，无需降权中介。
- 不支持：托盘、系统菜单、自动更新、多窗口、跨平台。要做就自己在壳外面加。

## 开发与验证

工具链对齐 `bun-ts-project-template`：Bun 1.4.3 + TypeScript 7.0.2，`tsconfig.json` 开了
`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` / `verbatimModuleSyntax` /
`erasableSyntaxOnly` / `noUnusedLocals` 等全套严格项。

门禁是原生命令，本仓不设同名脚本：

```bash
bun check          # 类型（bun >= 1.4.3 内置，与 tsc 7 同规则）
bun test           # 行为（tests/，29 例）
bun run demo       # 自检程序，需要交互式会话
```

改 `src/shell/` 或 `package.json` 后，除了两条门禁，还要跑一次「装进外部工程」的冒烟——
`bun test` 覆盖不到 `files` 清单与 `node_modules` 安装态，详见 `AGENTS.md` 的「依赖包验收」。

## 调试提示

窗口类名按模式不同，用于 `tools/capture-window.ps1 -Class <name>` 或 `EnumWindows` 过滤：

| 模式 | 类名 | 说明 |
| --- | --- | --- |
| 带边框（不传 `FLAG_FRAMELESS`） | `webview` | 由 webview 库自建顶层窗口 |
| 无边框（传 `FLAG_FRAMELESS`） | `webview_shell` | 本项目自建窗口，再以嵌入模式交给 webview |

传错类名会表现为「窗口明明在，却枚举不到」。

## 许可

MIT。
