# 实现事实与陷阱

记录本项目中「反直觉、且会导致重新踩坑」的事实。每条给出症状、原因、修法。
证据类别标注：`实测` = 本机验证过；`源码核实` = 从上游源码读出。

---

## 一、环境与执行面

### 1.2 窗口被遮挡时 topmost 也不生效

- **症状**：窗口存在、`IsWindowVisible=true`、DWM 扩展边框正确，但截图里看不到它，z 序显示在其它窗口下方。调用 `SetWindowPos(hwnd, HWND_TOPMOST, ...)` 与 `SetWindowLong(GWL_EXSTYLE, ... | WS_EX_TOPMOST)` 都返回成功（`ok=True, err=0`），但 `exstyle` 与 z 序完全不变。
- **原因**：本机存在 z 序锁定策略（实测无法从外部改变任何窗口的 topmost 标志）。`SetWindowPos` 返回 TRUE 并不代表 z 序真的改变了。
- **修法**：**不要试图移动窗口**。改用 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2)` 做离屏捕获，它能拿到被完全遮挡的 WebView2 内容（见 1.3）。只在本人就在机器前需要肉眼确认时，才手动最小化遮挡窗口。
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
- **修法**：用 `src/shell/port.ts` 的 `serveOnSafePort()`，在 40000–60000 区间随机选端口并显式排除受限表，失败重试。
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
- **守护**：历史上由 `src/gui/page-script.test.ts` 用 `Bun.Transpiler` 逐个解析内联脚本块，
  把「开窗才发现」提前到 `bun test`。`src/gui/` 已随 UI 层改为 `src/ui/index.html`
  静态文件而整体移除，因此这个特定失效模式当前不存在——**但若将来又把 HTML 写回
  TS 模板字符串，必须同时恢复这条守护**，否则同一类错误会重新变成「开窗才发现」。

### 2.4j 同版本本地 tgz 会被 Bun 缓存复用

- **症状**：改了 DLL、重新 `bun pm pack`、`bun add file:...tgz`，`node_modules` 里仍是旧
  二进制。表现为「修了但没生效」，而且哈希一比对才发现。
- **原因**：包名 + 版本号相同，Bun 认为无需重新解包（实测：`bun add` 后
  node_modules 的 DLL 942080 vs 新包 943104，哈希不同）。
- **修法**：每次改动原生库就提版号；确需同版本重装时 `rm -rf node_modules/<pkg>` 后
  `bun install --force`。验收时永远比对 `.build/` 与 `node_modules/` 的 DLL 哈希，
  不要只看「install 成功」。

### 2.4k 宿主事件通道：四个只有真窗口才会暴露的错

G2 之前，宿主要知道窗口状态只能轮询。做「环形队列 + 拉取」这条通道时踩到四个
**门禁全绿但功能哑掉** 的点：

- **带边框模式的窗口不在 `shell_wnd_proc` 的消息链上**。那个 WndProc 只注册给
  `webview_shell` 窗口类（由 `create_own_window()` 创建），只服务 `FLAG_FRAMELESS`。
  带边框窗口由 webview 库创建，只有 `toplevel_proc` 的子类化在它的链上。
  于是「在 `push_state()` 旁边加入队点」这种最自然的写法，会让**默认配置**永远
  收不到尺寸与最大化事件，而 `bun test` 全绿、`bun check` 全绿。两个 WndProc 都要有。
- **`shell_poll_events` 不能像别的导出那样 `if (!g_webview) return -1`**。`CLOSED`
  恰好在 `g_webview = nullptr` 之后产生，早退会让宿主持久读不到「窗口已关闭」，
  表现为 `stop()` 一直等到 5 s 超时。这一条与「没窗口就该报错」的直觉相反，
  必须在注释里写死理由——否则下一个人会当成缺陷「修正」掉。
- **快照与写盘必须分开**。位置持久化最初打算「收到事件 → 防抖到点 → 再去 `getBounds()`」。
  那样会丢：窗口一销毁，`format_bounds()` 里 `!g_hwnd` 直接返回 0 长度文本，
  防抖到点读到的就是空串。用户「拖完立刻点 X」正好命中这个窗口期。正确做法是
  事件到达时**立刻**取快照（微秒级 FFI 读），只把写盘推迟到停手后。
- **pump 的定时器要不要 unref，取决于它是不是唯一让进程活着的东西**。只为持久化
  用时 unref（不该因为一个定时器挂住退出）；靠它等 `CLOSED` 时必须 ref——unref 的
  定时器不撑事件循环，而「await 一个永不兑现的 promise」也撑不住，宿主会在窗口
  还开着的时候直接退出，表现是「启动后立刻结束、窗口一闪而过」。

**双向验证（本轮实测）**：把 `emit_event(SHELL_EVENT_STATE, ...)` 注掉重编，
`scripts/probe-window-events.ts` 从 21/21 绿变成 11/21 红、`exit=1`，且 CLOSED 相关的
10 项仍绿（因为只注掉了 STATE，隔离正确）；还原重编后 21/21 绿，
`verify-dll.ts` 的 sha256 回到原值 `bae872d7…`（构建确定性）。这一步值得每次都做：
它同时证明了「探针真的能看见缺失」和「构建可复现」。

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

### 2.9 窗口创建成功但永远不可见：第一次 `ShowWindow` 被 STARTUPINFO 覆盖

- **症状**：窗口确实建好了，`FindWindow` 能找到，几何、命中测试、最大化、`PrintWindow`
  截图**全部正常**——调用 `IsWindowVisible` 却恒为假，`WS_VISIBLE` 位从未置上。
  `pickTarget` 会跳过它，于是 `capture-window` 报「target window not found」。
- **原因**：`ShowWindow` 的**第一次**调用不读我们传的 `nCmdShow`。父进程若以
  `STARTF_USESHOWWINDOW` + `wShowWindow = SW_HIDE` 创建本进程，Windows 用
  STARTUPINFO 里的值代替参数。于是 `ShowWindow(hwnd, SW_SHOW)` 实际执行的是「隐藏」。
  第二次调用起才恢复正常。
- **为什么难发现**：它不触发任何现有断言。窗口存在 → `metrics` 正常；`PrintWindow`
  对隐藏窗口同样能抓到内容；`toggleMaximize` 也照常工作。自检读的是这些，全绿。
  只有「肉眼 / `IsWindowVisible`」能看出差别。2026-10-21 之前一直被误判成
  「`HOLD` 模式不 show」，实际与 `HOLD` 无关——是**启动器**的差别。
- **对照实验（决定性）**：同一份 `src/host.ts`，
    - `Start-Process -WindowStyle Hidden` → 12 次采样全 `WS_VISIBLE=False`（6 秒）
    - `Start-Process`（默认） → 1000 ms 时 `WS_VISIBLE=True`
  代码、参数、环境完全相同，只有启动器的 STARTUPINFO 不同。
- **修法**：`show_now()` 里 `ShowWindow` 之后调 `force_visible()`——先查
  `IsWindowVisible`，不可见就再 `ShowWindow` 一次，仍不可见则用
  `SetWindowPos(..., SWP_SHOWWINDOW)` 兜底（`SWP_SHOWWINDOW` 不读 `nCmdShow`，
  不受 STARTUPINFO 影响）。带边框模式同样要调：那条路的显示由 webview 自己的
  `window_show()` 完成，而它也是本进程的第一次 `ShowWindow`。
- **判据**：`tests/first-paint.test.ts` 的两条静态断言。注意它们跑在**剔掉整行注释**
  的源码上——第一版没剔，双向验证时把调用注释掉仍然绿，护栏形同虚设。
- **证据**：`实测`。库里加 `force_visible()` 后，`-WindowStyle Hidden` 启动
  500 ms 内 `WS_VISIBLE=True`；OTT 起的 demo 也能被 `capture-window` 在 162 ms
  内直接找到（此前要等 6 秒超时后失败）。

### 2.10 状态推送重复一次：首次显示不该跳过变化检测

- **症状**：页面启动日志里出现**两条字段完全相同**的 `win-report`，
  `maximized:false`、尺寸、dpi 全都一样。`host.log` 显示两条相隔 **1 ms**。
- **为什么不是节流**：16 ms 节流窗口内被拦下的推送会挂定时器补齐，那不可能
  在 1 ms 内完成。1 ms 的间距说明是两条**独立**的路径。
- **根因**：`show_now()` 末尾调了 `push_state(force=true)`，而当时的 `force`
  是个 `bool`，它同时跳过「变化检测」与「16 ms 节流」两道闸。可 `ShowWindow()`
  内部会**同步**触发 `WM_SIZE`，那一次已经走 `push_state()`（非 force）把显示后的
  真实状态推了出去。于是末尾这次强制推送又把同样的内容发了一遍。
- **为什么改一处不够**：第一次修复只把 `force` 拆成三级 `PushMode`，但把
  `show_now()` 归到了最宽松的 `BypassAll`——于是重复依旧。三级拆分本身是对的
  （`flush_push_state` 确实只该跳过节流），错的是 `show_now()` 的归类。
- **修法**：`show_now()` 改用 `BypassThrottle`。语义正好：万一 `WM_SIZE` 那次
  被节流吃掉，这一发补上；已经推过则变化检测拦住。`BypassAll` 只留给
  「尺寸可能恰好相同、但状态确有外部变化」的场景（全屏切换 / 恢复矩形）。
- **判据**：`tests/first-paint.test.ts` 的「首次显示用 BypassThrottle」。
  **不要只看页面截图判断**——`host.log` 里 `win-report` 的毫秒数才是判据，
  截图只能看出「有两条」，看不出它们是不是同一毫秒。
- **证据**：`实测`。修前 2 条 `maximized:false`（相隔 1 ms）；修后 1 条
  `maximized:false` + 1 条 `maximized:true`（后者是真实状态变化）。

### 2.11 「声明了但没接线」：241 行代码写完却从未生效

- **症状**：外部导航拦截的整套实现（`NavigationGuard` / `NewWindowGuard` /
  `open_external()` / `install_nav_guard()` / `uninstall_nav_guard()`）全部就位、
  注释详尽，但 `install_nav_guard()` **全仓零调用点**。安全债一分未还，而
  类型检查、`bun test`、`bun check` 全绿。
- **三个缺陷各自独立、叠在一起才致命**：
    1. `install_nav_guard()` 没有调用点 —— 守卫从未注册。
    2. `SHELL_FLAG_ALLOW_EXTERNAL_NAV = 128` 枚举有、**没有任何解析处**；
       TS 侧连对应常量都没有，所以调用方**无法表达**这个意图。
    3. `g_origin` 的注释写着「由 `shell_start_ex` 从 `g_url` 算出」，
       而赋值语句一句都没有 —— 恒为空串。
  前两条足以让守卫不装；即使补上调用，第 3 条也会让
  `if (g_allow_external_nav || g_origin.empty()) return;` 立刻提前返回。
- **最刺眼的一条**：`NavEventBase` 定义了引用计数与 `QueryInterface` 的公共实现，
  但 `NavigationGuard` / `NewWindowGuard` **都没有继承它**。也就是说这 241 行
  **从未通过编译**——`error: use of undeclared identifier 'add_ref'` 一次就把
  真相说穿了：写完之后一次 `bun run build:native` 都没跑过。
- **为什么现有断言抓不到**：静态断言习惯写成「标识符是否存在」
  （`toContain("install_nav_guard")`），而定义本身就让这条通过。真正该断言的是
  **调用点与赋值点的存在性**，以及**两端取值的一致性**。
- **修法**（`tests/nav-guard.test.ts` 逐条钉住）：
    - `install_nav_guard();` 必须有调用，且位置在 `webview_navigate` **之前**；
    - `uninstall_nav_guard();` 必须有调用，且在 `webview_destroy` **之前**；
    - `g_allow_external_nav = (flags & SHELL_FLAG_ALLOW_EXTERNAL_NAV) != 0` 这种
      赋值形态必须在（枚举定义不算解析）；
    - `g_origin = url_origin(...)` / `g_app_doc = strip_fragment(...)` 必须是赋值；
    - TS 与 C++ 两侧 `FLAG_*` 逐位一致，且**反向**断言「C++ 有的 TS 都得有」。
- **反向断言的必要性**：正向（「TS 有的 C++ 必须有」）抓不到本次的形态——
  本次正是 **C++ 先行、TS 缺失**。只有反向断言会红。
- **证据**：`源码核实` + `实测`。补接线后 `bun run build:native` 首次报出
  6 个编译错误（`NavEventBase` 未继承，以及多重继承下 `QueryInterface` 必须
  回填**接口子对象**地址而非 `NavEventBase` 子对象地址）。

### 2.12 探针自己的判据会撒谎，而且撒两次

- **背景**：验证外部导航拦截时写了一个一次性探针：本地服务提供 index / other /
  external 三页，页面自驱导航并回传 `location.href`。
- **第一处伪判据**：在静态断言里写了
  `expect(body).toContain("some_placeholder() === undefined")` —— 一个恒假的
  占位表达式。它不会红，因为它压根不是断言，只是「看起来在检查」。**写了就
  立刻删掉，不要想着「以后替换」。**
- **第二处伪判据**：双向验证时想用「系统浏览器是否回连 external.html」判断
  `open_external` 是否被调用。但 webview 内导航过去时 external.html 也会打同一个
  `/report` 端点，**两者无法区分** —— 于是「没拦住」和「拦住并外开」给出同样的
  信号，判据恒真。
- **正确的判据形状**：「拦截生效」时页面不会被卸载，所以 `after-external` 这条
  report **会**出现（且 href 未变）；「拦截失效」时 index 页被卸载，那条
  `setTimeout` 永远不执行，`after-external` **根本不会出现**。
  所以**「缺失」才是走过去的证据**，不是「变成新地址」。第一版判据按「变成新地址」
  写，注入故障后拿到 `(none)` 却判成「原因不相干」，差点把双向验证判成失败。
- **教训**：`goto` 类导航的失败信号是**下游动作消失**，不是「值变成别的」。
  设计探针时先问「如果这一步发生，我期望看到什么」和「如果没发生，什么会消失」，
  两者的差集才是判据。
- **证据**：`实测`。双向验证：基线 PASS → 注释掉 `install_nav_guard();` → FAIL
  且 `after-external` 缺失 → 还原 → PASS 且 `bun test` 全绿。

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

### 3.5 `FFIType.buffer` 枚举抛 `invalid ABI type`，必须用字符串标签

- **症状**：`dlopen` 时抛 `bun:ffi: invalid ABI type`，堆栈指向描述符里的 `args` 数组；同一份声明改成字符串就正常。
- **原因**：`FFIType` 枚举常量与字符串标签走两条不同的映射路径。Bun 1.4.3 上字符串那条（`"buffer"`）被实现，枚举那条（`FFIType.buffer`）没有。
- **修法**：凡是 `buffer` / `buffer_length`，**一律写字符串**。

    ```ts
    // 会炸
    { args: [FFIType.buffer, FFIType.u32], returns: FFIType.i32 }
    // 正常
    { args: ["buffer", "u32"], returns: "i32" }
    ```

- **陷阱在哪**：`ffi.d.ts` 的 `FFITypeToArgsType` 明确声明了 `[FFIType.buffer]: NodeJS.TypedArray | DataView`，所以 **`bun check` 会放行**，运行时才炸。类型声明超前于实现，编译器替不了运行期验证。
- **证据**：`实测`。23 项类型矩阵扫描（1.4.3 / Windows 10.26300）：`i8`…`u64_fast`、`ptr`、`pointer`、`cstring`、`bool`、`char` 全部 OK；`FFIType.buffer` 与 `FFIType.buffer_length` 作为 args/returns 一律 FAIL，而字符串 `"buffer"` / `"buffer_length"` 作为 args 均 OK（作为 returns 被合理拒绝）。
- **迁移影响**：`src/shell/native.ts` 全程只用 `ptr` / `i32` / `u64` 等不涉及 buffer 的类型，因此未受此缺陷影响。新写 FFI 声明时要避开。

### 3.6 `bun:ffi` 不做参数校验：传错就段错误，不是异常

- **症状**：进程直接消失，输出 `panic(main thread): Segmentation fault at address 0x0` + `oh no: Bun has crashed`，没有 JS 异常可捕获。
- **原因**：`dlopen` 只按声明搬运字节，不校验语义。给需要结构体指针的参数传 `null`，就是让 native 代码解引用空指针。
- **修法**：
    - 每个新写的 FFI 调用，**先用最小输入验证**（能 dlopen + 能取符号），再逐步加字段
    - 结构体不要「照着文档一次性写完」，一段字段一次验证
    - 涉及结构体的调用放进独立子进程跑，崩了不影响主流程
- **证据**：`实测`。`WinVerifyTrust(INVALID_HANDLE, null, null)` 在 Bun 1.4.3 / Windows 10.26300 上直接段错误。
- **推论**：这条规则对「诊断脚本」尤其重要。诊断脚本本该在出问题时帮忙，结果自己崩了，会把排障引向错误方向。

### 3.7 Windows HANDLE 不能用 `ptr`，且 `u64` 与 `u64_fast` 有不同的坑

- **症状**：
    - 句柄值看着「能用」，但跨函数传递时行为诡异
    - 或拿到 `bigint` 却当成 `number` 用，得到 `TypeError`
    - 或**手写 `typeof x === "number"` 判空，把有效句柄误判成 0**
- **原因**（三层）：
    1. 文档明文——HANDLE 不是虚拟地址，`ptr` 不代表它
    2. `"u64_fast"` **不是**合法的字符串 FFIType（`FFITypeStringToType` 里没有它），只能用枚举 `FFIType.u64_fast`
    3. `u64_fast` 作为 `returns` 推导为 `number | bigint`，而**运行时返回哪个不确定**——同一个 API 连续两次调用可能给出不同类型
- **修法**：
    - HANDLE（`HCERTSTORE`、`HWND`、`HICON`、`HMODULE`、`HDC`…）一律用 `FFIType.u64_fast`
    - **所有句柄返回值必须过一个归一化函数**（`native/win32.ts` 的 `toHandle`），绝不手写 `typeof` 判断
    - 需要完整 64 位精度时用 `FFIType.u64`，但每次传参要 `Number()` 或保持 `bigint`
- **证据**：`实测`。
    - `CertOpenSystemStoreW` 用 `u64_fast` → `typeof=number handle=2394227355136`
    - `GetDesktopWindow` 用 `u64` → `typeof=bigint hwnd=65548`
    - `CreateCompatibleDC` 两次调用分别返回 `number 1694568820` 与 `bigint 18446744073676065759n` —— **同一个 API、同一个声明，返回类型不同**
    - 因为手写了 `typeof hdcRaw === "number" ? BigInt(hdcRaw) : 0n`，后者被当成 `0n`，导致 `extract-icon` 整整排查了一轮
- **附带**：符号在哪个 DLL 必须查，不能凭印象。`DestroyIcon` 与 `DrawIconEx` 都在 `user32.dll`，写进 `gdi32.dll` 会报 `Symbol "..." not found`。`实测`。

### 3.8 `EnumWindows` 的回调可以用迭代替代

- **事实**：`EnumWindows` / `EnumChildWindows` 需要 C→JS 回调（`JSCallback`），而
  `GetTopWindow(0)` + `GetWindow(h, GW_HWNDNEXT)` 是**纯迭代**的等价写法，
  枚举结果集合相同、顺序相同，且不引入回调对象的生命周期管理。
  子窗口用 `GetWindow(h, GW_CHILD)` + 同样的 `GW_HWNDNEXT` 逐层展开。
- **为什么值得这么做**：`AGENTS.md` §5 第 5 条禁的是「前端页面的 C→JS 回调」，
  理由是 `webview_run` 阻塞 UI 线程而 `JSCallback` 依赖空闲 JS 线程。
  诊断脚本没有这个前提，但避开回调仍然是划算的——少一个失败面，
  且不需要处理「回调里抛错怎么办」。
- **必须加止损**：窗口链异常成环时迭代会挂死。`listTopLevelWindows` 用 `max` 参数
  （默认 4000）兜底，`childWindowsOf` 用 2000。`实测`。

### 3.9 FFI 参数少一个：调用照样返回成功，只是什么都没做

- **症状**：`DrawIconEx` 返回 `true`，不报错、不抛异常，但目标位图一个像素都没变。
- **原因**：函数有 9 个参数，初版只声明了 8 个，漏掉第 8 个 `hbrFlickerFreeDraw`。
  于是 `diFlags` 收到的是 `istepIfAniCur` 的值（0），画图请求被静默忽略。
  `bun:ffi` **按声明搬运参数，不校验元数**——多一个少一个都不会报错。
- **修法**：
    - 每个 Win32 声明都要**逐个参数对照官方签名写注释**（本仓 `native/win32.ts` 的做法）
    - 涉及「有输出但输出为空」的 API，先用最小输入验证（画一个已知颜色的点，读回来）
    - `pitfalls` 3.6 说的是「参数错会段错误」，这一条是它的反面：**参数错也可能完全静默**
- **证据**：`实测`。修正后 `extract-icon` 从「返回 94 字节纯黑 PNG」变成
  「2160 字节、中心 `A254 R22 G26 B34`、四角 `A0`」——与 `make-icon` 画进去的
  品牌底色完全对应。

### 3.10 符号在哪个 DLL：`user32` 与 `gdi32` 的边界比想象中模糊

- **症状**：`Symbol "DrawIconEx" not found in "gdi32.dll"` / `Symbol "DestroyIcon" not found in "shell32.dll"`
- **原因**：图标相关 API 的名字里带 "Icon"，直觉上归 `shell32` 或 `gdi32`，
  实际都在 `user32.dll`。截图/绘图相关的 `PrintWindow` 也在 `user32`，
  而 `CreateDIBSection` / `SelectObject` / `DeleteObject` 才在 `gdi32`。
- **修法**：写声明前用 `llvm-objdump -p <dll> | grep <name>` 或
  `GetProcAddress` 核实，不要按命名猜。本仓的 `native/win32.ts` 与
  `native/gdi.ts` 按「实际所在 DLL」分组，不按语义分组。
- **证据**：`实测`。本项目在两个 DLL 之间搬动过三个符号。

### 3.11 `Bun.deflateSync` 产出 raw deflate，不是 zlib —— PNG 的 IDAT 因此不合规

- **症状**：自家编码器产出的 PNG，**三个解码器给出两个答案**：
    - `System.Drawing` 打开正常
    - 自写解码器 + `Bun.inflateSync` 解压正常
    - `Bun.Image`（libspng）/ litellm 上游校验 → `ERR_IMAGE_DECODE_FAILED`
- **更阴的一层**：`Bun.Image.metadata()` **仍然成功**。文档明说它「只读 header」，
  不解压 IDAT。于是表现为「尺寸对、格式对、就是打不开」——无从下手。
- **原因**：`Bun.deflateSync` 与 `zlib.deflateRawSync` 逐字节相同，输出的是
  **raw deflate**；而 PNG 规范要求 IDAT 是 **zlib 包装**（RFC 1950：`0x78` 头 + adler32 尾）。
  解码侧用 `Bun.inflateSync`（与编码器同源）正好 raw 对 raw 能解开，把这个缺陷掩盖了。
- **判据**：IDAT 首字节必须是 `0x78`；解压必须用 `node:zlib` 的 `inflateSync`
  （严格要求 zlib 包装），**绝不能用 `Bun.inflateSync`**，否则判据形同虚设。
  见 `tests/png.test.ts` 的「IDAT 是 zlib 格式」与 `native/png.ts` 的模块注释。
- **修法**：`import { deflateSync } from "node:zlib"`（Bun 内建的 node 兼容模块，
  不是外部 node 运行时，符合「不调用 node 可执行文件」的约束）。
- **证据**：`实测`。
    - `Bun.deflateSync(64 字节)` → `73 74 ...`（6 字节），与 `zlib.deflateRawSync` 相同
    - `zlib.deflateSync(同样输入)` → `78 9c ...`（12 字节）
    - 自家 PNG 的 IDAT 头：`ec dd ff 4f`；PowerShell 产出的：`78 5e`（正确）
    - 改用 `node:zlib` 后，同一张图的 `Bun.Image.resize()` 从
      `ERR_IMAGE_DECODE_FAILED` 变成 `OK -> 400x250`
- **教训**：「多个解码器都说 OK」不等于合规——**要确认其中至少有一个是严格的**。
  这里两个宽容解码器（一个同源、一个 .NET）挡住了唯一说真话的那个。

### 3.12 图片成本的真判据是**字节数**，不是 token —— 而且要裁不要缩

- **先厘清两层的成本**：
    - 模型侧：每图最多 **1024 tokens**，超过部分被规范化掉（`1300×1300` 等效封顶）
    - 宿主侧：Open WebUI 把历史消息留在后端内存里，图片作为 base64 **在之后每一轮被反复携带**
  **真正的滚雪球是后者**：一张 47 KB 的图，base64 后 62 KB，20 轮就是 1.2 MiB 常驻；
  十张图、几十轮，后端内存就是这么涨上去的。
- **实测胖瘦**（2000×1360 的真实窗口截图）：

    | 路线 | 字节 | base64 | 20 轮驻留 |
    | --- | --- | --- | --- |
    | truecolor png 全尺寸 | 143,013 | 190,684 | 3.6 MiB |
    | jpeg q82 全尺寸 | 139,761 | 186,348 | 3.6 MiB |
    | **palette png 全尺寸** | **46,567** | **62,092** | **1.2 MiB** |
    | jpeg q82 缩到 1024 | 49,292 | 65,724 | 1.3 MiB |
    | **裁剪 800×600 + palette** | **24,125** | **32,168** | **0.6 MiB** |

- **两个反直觉结论**：
    1. **`palette: true` 比 jpeg 还小**（47 KB vs 140 KB）。UI 截图颜色高度重复，
       256 色索引 PNG 几乎无损，而 jpeg 的 DCT 在这种图上效率更差。
       `dither: false` 是关键——抖动引入高频噪点，反而更大更脏。
    2. **裁剪后不要再缩**。实测把 800×600 的裁剪结果再缩到 640×480，
       字节从 24,125 **涨到** 38,149。原因是重采样插值产生了原图没有的中间色，
       256 色调色板的量化效率随之下降。**缩放是负优化**。

- **因此的默认策略**（`tools/capture-window.ts`）：
    - `--crop x,y,w,h` 优先：只输出关心的那一块，**1:1 不缩放**，文字不糊
    - `--max-edge` 默认 **0**（不缩）
    - `--format` 默认 **`png`**、`--level` 默认 **6** —— 编码路线与拐点的取舍见 3.14
    - 输出里直接报 `outBytes` 与 `outBase64Bytes`，让成本一眼可见

- **对 Computer Use 的意义**：每一步「看图 → 决策 → 操作」都要一张截图。
  若每步 24 KB、走 50 步，就是 1.2 MiB 常驻——**低成本是这条路能不能走通的前提**，
  不是优化项。裁剪让「看清局部」和「省字节」同时成立，这是它优于缩放的根本原因。
- **证据**：`实测`。上表全部来自对同一张真实窗口截图的编码测量；
  `palette` 相对 `png`/`jpeg` 的差值在 640/800/1024/1280/2000 五个尺寸上都一致成立。

### 3.13 `Bun.Image` 没有 `crop`，裁剪要在拿到原始像素的那一层做

- **事实**：`Bun.Image` 的链式方法只有 `resize` / `rotate` / `flip` / `flop` / `modulate`
  与格式方法 `jpeg` / `png` / `webp` / `heic` / `avif`。**没有 `extract` / `crop`**。
- **做法**：在我们的 `captureWindow` 里，`CreateDIBSection` 拿到的就是 BGRA 原始指针，
  裁剪只是一次逐行 `memcpy`（`native/gdi.ts` 的 `cropBgra`），零 FFI 开销。
  **顺序是「先裁再编码」**：一旦交给 `Bun.Image`，像素已经变成不透明对象，切不动了。
- **判据**：`cropBgra` 把矩形钳制到图像范围内，越界返回 `null` 而不是给一张畸形图；
  `--crop` 的负数与零尺寸在参数解析阶段就抛错（`parseCrop`）。
- **证据**：`实测`。API 形状经 `bun.d.ts` 与 `docs/runtime/image.mdx` 双向核实。

### 3.14 PNG 编码路线：自家编码器胜过 `Bun.Image`，level 6 是拐点

- **背景**：`capture-window` 一度统一走 `Bun.Image` 编码，理由是「它支持 palette」。
  实测之后这个理由只对 palette 成立——**truecolor PNG 交给它纯属亏本**。
- **实测**（3098×1850 真实窗口 / 800×600 裁剪，5 次取中位数）：

    | 路线 | 全窗 ms / KiB | 裁剪 ms / KiB |
    | --- | --- | --- |
    | 自家 `encodePng` level 1 | 22.0 / 617 | 3.2 / 90 |
    | 自家 `encodePng` level 3 | 30.7 / 429 | 5.1 / 67 |
    | **自家 `encodePng` level 6** | **39.0 / 392** | **6.0 / 62** |
    | 自家 `encodePng` level 9 | 186.2 / 353 | 23.6 / 54 |
    | `Bun.Image` png（默认级别） | 458.3 / 531 | 40.0 / 84 |
    | `Bun.Image` png `compressionLevel: 1` | 420.9 / 836 | 36.1 / 119 |
    | `Bun.Image` jpeg q85 | 23.8 / 406 | 4.0 / 67 |
    | `Bun.Image` palette 256 | 2590.7 / 180 | 198.2 / 32 |

- **三条结论**：
    1. **`Bun.Image` 的 PNG 全面劣于自家编码器**：慢 7–12 倍，而且**更大**
       （531 vs 392 KiB）。它要先解码再重采样再编码，而我们是 BGRA 直编。
    2. **level 6 是拐点**：比 1 只慢约 3 ms 却小 31%，比 9 快 4 倍只大 13%。
       level 9 只适合一次性归档——逐帧截图用它是拿 5 倍延迟换 13% 体积。
    3. **裁剪不该改变编码路线**。早先的条件里带了 `|| cropped`，等于裁剪后再绕
       `Bun.Image` 一次解码 + 重编码：实测 50 ms / 84 KiB，而自家直接编
       6 ms / 62 KiB。**裁剪是像素操作，与编码器无关。**
- **端到端复验**（真实窗口 + CLI 全流程，含 Bun 启动与 `PrintWindow`，3098×1850）：

    | 命令 | 字节 | base64 | 端到端 ms |
    | --- | --- | --- | --- |
    | `--level 1` | 704,353 | 939,140 | 148 |
    | 默认（level 6） | 439,347 | 585,796 | 170 |
    | `--level 9` | 411,366 | 548,488 | 330 |
    | `--crop 700,300,800,600` | **50,836** | 67,784 | 170 |

    两条可以直接引用的结论：**level 9 多花一倍时间只省 6%**；
    **裁剪把 429 KiB 压到 50 KiB（−88%）**，token 估算从 1024 降到 291。
- **判据**：`--format png` 时一次 `Bun.Image` 都不应被构造；只有 `--max-edge > 0`
  （要重采样）或 `--format` 为 palette / jpeg / webp 时才走它。
  回归断言在 `tests/tooling.test.ts` 的「默认不缩、png、level 6」与
  「`--crop` 不改变编码路线」。
- **证据**：`实测`。编码耗时表由一次性 bench 脚本产出（用毕即删，同一张真实
  窗口截图连跑 5 次取中位数）；端到端数字来自 `tools/capture-window.ts` 的真实调用。

### 3.15 `Bun.Image.resize(w)` 只限宽，不限「长边」

- **语义**（`bun-types/docs/runtime/image.mdx`）：

    ```
    resize(800)                             // width 800, keep aspect ratio
    resize(800, 600)                        // exactly 800×600（拉伸）
    resize(800, 600, { fit: "inside" })     // fit within 800×600
    ```

- **踩法**：把「长边上限」写成 `resize(maxEdge, undefined, { withoutEnlargement: true })`。
  横图看起来完全正确，**竖长图的长边根本没被限制**——`300×600` 传 `maxEdge=100`
  得到 `100×200`，像素数是期望值的 4 倍，token 估算与字节数一起虚高。
- **修法**：`resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })`。
  两个方向都要给：`fit: "inside"` 负责等比适配，`withoutEnlargement` 负责小图不放大。
- **判据**：`tests/model-image.test.ts` 用竖长图（300×600）断言缩完是 `50×100`，
  且 `estimatedTokens` 与**实际产物尺寸**一致。**只测横图抓不到这个 bug。**
- **证据**：`实测`。第一版实现在 300×600 上返回 12 tokens 而非 3。

### 3.16 自己实现降采样：面积平均胜过 `Bun.Image` 的 lanczos3（快 2.1 倍且小 2.2 倍）

- **背景**：`--max-edge` 一度只能交给 `Bun.Image`，形不成「原始 BGRA → 缩放 → 编码」
  全自家链路。实测之后发现交给它不但慢，**而且更大**。
- **实测**（真实窗口 3098×1850 → 1300×776，5 次取中位数）：

    | 路线 | ms | 字节 |
    | --- | --- | --- |
    | **`downscaleBgra` + 自家编码** | **45.9** | **102,036** |
    | `Bun.Image` resize + png | 95.9 | 222,621 |

- **为什么快**：`Bun.Image` 的输入是 PNG，所以它必须**先编码再解码**才能缩放；
  我们手里是 `CreateDIBSection` 的 BGRA 原始指针，那一步压根不用付。
- **为什么小（这条反直觉）**：它默认 `lanczos3`，那是**锐化**滤波器，在文字边缘
  产生振铃（亮暗过冲）。那些高频细节让 DEFLATE 更难压。面积平均天然平滑，
  对 UI 截图既无振铃又更好压——**快的那个同时更小，因为对的算法两头都省**。
- **前缀和版本反而更慢**：同算法试过「每行一次前缀和、输出做减法」，51.3 ms，
  对比朴素区间累加的 39.1 ms。多一遍完整 O(sw) 扫描 + 更大的中间缓冲，
  缓存局部性变差。**在这个尺寸下，朴素区间累加才是对的。**
- **alpha 必须加权**：直接平均会让透明像素的 RGB（通常为 0）混进来，圆角与阴影
  边缘出现黑边。`make-icon.ts` 产出的图标就有透明圆角。
  实现：检测全不透明时走快路径（像素精确），否则按 `Σ(b·a)/Σa` 加权。
- **只降不升**：`dw > sw` 或 `dh > sh` 返回 `null`，让调用方退回避不开插值的
  `Bun.Image`。放大需要滤波器，平均做不到。
- **判据**：`tests/resample.test.ts`。其中「含透明像素时不能出现黑边」用
  2×2 → 1×1 的构造（一黑全透明 + 三白不透明）钉死：正确答案是白色 alpha 191，
  错误答案（直接平均）是灰色 191。
- **`Bun.Image` 仍然不可替代**：解码任意格式、放大、`rotate`/`flip`/`modulate`、
  palette 量化、jpeg / webp 编码。收窄之后的判定条件是「**缩小 + png**」两条同时
  成立才走自家，其余仍交给它。
- **证据**：`实测`。

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

### 4.8 入库的二进制可能悄悄变陈旧，而门禁不会红

- **背景**：本仓把 `dist/libshell.dll` 纳入版本控制（消费方 `bun add` 时不该需要
  clang 与 WebView2 头文件，`ADR 0010`）。代价是它可能与源码脱节：改了
  `native/shell.cc` 却忘了 `bun run build:native`。
- **为什么门禁抓不到**：测试加载的是**仓库里那份 DLL**。旧 DLL 的 33 个导出符号
  也都在，`native-surface.test.ts` 照样全绿；`resolve.test.ts` 比的是 `.build`
  与 `dist` 的一致性，两者是同一份陈旧产物时同样绿。结果是一个与源码不一致的
  二进制被发布出去，行为差异只在运行期以「莫名其妙」的形式出现。
- **判据为什么不能写「字节相同」**：clang 在 COFF 头写链接时刻，另有一处 4 字节
  字段由它派生，所以同一份源码两次构建永远差 8 个字节。实测（用
  `SOURCE_DATE_EPOCH` 造两个相差 11 年的时刻）：

    ```
    差异偏移：0x80 0x81 0x82 0x83 0x6b204 0x6b205 0x6b206 0x6b207
    ```

  即 `0x80..0x83`（TimeDateStamp）与 `0x6b204..0x6b207`（时间派生字段）。
- **正确判据**：用两个不同的 `SOURCE_DATE_EPOCH` 各编一次，两次产物的差异集合
  就是「时间派生字节」全集；把入库版这些偏移对齐后，必须与全新构建**逐字节相同**。
  集合**不写死**——它是 clang 版本与链接布局的函数，写死会在升级工具链时假红。
- **实现**：`scripts/verify-dll.ts`（约 5 秒）。不进默认门禁：比整条门禁还慢，
  属于「改原生层之后、提交之前」的动作，已写进 `AGENTS.md` §8 收尾清单。
- **最危险的失效模式**：`SOURCE_DATE_EPOCH` 不生效时，两次构建字节完全相同，
  「差异集合」为空，于是无论入库的是什么都会判通过。工具对这种情况**主动判失败**
  并说明原因，`tests/verify-dll.test.ts` 有一条专门钉住它。
- **副作用要还原**：重建会覆盖 `.build/libshell.dll`，而 `resolve.test.ts` 断言
  它与 `dist` 是同一份产物。工具在结束时把入库那份拷回去，否则它自己就成了
  「门禁为什么红了」的原因。
- **实验设计上的两个坑**（都踩过）：
    1. 第一次把产物输出到 `libshell.verify.dll`，比官方路径长 7 个字符，而路径被
       嵌进产物 → 36,688 字节「看似不同」，其实是整体位移。**必须用同一输出路径**。
    2. 第一次只等 1 秒让两次构建的 TimeDateStamp 不同，结果只变了低字节，
       漏掉了高字节位置。要覆盖 4 字节字段的全部位，时间差得足够远——或者直接用
       `SOURCE_DATE_EPOCH` 固定它。
- **证据**：`实测`。双向验证：基线 `VERIFY-DLL PASSED`；把 `dist/libshell.dll`
  中部翻一个字节 → `VERIFY-DLL FAILED` 并精确报出 `差异偏移：0x72d00`；
  `git checkout` 恢复 → 重新 PASSED 且该字节回到原值。

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

### 5.3 函数内调用外部命令会污染返回值，导致门禁"失败报通过"

- **症状**：`gate.ps1` 里 `bun check` 明明输出 `Found 2 errors`、`rc=1`，脚本却打印 `GATE PASSED` 并以退出码 0 结束。**一个失败却报成功的门禁，比没有门禁更危险。**
- **原因**：与 5.1 同源。PowerShell 函数的**所有输出**都会进入返回值管道，不只是 `return` 的那一个值：
    ```powershell
    function Invoke-Gate {
        & bun check          # 输出进了管道
        if ($LASTEXITCODE -ne 0) { return $false }
        return $true
    }
    $ok = Invoke-Gate        # 拿到的是 @(<bun 的全部输出...>, $false)
    if ($ok) { ... }         # 非空数组在布尔上下文恒为 $true
    ```
    调用方得到的不是 `$false`，而是「一批字符串 + `$false`」组成的数组，非空数组被判为真。
- **修法**：让外部命令的输出**不进入管道**，二选一：
    - `& bun check 2>&1 | Out-Host`（推荐，输出仍实时可见）
    - `$out = & bun check 2>&1`（需要程序化处理输出时）
- **验证方式**（这类"守护脚本"必须用失败场景验证，否则不可信）：
    - 注入类型错误 → 必须 `exit 1`
    - 注入失败测试 → 必须 `exit 1`
    - 本次两种场景均实测确认修复生效。
- **证据**：`实测`（2026-10-20，`scripts/gate.ps1` 首版实测复现并修复）。
- **延伸**：`Write-Host` 不进入管道（写的是主机流），所以日志用 `Write-Host` 是安全的；危险的是**裸调用外部命令**和 `Write-Output`。
- **适用范围**：本条只对仓库里残留的 `.ps1` 成立。`gate.ts` 之后新写的 TS 脚本不存在「函数输出混进返回值」这个语义，`Bun.spawn` 的 `exited` 也是每次调用绑定的值，因此不受影响。

### 5.4 npm registry 写入后立即读取可能拿到旧值

- **症状**：`PUT https://registry.npmjs.org/<pkg>` 返回 `HTTP 200`，紧接着 `GET` 同一地址却读不到刚写入的字段，`_rev` 也还是旧值——看起来像写入失败。
- **原因**：registry 的 GET 走 CDN 缓存，写入生效与缓存失效之间有窗口期。
- **修法**：加时间戳参数绕过缓存再判定，例如 `?t=<unix-ms>`，或加 `Cache-Control: no-cache` 头。**不要因为第一次读到旧值就重试 PUT**——写入其实已经成功了，重试只会制造无意义的 `_rev` 递增。
- **判据**：以 `_rev` 是否变化为准（写入成功会递增），比字段内容更早反映真实状态。
- **证据**：`实测`（2026-10-20，弃用 `bun-app-window@0.0.0-stage` 时复现）。

