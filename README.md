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

### 让它像原生应用而不是网页

WebView2 的默认设置是**浏览器**语义。这不是缺陷——对浏览器是对的，对桌面应用
每一条都是「这是个网页」的破绽。壳提供两件事把它掰回来。

#### 1. 关掉浏览器行为

```ts
import { openShell, BROWSER_UI_ALL } from "webview-shell";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

| 位 | 关掉的东西 | 不关的话 |
| --- | --- | --- |
| `BROWSER_UI_MENU` | 默认右键菜单 | 右键出现「重新加载 / 检查 / 另存为 / 打印 / 翻译成中文 / Web 捕获」 |
| `BROWSER_UI_KEYS` | 浏览器快捷键 | `Ctrl+P` 打印网页、`Ctrl+F` 查找、`Ctrl+S` 保存网页 |
| `BROWSER_UI_STATUSBAR` | 悬停状态栏 | 鼠标划过任何元素左下角跳出链接地址 |
| `BROWSER_UI_SWIPE` | 触控板滑动导航 | 横滑会前进/后退，整页被替换 |
| `BROWSER_UI_AUTOFILL` | 表单自动填充 | 输入框弹出历史值下拉、密码保存提示 |

运行中也可切换：`shell.setBrowserUi(mask)`。

`F11` 全屏、`F12` 开发者工具、`Ctrl±` 缩放不受这项影响——它们由壳自己处理，
不是 WebView2 的浏览器快捷键。

#### 2. 用原生菜单替掉默认右键菜单

关掉默认菜单后右键就成了「点了没反应」，那也不像原生应用。原生应用的右键是有
菜单的，只是菜单属于应用：

```ts
// 页面
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  fetch("/api/menu", {
    method: "POST",
    body: JSON.stringify({
      x: Math.round(e.screenX),
      y: Math.round(e.screenY),
      items: "open|打开题库\nrefresh|刷新\n-\nquit|退出",
    }),
  });
});

window.addEventListener("shell-msg", (e) => {
  if (e.detail.t === "menu") console.log("选中", e.detail.id);
});
```

菜单本身是 Win32 的 `TrackPopupMenu`：跟随系统主题、支持键盘导航、带阴影、
贴边自动翻向。`items` 用行描述，`id|label` 每行一项，单独 `-` 是分隔线。

壳不做 JSON 解析——只切分字符串，所以页面不必担心跨进程传结构的兼容性。

#### 3. 页面侧还剩三件事

壳管不到 DOM，这三条要应用自己做：

```css
/* 光标：网页默认 I 形，桌面应用是箭头 */
html, body { cursor: default; }
/* 选择：整块文字可拖选是网页特征；输入区与日志要留出选择能力 */
body { user-select: none; }
input, textarea, .log { user-select: text; cursor: auto; }
/* 焦点环：鼠标点进来不该出现，Tab 过来才该有 */
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

输入框还要关掉拼写检查与自动填充：

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">
```

拼写检查会给路径与数值标红波浪线——这是最容易被忽略、也最能暴露「这是网页」的一条。

### 窗口位置持久化（独立入口）

库主体有一条硬约束：`index.ts` 不引入副作用。持久化按定义就是副作用，所以它是
**显式调用**的可选件，放在 `webview-shell/state`——不调用就不会有任何文件产生。

```ts
import { openShell } from "webview-shell";
import { attachPlacementStore, loadPlacement, restorePlacement } from "webview-shell/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, width: 900, height: 700, flags: FLAG_DEFER_SHOW });

// 启动时恢复（没有记录就保持默认）
const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

// 运行期跟踪位置；静止时不写盘
const store = attachPlacementStore(shell, FILE);
process.on("beforeExit", () => store.flush());
```

原生侧已处理三个跨会话必踩点，调用方不需要关心：

| 情况 | 处理 |
| --- | --- |
| 用户最大化后关闭 | 存「还原后」的矩形，不是整屏尺寸 |
| 缩放比例变了 | 按 DPI 比例换算尺寸 |
| 外接屏拔掉 / 分辨率变了 | 坐标与某块工作区交叠不足 80×40 则在屏内居中 |

`attachPlacementStore` 是轮询（默认 700 ms）：宿主拿不到原生→回调的通道，
而 `GetWindowRect` 是微秒级。窗口静止时不产生任何写入（内容比对），
写入用「临时文件 + 改名」保证原子——避免关闭时被强杀留下半截 JSON。

只需要一次性读写时用 `capturePlacement` / `savePlacement`，不需要开定时器。

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
