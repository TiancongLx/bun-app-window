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
- **修法**：使承载工具调用的进程本身位于 Session 1。2026-10-18 起 OTT 已迁为登录任务（OTT 仓 DECISIONS 37），`run_command` 子进程即 `SessionId=1`，无需任何跨会话派发；`session1-agent` 旁路已退役。若工具宿主退回服务形态，本条会复现。
- **更正（2026-10-18 实测）**：本条曾记录「提权宿主不能创建 WebView2」，实测不成立——`dist/webview-shell.exe` 由 High 进程直接启动时 `webview_create` 成功，九点命中与最大化/还原几何全部通过；降权到 Medium 亦通过。文档原文是「cannot be run as a system user」（SYSTEM/服务会话），Session 0 的失败是会话问题。仍待验证的一点：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 等 `WEBVIEW2_*` 环境变量在提权宿主下是否被忽略（本项目的浏览器参数由代码内 environment options 传入，未走环境变量，故未受影响）。
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