### 5.5 构建前置脚本的判据必须等于它实际依赖的文件

- **症状**：新机器 clone 后跑 `native/fetch.ps1` 直接失败，报 `git clone failed: 128`；而 `vendor/webview` 明明就在仓库里、内容完整。紧跟其后的 SDK 解压步骤永远不执行，`vendor/webview2` 一直是空的。
- **原因**：判据写的是「`vendor/webview` 下有没有 `.git`」，而入库的拷贝是**无 `.git` 的纯文件拷贝**（145 个文件，`mode 100644`）。于是 `Test-Path .git` 恒为假，脚本每次都尝试 clone 到一个非空目录，`git` 返回 `128`，`throw` 在第 1 步就把流程掐断。
    - 同源问题还有一处：`$Force` 只作用于后两步，源码那一步完全不看它——想强制重拉上游只能手删目录。
    - 附带风险：即便 clone 成功，留下的 `.git` 会让父仓库多出一个嵌套仓库，`git status` 的语义随环境而变（与 `.gitignore` 第 4 行「不依赖用户环境的全局配置」同一个取向冲突）。
- **修法**：判据换成构建脚本自己校验的那三个文件（`webview.h` / `EventToken.h` / `WebView2.h`），缺哪个补哪个；联网动作（clone 上游、下载 nupkg）改为显式开关，默认路径全程离线（现在由 `native/fetch.ts` 承担，开关是 `--webview` / `--sdk`）。clone 后剥掉 `.git`，与入库状态保持同构。
- **验证**（四种目录状态各跑一次，均在 `-Root` 隔离目录内进行）：不完整 → `exit 1` 并指路 `-Webview`；缺 SDK 但 nupkg 在 → `exit 0` 且离线解压出 927,399 B 的头文件；三份齐备 → `exit 0` 且文件数不变；目录整个不存在 → 走 clone 分支。
- **证据**：`实测`（2026-10-20）。`git clone` 到非空目录返回 `128`、clone 到空目录返回 `0`，两者均为实测。
- **适用范围**：`native/fetch.ts` 的 `decideWebview` / `decideSdk` 已把四种目录状态的决策抽成纯函数，由 `tests/fetch.test.ts` 覆盖；`INPUTS` 与 `native/build.ts` 共享同一份常量定义，判据不会再分叉。本条作为「为什么这么设计」的由来保留。

