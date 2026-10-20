# 实现事实与陷阱

记录本项目中「反直觉、且会导致重新踩坑」的事实。每条给出症状、原因、修法。
证据类别标注：`实测` = 本机验证过；`源码核实` = 从上游源码读出。

---

## 一、环境与执行面

### 1.2 窗口被遮挡时 topmost 也不生效

- **症状**：窗口存在、`IsWindowVisible=true`、DWM 扩展边框正确，但截图里看不到它，z 序显示在其它窗口下方。调用 `SetWindowPos(hwnd, HWND_TOPMOST, ...)` 与 `SetWindowLong(GWL_EXSTYLE, ... | WS_EX_TOPMOST)` 都返回成功（`ok=True, err=0`），但 `exstyle` 与 z 序完全不变。
- **原因**：本机存在 z 序锁定策略（实测无法从外部改变任何窗口的 topmost 标志）。`SetWindowPos` 返回 TRUE 并不代表 z 序真的改变了。
- **修法**：**不要试图移动窗口**。改用 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 做离屏捕获，它能拿到被完全遮挡的 WebView2 内容（见 1.3）。只在本人就在机器前需要肉眼确认时，才用 `tools/focus-helper.ps1` 最小化遮挡窗口。
- **证据**：`实测`。控制实验中 `SetWindowPos` / `SetWindowLong` / `BringWindowToTop` 三种方式全部无效，exstyle 恒为 `0x00000100`。

### 1.3 `PrintWindow` 的 flag 决定能否拿到 WebView2 内容

- **症状**：`PrintWindow` 返回 `True`，但图里只有背景色，没有页面内容。
- **原因**：不带 flag（`nFlags=0`）时，`PrintWindow` 通过屏幕合成链路取图，对 DirectComposition 渲染的 WebView2 内容无能为力。
- **修法**：必须传 `PW_RENDERFULLCONTENT`（值 2），它让窗口直接把内容渲染进给定 DC，绕过屏幕合成。
- **实测对比**（同一窗口 2000×1360，被 Open WebUI 完全覆盖）：`flag=2` 非黑像素 100%，内容完整；`flag=0` 非黑像素 5.8%，只有背景。
- **辅助纪律**：`PrintWindow` 返回 `True` 不代表图里有内容。必须采样判定（非黑像素比例），否则会把全黑图当成成功截图。

### 1.4 `Bun.serve({ port: 0 })` 可能分配到浏览器受限端口

- **症状**：窗口正常创建、`shell_start_ex` 返回 0，但页面显示 `ERR_UNSAFE_PORT`，内容区一片空白或错误页。日志里出现 `[serve] http://127.0.0.1:1720/...`。
- **原因**：Chromium / WebView2 内核内置受限端口表（`kRestrictedPorts`），对 1720、6000、1719 等端口直接拒绝连接，不发任何网络请求。`port: 0` 由系统随意分配，命中概率不高但确实存在。
- **修法**：用 `src/safe-port.ts` 的 `serveOnSafePort()`，在 40000–60000 区间随机选端口并显式排除受限表，失败重试。
- **证据**：`实测`。第一次遇到 1720（H.323 RAS），换安全端口后页面正常加载。

### 1.5 窗口无法在 Session 0 创建

- **症状**：`webview_create` 返回 `nullptr`，错误信息看似「WebView2 运行时缺失」。逐层排查会发现注册表查找、`EmbeddedBrowserWebView.dll` 加载、environment 创建全部成功，只有 `CreateCoreWebView2Controller` 失败，返回 `0x80070578`（`ERROR_INVALID_WINDOW_HANDLE`）。
- **原因**：终端工具调用运行在 Session 0（services 会话），那里没有交互式桌面。WebView2 的浏览器进程无法附着到非交互会话的窗口，只能以「无效窗口句柄」报错。
- **修法**：使承载窗口创建的进程位于 Session 1（交互式登录会话）。若工具宿主以服务形态运行，需要一条把命令派发到 Session 1 的旁路；本项目调试环境让宿主进程直接运行在登录会话中，`run_command` 子进程即为 `SessionId=1`，无需跨会话派发。若工具宿主退回服务形态，本条会复现。
- **更正（2026-10-18 实测）**：本条曾记录「提权宿主不能创建 WebView2」，实测不成立——`dist/bun-app-window.exe` 由 High 进程直接启动时 `webview_create` 成功，九点命中与最大化/还原几何全部通过；降权到 Medium 亦通过。文档原文是「cannot be run as a system user」（SYSTEM/服务会话），Session 0 的失败是会话问题。仍待验证的一点：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 等 `WEBVIEW2_*` 环境变量在提权宿主下是否被忽略（本项目的浏览器参数由代码内 environment options 传入，未走环境变量，故未受影响）。
- **证据**：`实测`。`query.exe session` 显示当前 shell 为 `services`/Session 0，`explorer.exe` 在 Session 1。

