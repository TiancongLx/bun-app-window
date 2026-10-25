/**
 * index.ts — bun-app-window 内核门面
 *
 * 这是包的唯一稳定入口。它只做三件事：解析原生库、暴露窗口操作、暴露排障探针。
 * 不带任何业务逻辑、不读环境变量、不写日志文件、不调用 process.exit。
 *
 * ```ts
 * import { createShell, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";
 *
 * const shell = await createShell({
 *   url: "http://127.0.0.1:40001",
 *   title: "My App",
 *   width: 1000, height: 680,
 *   flags: FLAG_FRAMELESS | FLAG_CENTER,
 * });
 * if (shell.start().rc !== 0) throw new Error(shell.lastError());
 * shell.post(JSON.stringify({ t: "hello" }));
 * ```
 *
 * 线程模型：`start()` 立即返回（原生层自建 UI 线程），调用方主线程不被阻塞。
 */

import { cstr, openNativeLib, readBuffer } from "./native";
import { ptr } from "bun:ffi";
import type { NativeSymbols } from "./native";
import { resolveNativeLib } from "./resolve";
import { EVENT_QUEUE_CAPACITY, EVENT_RECORD_BYTES, decodeEvents, type WindowEvent } from "./events";
import {
    STATE_FOCUSED,
    STATE_MAXIMIZED,
    STATE_MINIMIZED,
    parseBounds,
    resizeIndex,
    type NativeLibInfo,
    type ResizeEdge,
    type ShellOptions,
    type StartResult,
    type WindowRect,
    type WindowState,
} from "./types";

export * from "./types";
export { resolveNativeLib, isPackedRuntime } from "./resolve";
export type { ResolveOptions } from "./resolve";
export { serveOnSafePort, isRestrictedPort } from "./port";
export type { ServeOptions } from "./port";
export { cstr, readCStr } from "./native";
export type { NativeSymbols, NativeLib } from "./native";
export type { ClosedEvent, StateEvent, WindowEvent } from "./events";

/**
 * 原生调用的回执。
 *
 * 刻意不是裸 `number`：`rc` 只回答「有没有投递出去」，`err` 才回答「为什么没投递」。
 * 把两者分开，调用方才能区分两种完全不同的故障：
 *
 * - `rc === 0` 但状态没变 → 时序 / 前置条件问题（原生侧是异步投递到 UI 线程的）
 * - `rc < 0` 且 `err` 非空 → 调用方用错 API（窗口已销毁、参数越界）
 *
 * **`rc === 0` 不等于效果发生了。** 要判效果必须读回状态
 * （`state()` / `getZoom()` / `getBounds()`）。
 */
export type NativeAck = {
    /** `0` = 已投递给 UI 线程；负数 = 当场被拒（窗口已销毁、参数越界等） */
    rc: number;
    /** 失败原因；成功时恒为空串 */
    err: string;
};

/**
 * 把裸 `rc` 包成 `NativeAck`。
 *
 * **只在失败时读 `lastError()`**：壳层的错误缓冲区不会被成功的调用清空，
 * 成功时读它只会拿到上一次的残留——显示出来就是一个假故障。
 */
export function ackOf(shell: Shell, rc: number): NativeAck {
    return { rc, err: rc === 0 ? "" : shell.lastError() };
}