### 5.6 PowerShell 的 `Set-Content` 会静默改写换行符

- **症状**：用 PS 脚本批量改一个 `.ps1` 再「回滚」，`git diff` 显示内容完全相同，但 `git status` 仍报 `M`，且 `git` 警告 `CRLF will be replaced by LF the next time Git touches it`。文件的实际字节已经从 LF 变成 CRLF。
- **原因**：`Set-Content` / `Out-File` 在 Windows 上默认用 `[Environment]::NewLine`（即 CRLF）写盘，**不保留原文件的 EOL**。而本仓 `.gitattributes` 固化 LF，于是「内容没变但文件变了」。
    - 同理，`Add-Content` 追加内容时也会引入 CRLF 段。
    - 这条在 TS 侧不存在：`write_file` / `Bun.write` 保留原编码与 EOL，Node 的 `writeFileSync` 写的是调用方给的字节。
- **修法**：PS 脚本要改文件时显式指定——`Set-Content -NoNewline` 配 `[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))`，或者干脆用 TS 改文件。回滚后用 `git diff --stat` 确认，再用逐字节扫描复核（见验证）。
- **验证**：写一个 40 行的逐字节扫描器，统计每个文件的 `CR LF` 相邻对；一次性验证脚本跑完后全仓应为 0。
- **证据**：`实测`（2026-10-20，冒烟验证 `.ps1` 语法门禁时污染了 `scripts/install-hooks.ps1`，内容 diff 为空但 EOL 已变）。
- **适用范围**：仓库里剩下的 `.ps1` 只做签名与验签，不负责改写仓库文件，因此不受本条影响（数量以门禁摘要的 `PS1 SYNTAX OK (N files)` 为准，不写死）。凡是**写文件**的脚本都应当是 `.ts`——`writeFileSync(path, text, "utf8")` 写的是调用方给的字节，不做 EOL 转换。