### 1.6 截图脚本必须自行声明 DPI 感知

- **症状**：截图里窗口位置明显偏离预期（例如居中的窗口看起来贴在右侧），但 `GetWindowRect` 返回的坐标是正确的。
- **原因**：DPI-unaware 进程中 `Screen.PrimaryScreen.Bounds` 返回逻辑尺寸（200% 缩放下为 1536×960），`CopyFromScreen` 按该矩形去截 3072×1920 的物理屏幕，只拿到左上角四分之一。
- **修法**：截图脚本开头调用 `SetProcessDPIAware()`（P/Invoke user32），再做 `CopyFromScreen`。
- **证据**：`实测`。修复前截图为 1536×960 且窗口偏右；修复后为 1920 宽完整截图且窗口居中。

### 1.7 `MpCmdRun.exe` 不认含 `..` 的路径

- **症状**：`MpCmdRun -Scan -ScanType 3 -File <path>` 返回 `exit=0`，输出 `Scanning ... was skipped`，实际什么都没扫。
- **修法**：传入 `(Resolve-Path $path).Path` 归一化后的绝对路径。
- **证据**：`实测`。

---

## 二、窗口与几何

### 2.1 嵌入模式下 COM 初始化责任转移给调用方

- **症状**：`webview_create(debug, hwnd)` 传自有 HWND 时返回 `nullptr`；`webview_create(debug, nullptr)` 自建窗口时正常。错误被 `api_filter` 吞成 `WEBVIEW_ERROR_INVALID_STATE`（-3），消息为空。
- **原因**：`webview` 的 `com_init_wrapper` 只在 `owns_window()` 为真时构造（即它自己创建窗口时）。传外部 HWND 走嵌入路径，不调用 `CoInitializeEx`。
- **修法**：嵌入模式下由调用方在创建窗口前执行 `CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)`，销毁后 `CoUninitialize()`。
- **证据**：`源码核实`（`win32_edge.hh` 的 `window_init`，`com_init_wrapper.hh`）+ `实测`。

### 2.2 `WM_NCCALCSIZE` 在创建期不生效

- **症状**：无边框窗口建好后 `client` 比 `window` 小 16px（@96dpi），边框仍在。
- **原因**：创建窗口时系统不采纳 `WM_NCCALCSIZE` 的返回值，仍按带边框计算客户区。
- **修法**：创建后补一次 `SetWindowPos(..., SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)` 强制重算。
- **证据**：`实测`。修复前 `win=1016x719 client=1000x680`，修复后 `win=client=1000x680`。

### 2.3 无边框窗口必须按客户区尺寸创建

- **症状**：最大化再还原后，窗口尺寸漂移（例如 `1000x680` 变成 `1016x719`）。
- **原因**：用 `AdjustWindowRectEx` 加上边框尺寸建窗后，系统按「带边框的矩形」保存还原点；当 `WM_NCCALCSIZE` 让客户区等于整个窗口时，还原点里的边框量无处安放。
- **修法**：直接以客户区尺寸 `CreateWindowExW`，不做 `AdjustWindowRectEx`。
- **证据**：`实测`。

### 2.4 创建期的 `WM_DPICHANGED` 会覆盖定位

- **症状**：调用方设置居中（`SetWindowPos` 到工作区中心）后，窗口实际出现在别处。
- **原因**：窗口创建过程会触发 `WM_DPICHANGED`，系统给出的建议矩形基于创建时的级联初始位置，无条件跟随就会覆盖调用方的定位。
- **修法**：用 `g_shown` 标志门控，只在窗口完成首次显示后才跟随建议矩形。
- **证据**：`实测`。

### 2.4b 居中必须两种窗口模式都做，且先收缩再居中