export type Shell = {
    /** 创建窗口并加载 URL。返回码 0 表示成功；失败原因见 lastError() */
    start(): StartResult;
    /** 宿 → 页面：投递 JSON 文本（单向，不等结果） */
    post(json: string): number;
    setTitle(title: string): number;
    minimize(): number;
    toggleMaximize(): number;
    close(): number;
    /** 由页面 pointerdown 触发原生拖拽；保留贴边分屏 */
    drag(): number;
    /**
     * 由页面触发的边框缩放（进入 Windows 的模态缩放循环，鼠标被系统接管）。
     *
     * **入参是 `RESIZE_EDGE` 的 HT* 值（10–17）**，不是内部数组下标。
     *
     * 0.5.x 的实现把入参直传给原生 `shell_begin_resize()`，而原生收的是
     * `codes[8]` 的**数组下标 0–7**——两者的映射是 `HT*` 常量在 Win32 里的定义顺序，
     * 既不是恒等也不是「减 10」（`HTTOPLEFT`=13 在下标 4、`HTBOTTOM`=15 在下标 3）。
     * 于是照着注释传 `RESIZE_EDGE.LEFT`（=10）会被 `edge > 7` 当场拒掉，
     * `rc=-1`，外部表现是「点了没反应」，而门禁全绿。
     *
     * 0.6.0 起由本方法在 TS 层查表转换，原生 DLL 不需要重编。非法值仍然返回 -1。
     */
    beginResize(edge: ResizeEdge): number;
    /** 最小尺寸，逻辑像素 */
    setMinSize(width: number, height: number): void;
    /**
     * 显示窗口。配合 `FLAG_DEFER_SHOW` 使用：页面就绪后再调用，消除首帧闪烁。
     * 未启用延迟显示时是幂等 no-op。
     */
    show(): number;
    /**
     * 设置 AppUserModelID（任务栏分组与图标归属）。
     * 只在 `start()` 之前调用才对本窗口生效。
     */
    setAppId(appId: string): number;
    /**
     * 弹出系统文件夹选择框，返回选中路径；用户取消返回 null。
     *
     * 直接调 shell32，不起子进程、不落临时脚本——比「spawn powershell 跑 WinForms」
     * 快一个数量级，也不受执行策略限制。
     *
     * **同步阻塞**：SHBrowseForFolder 自带模态循环，调用期间调用线程被占住
     * （实测：Bun 主线程上的定时器在此期间不会触发）。同理，被阻塞的调用链
     * 无法取消或超时。需要并发时把它放到 Worker 里调用。
     */
    pickFolder(title?: string): string | null;
    state(): WindowState;
    /**
     * 窗口是否仍然存在。
     *
     * `state()` 无法区分「未启动」与「已销毁」（两者都返回全 false），
     * 宿主需要这个信号才能判断窗口是否已被用户关掉，进而回收自己的进程——
     * 窗口销毁后原生 UI 线程会返回，但宿主进程与它起的本地服务不会自己退出。
     *
     * 想要「等窗口关闭」而不是「每一拍问一次」时，用 `pollEvents()` 的
     * `EVENT_CLOSED`（或 `bun-app-window/events` 的 `attachEventPump()`）。
     * 两者不等价：`isAlive()` 读的是此刻的 `g_webview` 是否为空，而 `CLOSED`
     * 是原生侧在 teardown 全部做完之后写进队列的显式终态。
     */
    isAlive(): boolean;
    /**
     * 批量拉取窗口生命周期事件（`EVENT_STATE` / `EVENT_CLOSED`）。
     *
     * **消费式**：读走的记录不会再来。所以一个进程只应有一个消费者——
     * 要么用 `bun-app-window/events` 的 `attachEventPump()`，要么自己按节奏调
     * 这个方法，别两者都来：两个消费者会各自拿到一部分，谁也看不全。
     *
     * 同步、零分配以外的副作用；`max` 是记录条数，内部夹在
     * `1..EVENT_QUEUE_CAPACITY`。窗口未启动时返回空数组。
     *
     * ```ts
     * for (const e of shell.pollEvents()) {
     *   if (e.type === EVENT_CLOSED) break;
     *   if (e.maximized) { ... }
     * }
     * ```
     */
    pollEvents(max?: number): WindowEvent[];
    /** 最近一次失败的原因；无错误时为空串。走拷贝式读出，不受并发写影响 */
    lastError(): string;

    // ---- 应用化 ----
    /**
     * 关掉指定的浏览器行为（`BROWSER_UI_*` 按位或）。运行时生效。
     *
     * 一般通过 `ShellOptions.browserUi` 声明即可；这个方法用于运行中切换
     * （例如调试模式临时放开 `Ctrl+F`）。
     */
    setBrowserUi(mask: number): number;
    /**
     * 在屏幕坐标弹出**原生**上下文菜单。
     *
     * 关掉 WebView2 默认右键菜单后，右键就成了「点了没反应」，那也不像原生应用。
     * 原生应用右键是有菜单的，只是菜单属于应用：
     *
     * ```ts
     * document.addEventListener("contextmenu", (e) => {
     *   e.preventDefault();
     *   fetch("/api/menu", { method: "POST", body: JSON.stringify({ x: e.screenX, y: e.screenY }) });
     * });
     * ```
     *
     * `items` 用行描述，`id|label` 每行一项，单独 `-` 是分隔线：
     * `"open|打开题库\nrefresh|刷新\n-\nquit|退出"`。
     * 选中后通过 shell-msg 推回 `{ t: "menu", id: "<id>" }`。
     */
    showContextMenu(x: number, y: number, items: string): number;

    // ---- 窗口位置 ----
    /**
     * 当前窗口矩形，格式 "x,y,w,h,maximized,dpi"（物理像素）。
     * 最大化时返回的是「还原后」的矩形。窗口未启动时返回空串。
     *
     * 这是原生那一行文本的**直传**：不解析、不校验，字符串长什么样就什么样。
     * 要可用的结构就用 `getRect()`——两者读的是同一个原生符号，只是后者把
     * 同一份文本按判据解析了一遍。要连持久化一起办，用 `bun-app-window/state`
     * 的 `capturePlacement()`。
     */
    getBounds(): string;
    /**
     * 当前窗口矩形的**结构化**读数；读不到或数据不可用时返回 `null`。
     *
     * 与 `getBounds()` 的分工：后者是逃生舱（原生原文直传），本方法是正式出口。
     * 判据与 `parseBounds()` 同源，返回 `null` 的三种情形见那里——不只是
     * 「窗口没开」，还包括**最小化时的 Win32 哨兵坐标**（形状合法但位置是假的，
     * 详见 `MINIMIZED_SENTINEL` 的说明）。
     *
     * ```ts
     * const r = shell.getRect();
     * if (r) console.log(`${r.width}×${r.height} @ ${r.x},${r.y} dpi=${r.dpi}`);
     * ```
     *
     * 为什么不让 `state()` 带矩形：`state()` 是廉价位掩码，加一次 FFI 字符串读
     * 与解析会改变它的成本模型，而 `WindowState` 的形状变更本身就是破坏性改动。
     * 需要「最大化标记 + 矩形」一起判时，本方法返回的 `maximized` 与 `x/y/width/height`
     * 来自**同一次**原生读取，不存在两拍之间的撕裂。
     */
    getRect(): WindowRect | null;
    /**
     * 恢复窗口矩形。savedDpi 是保存时的 DPI，用于跨缩放比例换算；
     * 原生侧还会校验矩形是否仍在某块屏上，不在则居中。
     *
     * 一般不需要直接调用——用 bun-app-window/state 的 restorePlacement()。
     */
    restoreBounds(x: number, y: number, width: number, height: number, savedDpi: number, maximized: boolean): number;

    // ---- 输入与视图 ----
    /**
     * 页面缩放倍率（0.25 ~ 3.0）。也支持用户键盘操作：Ctrl± / Ctrl+0 / Ctrl+滚轮。
     * 生效是异步的（投到 UI 线程），getZoom() 读的是缓存值。
     */
    setZoom(factor: number): number;
    /** 当前缩放倍率（缓存值） */
    getZoom(): number;
    /** 重新加载页面（等同 Ctrl+R / F5） */
    reload(): number;
    /** 打开开发者工具（等同 F12） */
    openDevTools(): number;
    /** 切换全屏（等同 F11）；全屏与最大化不同，连边框与任务栏一起让出 */
    toggleFullscreen(): number;

    /**
     * 运行时切换窗口形态（ADR 0019）。`frameless = false` 让系统标题栏回来。
     *
     * **只在创建期给了 `FLAG_FRAMELESS` 时可用**：带边框起点是 webview 自建的窗口，
     * 我们没有它的 `WM_NCCALCSIZE` 控制权。那种情况下返回 -1，理由在 `lastError()`。
     *
     * 生效是异步的（投到 UI 线程）。确认方式两条：`isFrameless()` 读缓存，或页面
     * 监听 `shell-msg` 的 `win` 消息——它的 `frameless` 字段会在切换后推一次。
     * 全屏期间调用会被拒：`toggleFullscreen` 自带样式位与矩形的缓存，两者同时改
     * 会让退出全屏还原成一个混合体。
     */
    setFrameless(frameless: boolean): number;
    /** 当前运行时形态。读缓存，无窗口调用；未启动时回创建期形态 */
    isFrameless(): boolean;

    /** 停止并释放窗口（可重复调用） */
    stop(): void;

    readonly started: boolean;
    readonly libInfo: NativeLibInfo;
    /** 逃生舱：直接访问 dlopen 出来的符号 */
    readonly symbols: NativeSymbols;

    // 排障面（hittest / metrics / dpi / selfBase / selfPath）已移到独立入口
    //     import { debugOf } from "bun-app-window/debug"
    // 目的：公共面只承诺产品向能力。把排障面留在主入口，等于把它也变成契约，
    // 将来改一次诊断输出就成了破坏性变更。
};