### 5.7 Git 的 `sh` 与 pwsh 是两个环境：`tar` 和 `import.meta.main` 都会变

`pre-push` 钩子跑在 Git 自带的 `sh` 里，其 PATH 与 pwsh 不同。同一份脚本在 pwsh 里全绿、在钩子里红，是真实发生过的。

**（a）`tar` 会解析成 GNU tar，把盘符当主机名**

- **症状**：钩子里跑门禁，第三段报 `tar (child): Cannot connect to C: resolve failed`。
- **原因**：`Bun.which("tar")` 在钩子环境里解析到 `C:\Program Files\Git\usr\bin\tar.exe`，那是 **GNU tar 1.35**；它把 `C:/...` 解析成 `host:path` 远程语法。pwsh 里同一行代码解析到 `C:\Windows\System32\tar.exe`（bsdtar），认盘符，所以本地一直绿。
- **修法**：两层防护，缺一不可——(1) win32 下优先用 `%SystemRoot%\System32\tar.exe`；(2) 传**相对文件名 + `cwd`**，而不是绝对路径。只做第一条，换个环境仍可能解析错；只做第二条，其它带冒号的场景仍会翻车。
- **证据**：`实测`（2026-10-20，首次在 `pre-push` 里跑新门禁时命中；`/usr/bin/tar --version` = GNU tar 1.35，对 `C:/...` 复现同一报错）。