- **症状一**：带边框窗口调用 `FLAG_CENTER` 完全没反应，停在 `(343,343)` 这类级联位置。
  - **原因**：居中逻辑只写在无边框分支里（无边框是我们自建窗口，带边框是 webview 库自建窗口）。
  - **修法**：抽出 `center_on_work_area(hwnd)`，两条分支都调；带边框分支放在 `ShowWindow(SW_HIDE)` 之后，位置先定好再显示，避免显示后跳一下。
- **症状二**：居中之后水平方向对，但垂直方向贴顶（`y=0`），看起来没居中。
  - **原因**：窗口比工作区还高。900×940 逻辑像素在 200% 缩放下加边框是 1950 物理像素，工作区只有 1824；居中算出的 `y` 为负，夹取后只能贴顶。
  - **修法**：先收缩到工作区（不低于 `setMinSize` 下限）再居中。收缩是把「居中」变成可能的前提，不是可选项。
- **附带修正**：`setMinSize` 契约是逻辑像素，原生侧直接当物理像素用会让高 DPI 下最小尺寸偏小；统一走 `min_track_size()` 按 `GetDpiForWindow` 换算。
- **证据**：`实测`。修复前 `rect=(343,343) 1826x1950`；修复后 `rect=(623,56) 1826x1711`，与工作区中心一致，四边留白 623/623/56/57。

### 2.4c 启动白闪 / 闪屏：三个独立缺陷叠在一起

- **症状**：双击启动时窗口先闪一下（先整块白，再变成内容），约 200~700 ms。
- **根因一：窗口被提前显示。** `webview_set_size()` 的实现结尾是 `return window_show();`
  （`vendor/webview/.../win32_edge.hh` 的 `set_size_impl`），而 `window_show()` 里
  `ShowWindow` + `UpdateWindow` 是**同步绘制**。所以「延迟显示」实际是「先显示、再被我们藏起来」。
  - 修法：子类化要装在 `webview_set_size` **之前**，并在 `WM_SHOWWINDOW` 里用 `SWP_HIDEWINDOW`
    把来自外部的显示请求压回去（`wp == TRUE && g_defer_show && !g_shown`）。
  - 反向陷阱：**不能**为了避开它就不调 `webview_set_size`。它置位内部的 `m_is_size_set`，
    少了这一步 webview 会在消息循环里补一次默认 `640x480`，把尺寸覆盖掉（实测 client 从
    1800×1640 变成 1280×960）。
- **根因二：露出来的底色是白的。** WebView2 表面在页面首帧绘制前显示自身默认**白底**，
  实测首帧亮度 mean=236/255。窗口再怎么延后显示也没用——一显示就是白的。
  - 修法：`ICoreWebView2Controller2::put_DefaultBackgroundColor`，在 `navigate` **之前**设。
    MinGW 无 IID 符号库，用 GUID 字面量 `{c979903e-d4ca-4228-92eb-47ee3fa96eab}`（见 3.2）。
- **根因三：显示时机由固定延时决定。** `Bun.sleep(600)` 太短会露出半成品首帧
  （实测首帧亮度只有终态的 46%），太长则拖慢启动。
  - 修法：页面在两次 `requestAnimationFrame` 之后 `POST /api/ready`，宿主等这个信号再
    `shell.show()`，并留 2.5 s 超时兜底。深色模式还要在 `<head>` 内同步设 `data-theme`，
    否则首帧会按浅色算变量（深色面板里冒出白底按钮）。
- **证据**：`实测`。逐帧 `PrintWindow` 采样（不要用 `CopyFromScreen`，本机 z 序被锁、
  截图会被遮挡窗口覆盖）：修复前首帧 `mean=236`；修复后从第一帧起稳定 `mean=39`。
- **回归守护**：`tests/first-paint.test.ts`（原生侧三条顺序约束）；页面侧的
  `data-theme` 必须在 `<head>` 内、且在 `<style>` 之前——这条同样值得一个断言。

### 2.4d `wsprintfA` 没有 `%f`：浮点参数会静默变成空串

- **症状**：`shell_set_zoom(1.5)` 之后 `getZoom()` 返回 `0.25`（下限），设任何倍率都一样。
- **原因**：`wsprintfA` 是 user32 的实现，只支持 `%c` / `%d` / `%u` / `%x` / `%s`；
  `%.4f` 不被识别，输出空串，下游 `atof("")` 得 `0`，再被钳到阶梯下限。