export async function createShell(opts: ShellOptions): Promise<Shell> {
    if (!opts.url) throw new Error("createShell: url is required");

    const libInfo = await resolveNativeLib({
        ...(opts.nativeLibPath === undefined ? {} : { nativeLibPath: opts.nativeLibPath }),
        ...(opts.appName === undefined ? {} : { appName: opts.appName }),
        ...(opts.embedded === undefined ? {} : { embedded: opts.embedded }),
    });
    const { symbols } = openNativeLib(libInfo.path);

    let started = false;
    let stopped = false;

    // 拷贝式读出：shell_error() 返回共享缓冲区的指针，解锁后可能被别的线程改写
    const lastError = () => readBuffer((p, len) => symbols.shell_error_text(p, len), 512);
    // 原生那一行 "x,y,w,h,maximized,dpi" 最长也不过几十字节，256 是余量
    const readBounds = () => readBuffer((p, len) => symbols.shell_get_bounds(p, len), 256);

    const shell: Shell = {
        start(): StartResult {
            if (started) return { rc: -1, error: "shell already started" };
            const rc = symbols.shell_start_ex(
                cstr(opts.url),
                cstr(opts.title ?? "bun-app-window"),
                opts.width ?? 1000,
                opts.height ?? 680,
                opts.flags ?? 0,
            );
            started = rc === 0;
            if (started && opts.minWidth && opts.minHeight) {
                symbols.shell_set_min_size(opts.minWidth, opts.minHeight);
            }
            if (started && opts.browserUi) {
                // 放在 start 之后：需要 webview 已存在。这些是 UI 行为开关，
                // 运行时改即时生效，不涉及渲染，不必赶在 navigate 之前。
                symbols.shell_set_browser_ui(opts.browserUi);
            }
            return { rc, error: rc === 0 ? "" : lastError() };
        },

        post: (json) => symbols.shell_post(cstr(json)),
        setTitle: (title) => symbols.shell_title(cstr(title)),
        minimize: () => symbols.shell_minimize(),
        toggleMaximize: () => symbols.shell_toggle_maximize(),
        close: () => symbols.shell_close(),
        drag: () => symbols.shell_drag(),
        beginResize: (edge) => symbols.shell_begin_resize(resizeIndex(edge)),
        setMinSize: (w, h) => symbols.shell_set_min_size(w, h),
        show: () => symbols.shell_show(),
        setAppId: (appId) => symbols.shell_set_app_id(cstr(appId)),

        pickFolder(title?: string): string | null {
            const buf = new Uint8Array(4096);
            const rc = symbols.shell_pick_folder(cstr(title ?? "选择文件夹"), ptr(buf), buf.length);
            if (rc !== 0) return null; // 1 = 取消，-1 = 失败
            const end = buf.indexOf(0);
            return new TextDecoder().decode(buf.subarray(0, end < 0 ? buf.length : end));
        },

        state(): WindowState {
            const raw = symbols.shell_get_state();
            return {
                raw,
                maximized: (raw & STATE_MAXIMIZED) !== 0,
                minimized: (raw & STATE_MINIMIZED) !== 0,
                focused: (raw & STATE_FOCUSED) !== 0,
                dark: symbols.shell_is_dark() !== 0,
            };
        },

        isAlive: () => symbols.shell_is_alive() !== 0,

        pollEvents(max = 64): WindowEvent[] {
            // 原生侧环容量是 128，一次要更多没有意义；下限 1 免得 0 变成「永远拉不到」
            const cap = Math.max(1, Math.min(Math.trunc(max), EVENT_QUEUE_CAPACITY));
            const buf = new Uint8Array(cap * EVENT_RECORD_BYTES);
            const n = symbols.shell_poll_events(ptr(buf), cap);
            return n > 0 ? decodeEvents(buf, n) : [];
        },

        lastError,

        setBrowserUi: (mask) => symbols.shell_set_browser_ui(mask),
        showContextMenu: (x, y, items) => symbols.shell_show_app_menu(x, y, cstr(items)),

        getBounds: readBounds,
        // 与 getBounds 读同一个原生符号，区别只在「解析过没有」。这条链不能省。
        getRect: () => parseBounds(readBounds()),
        restoreBounds: (x, y, w, h, savedDpi, maximized) =>
            symbols.shell_restore_bounds(x, y, w, h, savedDpi, maximized ? 1 : 0),

        setZoom: (factor) => symbols.shell_set_zoom(factor),
        getZoom: () => symbols.shell_get_zoom(),
        reload: () => symbols.shell_reload(),
        openDevTools: () => symbols.shell_devtools(),
        toggleFullscreen: () => symbols.shell_toggle_fullscreen(),
        setFrameless: (frameless) => symbols.shell_set_frameless(frameless ? 1 : 0),
        isFrameless: () => symbols.shell_is_frameless() !== 0,

        stop() {
            if (stopped) return;
            stopped = true;
            started = false;
            try {
                symbols.shell_stop();
            } catch {
                // 窗口已销毁时无需处理
            }
        },

        get started() {
            return started;
        },
        libInfo,
        symbols,
    };

    return shell;
}

/** 语法糖：创建并启动；失败直接抛错 */
export async function openShell(opts: ShellOptions): Promise<Shell> {
    const shell = await createShell(opts);
    const { rc, error } = shell.start();
    if (rc !== 0) {
        throw new Error(`shell_start_ex failed (rc=${rc}): ${error || "unknown"}`);
    }
    return shell;
}