**（b）`bun run <path>` 可能让 `import.meta.main` 变成 false**

- **症状**：`bun run scripts/gate.ts` 在 Git 的 `sh` 里（cwd 以大小写不同的形式进入）**无任何输出、退出码 0**——门禁什么都没跑却报成功。
- **原因**：`bun run` 保留调用方 cwd 的字面大小写（`_repositories`），而 `import.meta.path` 是真实路径（`_Repositories`）；`import.meta.main` 因此为 `false`。入口被 `if (import.meta.main)` 挡掉。实测三种组合：pwsh 里 `bun run` → true；Git 的 `sh` 里 `bun run`（cwd 小写）→ false；Git 的 `sh` 里 `bun` 直跑 → true。
- **修法**：入口判据改成「或」关系——`import.meta.main` 为真，**或者** `argv[1]` 与自身路径在规范化（解析 + 正斜杠 + 小写）后相等。见 `scripts/lib/entrypoint.ts` 的 `isEntrypoint()`。
- **踩的第二层坑**：第一版把判定写成无参函数、在 helper 模块内部读 `import.meta.main` / `import.meta.path`。但 `import.meta` 是**模块作用域**的——在被 import 的模块里 `main` 恒为 `false`、`path` 恒指向 helper 自己。于是函数恒返回 `false`，把三个脚本的入口全挡掉，同样是静默退出 0。**守护逻辑自己成了故障源。** 结论：这类判定必须是纯函数、两个值都由调用方传入，并且必须被测试钉住（`tests/entrypoint.test.ts`）。
- **证据**：`实测`（2026-10-20）。