- **修法**：跨线程传浮点改为整数编码（这里是千分数）：发送端 `int milli = factor * 1000`，
  接收端 `/ 1000.0`。要真正的格式化用 `snprintf`（ucrt），但那就别指望 user32 的轻量实现。
- **证据**：`实测`。修复前 `setZoom(1.5|0.5|99|1.0)` 全部读回 `0.25`；修复后
  依次得到 `1.5 / 0.5 / 3（钳制）/ 1`。

### 2.4e 提权进程收不到资源管理器的 WM_DROPFILES

- **症状**：`DragAcceptFiles(hwnd, TRUE)` 已调用，但把文件拖进窗口毫无反应，也没有任何错误。
- **原因**：UIPI。资源管理器是 Medium 完整性，High 完整性进程默认拒收它的窗口消息。
- **修法**：窗口建好后 `ChangeWindowMessageFilterEx` 放行三条：`WM_DROPFILES`、
  `WM_COPYDATA`、`0x0049`（`WM_COPYGLOBALDATA`，Win7 起改名后未再公开常量）。
- **证据**：`源码核实`（UIPI 规则）+ `逻辑推断`（本机无法在不提权的脚本里复现真实拖放）。

### 2.4f 键盘验证不要靠伪造前台

- **现象**：用 `keybd_event` / `SendInput` 发 `Ctrl+=`，窗口收到 0 次。
- **原因**：本机 `SetForegroundWindow` 被策略锁定（见 1.2），按键打到了别的窗口。
- **修法**：验证消息路由本身用 `SendMessageTimeoutW(hwnd, WM_KEYDOWN, vk, 0, SMTO_ABORTIFHUNG)`，
  能确定地验证「窗口过程收到并处理了」。注意这也说明一处真实限制：依赖 `GetKeyState`
  的组合键（`Ctrl+滚轮`）在非前台窗口下不会触发——这是应有行为，无需修改。
- **证据**：`实测`。`WM_KEYDOWN F11` 后窗口变为 `3072x1920`，再按一次精确回到
  `pos=776,392 win=1520x1040`，`与基线一致: True`。

### 2.4g `webview_terminate` 从宿主线程调用是静默无效

- **症状**：`shell.stop()` 之后窗口还在、`isAlive()` 仍为真；紧接着在同一个进程里
  `start()` 会报 `shell already started`。全过程没有任何错误提示。
- **原因**：vendor 的 `terminate_impl` 只有一句 `PostQuitMessage(0)`
  （`win32_edge.hh`）。`PostQuitMessage` 把 `WM_QUIT` 投给**调用线程**的消息队列——
  从宿主的 Bun 线程调用，退出消息落在一个没有消息循环的线程上，UI 线程的
  `webview_run` 永远收不到。
- **修法**：`shell_stop` 改为 `webview_dispatch(g_webview, terminate_on_ui, nullptr)`，
  让 terminate 在 UI 线程执行。实测修复后 teardown 在 50 ms 内完成，连续三轮
  start/stop 正常。
- **连带后果**：`stop()` 之后必须等 `isAlive()` 变假再 `start()`，不能只 sleep 固定时间。
  进程单例（`g_webview`）在 UI 线程退出前仍占位。
- **证据**：`实测`。修复前三轮全部 `teardown 未在 2s 内完成`；修复后三轮均 50 ms。

### 2.4h 窗口位置持久化的三个必踩点

- **最大化存错矩形**：`GetWindowRect` 对最大化窗口返回整屏尺寸。直接存下来，下次启动
  会先铺满再最大化，用户点「还原」看到的还是全屏。必须用
  `WINDOWPLACEMENT.rcNormalPosition`（实测：整屏 3072×1824，还原矩形 1426×1111）。
- **DPI 变化**：存的是物理像素。换了缩放比例不换算，同一份配置在 125% 与 200% 的
  机器上是两个大小。按 `MulDiv(w, 当前dpi, 保存dpi)` 归一（实测 1300×900@96 → 2600×1800@192）。
- **显示器不在了**：外接屏拔掉后保存的坐标可能整块在屏外。判据取「与某块工作区交叠
  至少 80×40」——够看到标题栏并抓住窗口；不满足则居中，而不是沿用坐标。
  实测 `(40000,30000)` 被纠正为 `(1136,612)`。

### 2.4i 模板字符串里的页面 JS：两道转义陷阱都只在运行时暴露

- **症状**：`bun check` 全绿，但开窗后页面白屏 / 按钮全无反应。
- **原因**：`page.ts` 把整页 HTML 写成 TS 模板字符串，里面的 JS 只有**运行时**才被
  解析。TS 类型检查看的是外层模板字符串，看不出内层 JS 的语法错。踩过两次：
  1) 模板里写 `"\n"` → 变成真实换行 → 字符串未终止
  2) 模板里写 `"\\"` → 变成单个反斜杠 → 反斜杠把后面的引号转义掉 → 字符串未终止
- **连带现象**：整块 `<script>` 都不执行，于是「30 项参数」停在「载入中…」、
  深色主题不生效、右键菜单与拖放全哑。看起来像多个功能同时坏了，其实只有一个根因。
- **修法**：模板里表示反斜杠要写 `\\\\`；模板里不要出现裸反引号（注释里的
  Markdown 代码标记 `\`id\`` 会直接终止模板字符串）。
- **守护**：`src/gui/page-script.test.ts` 用 `Bun.Transpiler` 逐个解析内联脚本块，
  把「开窗才发现」提前到 `bun test`。

### 2.4j 同版本本地 tgz 会被 Bun 缓存复用

- **症状**：改了 DLL、重新 `bun pm pack`、`bun add file:...tgz`，`node_modules` 里仍是旧
  二进制。表现为「修了但没生效」，而且哈希一比对才发现。
- **原因**：包名 + 版本号相同，Bun 认为无需重新解包（实测：`bun add` 后
  node_modules 的 DLL 942080 vs 新包 943104，哈希不同）。
- **修法**：每次改动原生库就提版号；确需同版本重装时 `rm -rf node_modules/<pkg>` 后
  `bun install --force`。验收时永远比对 `.build/` 与 `node_modules/` 的 DLL 哈希，
  不要只看「install 成功」。

### 2.5 最大化矩形不能靠 `SM_CXSIZEFRAME` 推算

- **症状**：最大化后客户区超出工作区（@192dpi 时溢出明显）。
- **原因**：最大化窗口的窗口矩形会带不可见边框，按系统边框宽度等差回缩依赖猜测，且受 DWM 边框变化影响。
- **修法**：在 `WM_NCCALCSIZE` 里用 `GetMonitorInfoW(...).rcWork` 直接覆盖 `rgba[0]`；同时在 `WM_GETMINMAXINFO` 里把 `ptMaxSize` / `ptMaxPosition` 钉到工作区。
- **证据**：`实测`。修复后 `client == work == 3072x1824`。

### 2.6 缩放边框命中需要 widget 子类化

- **症状**：鼠标移到窗口边缘没有出现缩放光标。
- **原因**：WebView2 的容器子窗口（widget）铺满整个客户区，`WM_NCHITTEST` 先落到它身上，永远返回 `HTCLIENT`。
- **修法**：`SetWindowLongPtrW(widget, GWLP_WNDPROC, ...)` 子类化，在 `WM_NCHITTEST` 里判定落在边框区域时返回 `HTTRANSPARENT`，让同一线程的父窗口接手判定。
- **证据**：`实测`。九个边缘点的命中码全部正确，中心为 `HTCLIENT`。

### 2.7 DPI 感知必须尽早声明

- **症状**：200% 缩放下整个窗口（含 WebView2 内容）被系统位图拉伸，文字发虚。
- **原因**：进程未声明 DPI 感知时，系统按 96 DPI 渲染再放大。
- **修法**：在**任何窗口创建之前**调用 `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`，失败时退回 `SetProcessDpiAwareness(1)`。宿进程若已设定，此处会失败并沿用宿主设定，属预期。
- **证据**：`实测`。声明后页面 `dpr=2`，原生 `dpi=192`。

### 2.8 最大化时应收起圆角

- **症状**：最大化后窗口四角露出桌面背景。
- **原因**：`DWMWCP_ROUND` 在最大化窗口上仍生效。
- **修法**：`WM_SIZE` 里按 `IsZoomed` 切换 `DWMWA_WINDOW_CORNER_PREFERENCE`（`DWMWCP_ROUND` / `DWMWCP_DONOTROUND`），并加状态缓存避免每次 `WM_SIZE` 都调 DWM。
- **证据**：`实测`。状态序列 `round=1 → 0 → 1`。

---