---

### 5.8 判断「当前模块是不是入口」不能用 import.meta.main 单独决定，也不能把它写在 helper 里

- **症状**：某个 TS 脚本在 pwsh 下正常、在 `pre-push` 钩子里**零输出、退出码 0**，什么都不做却报成功。
- **原因（两层）**：
    1. `bun run <path>` 保留调用方 cwd 的**字面大小写**（`_repositories`），而 `import.meta.path` 是真实路径（`_Repositories`）。两者只差大小写，`import.meta.main` 就变成 `false`，入口被 `if (import.meta.main)` 挡掉。
    2. 第一版修复把判定写成无参函数、在 helper 模块内部读 `import.meta.main` / `import.meta.path`。**`import.meta` 是模块作用域的**——在被 import 的模块里 `main` 恒为 `false`、`path` 恒指向 helper 自己。函数恒返回 `false`，把三个脚本的入口全挡掉，同样静默。
- **修法**：判定写成纯函数 `isEntrypoint(moduleMain, modulePath, argv1?)`，两个值由调用方传入：`import.meta.main` 为真，**或者** `argv[1]` 与 `modulePath` 在规范化（解析 + 正斜杠 + 小写）后相等。
- **教训**：守护逻辑自身必须被测试。`tests/entrypoint.test.ts` 里专门有一条「守卫不能恒为假」——上一版正是恒为假。
- **证据**：`实测`（2026-10-20）。三种调用组合：pwsh 里 `bun run` → true；Git 的 `sh` 里 `bun run`（cwd 小写）→ false；Git 的 `sh` 里 `bun` 直跑 → true。

### 5.9 .NET / Node 的相对路径按**进程 cwd** 解析，不跟 PowerShell 的 Location

- **症状**：`cd` 到仓库目录后，用 `[System.IO.File]::ReadAllBytes('AGENTS.md')` 读到的大小与 `Get-Item` 报的差一半；一度以为文档被截断，实际是读到了另一个位置的文件。
- **原因**：PowerShell 的 `cd`（`Set-Location`）只改变 **PowerShell 的 Location**，不改变进程工作目录。而 `.NET` 的 `File.*`、Node 的 `process.cwd()` 以及很多原生库都按**进程 cwd** 解析相对路径。
    - 表现是「命令没报错，但读/写到了别处」——比抛错危险得多。
- **修法**：脚本里一律用**绝对路径**；需要换目录时用工具调用提供的 `cwd` 参数（它设置进程工作目录），而不是在命令里拼 `cd xxx;`。
- **证据**：`实测`（2026-10-20，核对 `AGENTS.md` 字节数时误判为文件被截断）。

### 5.10 `bun publish` 报 `+ pkg@version` 不等于 registry 已可见，落地延迟可达两分钟

- **症状**：`bun publish` 输出 `+ bun-app-window@0.3.0` 并 `rc=0`，看起来发布完成。随后
  **80 秒内**用 `?t=<时间戳>` 绕缓存查，仍是 `dist-tags.latest` 停在上一版、
  `versions` 里没有新版本、单版本端点报 `version not found`、元数据 `time.modified`
  还停在上一次的发布时间。约 **2 分钟**后一切正常，`time["0.3.0"]` 才出现。