## 三、原生边界

### 3.1 `bun:ffi` 的 `dlopen` 路径必须归一化

- **症状**：`Failed to open library ... error code 126`，同一 DLL 换成绝对路径后正常。
- **原因**：含 `..` 的相对路径在 Windows 上不被接受。
- **修法**：`path.resolve()` 归一化后再传 `dlopen`。
- **证据**：`实测`。`ERR_DLOPEN_FAILED(126)` 与 ACL 无关，不要往权限方向排查。

### 3.2 MinGW 下不能用 `__uuidof(ICoreWebView2…)`

- **症状**：链接期 `undefined symbol: _GUID const& __mingw_uuidof<...>()`。
- **原因**：WebView2 的 `MIDL_INTERFACE` 未带 `__declspec(uuid)`，clang 在 MinGW 目标下会生成对 `__mingw_uuidof<T>()` 特化的引用，而该特化不存在。
- **修法**：在 `QueryInterface` 里显式给出 GUID 字面量，用 `IsEqualIID` 比较。
- **证据**：`实测`。

### 3.3 MinGW 的 DPI API 受 `WINVER` 门控

- **症状**：`use of undeclared identifier 'GetDpiForWindow'` / `'AdjustWindowRectExForDpi'`。
- **原因**：`winuser.h` 用 `WINVER` 门控这两个声明（`AdjustWindowRectExForDpi` 需 ≥ 0x0605，`GetDpiForWindow` 需 ≥ 0x0A00）。
- **修法**：在使用前定义 `WINVER 0x0A00` 与 `_WIN32_WINNT 0x0A00`。
- **证据**：`实测`。

### 3.4 不要用同步返回值承载异步结果

- **症状**：页面调用宿主函数后拿不到真实结果，或结果被当作「已收到」信号。
- **原因**：`webview_bind` 的回调返回值天生同步，而 `webview_run` 阻塞 UI 线程，异步结果无处返回。这是 webview-bun 多个长期未解 issue 的根因。
- **修法**：绑定回调只做「原样 ack」，真实结果通过 `webview_eval` 推回页面；或彻底改为页面 → 宿主走本地 WebSocket。
- **证据**：`源码核实` + 上游 issue #31 / #40 / #35。

---

## 四、打包与分发

### 4.1 `BUN_TMPDIR` 只在进程启动时读取

- **症状**：运行时设置 `process.env.BUN_TMPDIR` 后，DLL 仍被释放到 `%TEMP%`。
- **原因**：Bun 内部缓存了首次读取的值。
- **修法**：不要依赖运行时改环境变量；走自管理释放（见 ADR 0003）。
- **证据**：`实测`。外部设置生效（释放到指定目录），进程内设置无效。

### 4.2 `type: "file"` + dlopen 会把 DLL 提取到临时目录且不清理

- **症状**：`%TEMP%` 下出现 `.bun-<数字>-<hex>.dll`，正常退出后仍残留。
- **原因**：Bun 的 `resolve_embedded_file_to_buf` 把内嵌文件写到 `tmpdir`，命名为 `.bun-{uid}-{wyhash}.{ext}`，用于跨 dlopen / Worker / 重启去重，但没有退出清理。
- **修法**：见 4.3。
- **证据**：`实测`（残留）+ `源码核实`（命名与去重逻辑）。

### 4.3 `Bun.embeddedFiles` 可以完全绕过提取

- **事实**：只 `import ... with { type: "file" }` 而**不** dlopen 时，不会发生任何提取。`Bun.embeddedFiles` 能直接拿到 Blob，`await blob.arrayBuffer()` 得到原始字节。
- **修法**：从 Blob 取字节 → 自行释放到 `%LOCALAPPDATA%` → dlopen 该副本。
- **证据**：`实测`。取出的字节 SHA256 与磁盘文件一致，`MZ` / `PE` 头正确；跑完后 `%TEMP%` 无新增。

### 4.4 HTML 用 `type: "text"` 内联，不落盘

- **做法**：`import html from "./index.html" with { type: "text" }` 得到字符串常量，直接 `new Response(html)`。
- **好处**：打包后 HTML 不经过虚拟文件系统，也不产生临时文件。
- **证据**：`实测`。

### 4.5 `--windows-hide-console` 才改 PE subsystem

- **症状**：GUI 应用启动时背后跟一个黑色控制台窗口。
- **修法**：`bun build --compile --windows-hide-console`，之后 `llvm-objdump -p` 应显示 `Subsystem 00000002 (Windows GUI)`。
- **代价（容易漏）**：改成 GUI 子系统后，**同进程的 CLI 输出也一起失效**。实测：从 `cmd` 启动时继承的 stdout 句柄 `GetFileType` 仍是 2（控制台），但 `console.log` / `process.stdout.write` 既不抛错也不落地，事后 `OpenFileMapping`/`SetStdHandle` 也改不回来。双入口程序需要自己桥接——`AttachConsole(ATTACH_PARENT_PROCESS)`（无父控制台时 `AllocConsole()`）+ `WriteConsoleW(CONOUT$)`；重定向到文件或管道时不要接管，Bun 的流本来就好用。
- **证据**：`实测`。用 `ReadConsoleOutputCharacterW` 回读控制台缓冲区判定，别用截图（GUI 子系统进程的控制台画面抓不到）。

### 4.6 `type: "file"` 的路径必须严格正确

- **症状**：开发态直接报 `Cannot find module '../build/libshell.dll'`。
- **说明**：这是好事——错误在开发阶段暴露，不会留到运行时。`src/` 到仓库根是一级；`src/` 下的文件引用 `build/` 也只差一级，多退一层就会指向仓库外部。
- **证据**：`实测`。

### 4.7 签名「数学有效」不等于「受信任」

- **事实**：`SignedCms.CheckSignature(true)` 只验证 PKCS#7 签名与内容的数学一致性，不验证书链。文件完整性与信任判定由 WinVerifyTrust 负责。
- **测试要点**：
  - `Get-AuthenticodeSignature` 对未受信任根返回 `UnknownError` + `CERT_E_UNTRUSTEDROOT`（`0x800B0109`）。
  - 篡改 `.text` 一个字节后返回 `HashMismatch`，这是签名真正起作用的证明。
  - 篡改后 PKCS#7 的 `CheckSignature(true)` 仍为 VALID，因为签名的是「签名时刻的 PE 摘要」，不是磁盘当前内容。篡改判定以 `HashMismatch` 为准。
- **自签证书安装**：写入 `CurrentUser\TrustedPublisher` 可成功；写入 `CurrentUser\Root` 需要管理员权限，普通权限下报「不支持该请求」。
- **证据**：`实测`。

---

## 五、工具链陷阱

### 5.1 PowerShell 函数返回 `byte[]` 会被展开

- **症状**：生成的 ICO 只有 125 字节（应为 17 KB），`System.Drawing.Icon` 解析失败。
- **原因**：PowerShell 函数返回数组时会被展开为 `Object[]`，交给 `BinaryWriter.Write` 会绑定到错误重载，只写出 1 字节。
- **修法**：函数内 `return , [byte[]]$bytes`，调用处再 `[byte[]](...)` 强制转换；或改用 `List[byte[]]` 显式持有。
- **证据**：`实测`。

### 5.2 元数据工具不在 PATH 时不代表缺失

- **事实**：本机没有 `signtool.exe` / `osslsigncode` / `jsign`。`Set-AuthenticodeSignature` 走同一个 WinTrust 引擎，可完整验证签名流程。
- **说明**：需要正式签名（含时间戳、硬件令牌）时仍需 Windows SDK 的 Signing Tools 或云端签名服务。
- **证据**：`实测`。

---

## 六、已确认的运行时行为基线

供后续对比回归：

| 项 | 值（本机，200% 缩放） |
| --- | --- |
| 逻辑工作区 | 1536×912 |
| 物理工作区 | 3072×1824 |
| 窗口边框厚度 | 96dpi 下 8px，192dpi 下 13px |
| 初始窗口（请求 1000×680） | `pos=536,232 win=client=2000×1360` |
| 最大化 | `win=3098×1850 client=3072×1824` |
| 还原 | 回到 `pos=536,232 win=client=2000×1360` |
| 边缘命中 | 九点分别为 13/12/14/10/1/11/16/15/17 |
| `FLAG_CENTER`（请求 900×820，带边框） | `pos=623,56 win=1826×1711`，四边留白 623/623/56/57 |
| 单文件 exe 体积 | 约 92.6 MiB（Bun 运行时占绝大部分） |
| DLL 体积 | 约 913 KB |
| 签名开销 | 约 7.2 KB |