- **与 5.4 不是同一个失效**：5.4 是「写入成功、GET 读到旧值」，属 CDN 缓存，加时间戳
  参数就能绕过。这一条是**源数据本身还没写进去**，`?t=` 绕不过，只能等。
- **判据只能有一个**：`bun publish` 的 `+ pkg@version` 是**客户端完成上传**，
  不是「registry 已可读」。真正的判据是 `dist-tags.latest` 与新版本同时出现，
  并且**下载 tarball 解开读 `package.json` 的 `version`**（5.7 那条同源）。
- **代价最高的误判（本次实际发生）**：把「等不到」当成「没发上去」，于是重跑
  `bun publish`。后果有两层——第一轮最终会落地，第二轮再被批准就是 republish 同一版本；
  而且两轮各自弹一次 passkey，浏览器里两个认证会话同时挂着，人分不清该点哪个。
  **用户那一刻刚好点了第一轮的链接，两条路径的时间线于是交叉了。**
- **正确做法：等，不要重试。** 发完 `bun publish` 后设一个 **3 分钟的 timer**
  再去查一次，而不是连续轮询并据「还没出现」重发。轮询本身无害，**据此重发才是错的**。
- **附带一条**：`Select-Object -Last N` 之类的管道会把子进程输出**缓冲到进程结束**，
  而 `bun publish` 阻塞在 passkey 上不会结束 —— 于是 URL 永远不出现，人无从操作。
  需要看输出时**不要加管道**，或者只在明确的短命令上用。
- **证据**：`实测`（2026-10-21，0.3.0 发布）。`19:27:47Z` 上传返回 rc=0；
  `19:29:47.293Z` 新版本才出现在元数据里，间隔约 2 分钟。

### 5.11 读凭据类文件做诊断时，脱敏必须作用在**最终输出**上

- **症状**：为了查 npm registry 为何被指向镜像，用 `Select-String` 扫了几个配置文件，
  并对 `Get-Content` 那条路径写了 `_authToken=***` 的替换 —— 但 `Select-String` 走的是
  另一条分支，**替换根本没作用到它**，于是 token 以明文进了会话记录。
- **原因**：脱敏写成「对某一条读取路径的每一行做替换」，而不是「对整段输出做替换」。
  只要有第二条路径把内容带出来（`Select-String` / `Write-Output` / 错误信息里的路径与值），
  它就漏掉了。
- **修法**：诊断凭据时，**先确定唯一出口**，在出口处兜底；或者干脆不读值——
  只报「present / missing」与长度（本次第一版就是这么做的，是对的；
  第二次为了找 registry 才顺手把整行打出来，反而退化了）。
- **代价**：token 一旦进会话记录就得视为已泄露。**必须轮换**，不能只指望它没被看到。
- **证据**：`实测`（2026-10-21）。同一次排查里，前一条命令用长度法安全，
  后一条命令用 `Select-String` 泄漏。

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
| DLL 体积 | 约 971 KB（994,304 B，含外部导航守卫与窗口事件环） |
| 签名开销 | 约 7.2 KB |
