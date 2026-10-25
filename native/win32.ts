/**
 * win32.ts — 诊断脚本用的 Win32 FFI 通用层
 *
 * 与 `src/shell/native.ts` 的区别：那个是**产品契约**（libshell.dll 的 33 个符号），
 * 这个是**诊断工具**用的系统 API 声明，不随包发布。
 *
 * ## 三条来自实测的硬性约束
 *
 * 1. **`buffer` / `buffer_length` 必须写字符串，不能写 `FFIType.buffer`。**
 *    `ffi.d.ts` 声明了枚举可用，但 1.4.4 运行时抛 `invalid ABI type`。
 *    见 `docs/pitfalls.md` 3.5。
 * 2. **HANDLE 用 `u64_fast`**（拿到 `number`），不要用 `ptr`。见 3.7。
 * 3. **不声明任何 C→JS 回调类型。** 章程第 5 条禁的是「前端页面回调」，
 *    但诊断脚本里同样避开它是划算的：`JSCallback` 的生命周期管理会引入
 *    新的失败面，而窗口枚举可以用 `GetTopWindow` / `GetWindow` 迭代替代
 *    `EnumWindows`。见 `docs/pitfalls.md` 3.8。
 */

import { FFIType, dlopen, ptr } from "bun:ffi";

// ---- 字符串 -----------------------------------------------------------------

/** JS 字符串 → 以 NUL 结尾的 UTF-16LE 缓冲区（`*W` 后缀的 API 专用） */
export function utf16z(s: string): Uint8Array {
    const out = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >>> 8;
    }
    return out;
}

/** 从 UTF-16LE 缓冲区读字符串，遇到 NUL 停止 */
export function readUtf16(bytes: Uint8Array, offset = 0): string {
    let end = offset;
    while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) {
        end += 2;
    }
    let s = "";
    for (let i = offset; i < end; i += 2) {
        const lo = bytes[i] ?? 0;
        const hi = bytes[i + 1] ?? 0;
        s += String.fromCharCode(lo | (hi << 8));
    }
    return s;
}

// ---- 常量 -------------------------------------------------------------------

/** `GetWindow` 的 nCmd 取值（只列用到的） */
export const GW_HWNDNEXT = 2;
/** 第一个子窗口 */
export const GW_CHILD = 5;

/** `IsWindowVisible` 之外，`GetWindowRect` 失败时 RECT 全是 0 */
export type Rect = { left: number; top: number; right: number; bottom: number };

export type WindowInfo = {
    hwnd: bigint;
    className: string;
    title: string;
    pid: number;
    visible: boolean;
    /** 窗口矩形（屏幕坐标，物理像素） */
    rect: Rect;
    width: number;
    height: number;
};

// ---- user32 -----------------------------------------------------------------

const textBuf = new Uint8Array(1024);

const user32 = dlopen("user32.dll", {
    GetTopWindow: { args: [FFIType.u64_fast], returns: FFIType.u64_fast },
    GetWindow: { args: [FFIType.u64_fast, "u32"], returns: FFIType.u64_fast },
    GetWindowThreadProcessId: { args: [FFIType.u64_fast, "buffer"], returns: "u32" },
    IsWindowVisible: { args: [FFIType.u64_fast], returns: "bool" },
    IsIconic: { args: [FFIType.u64_fast], returns: "bool" },
    GetClassNameW: { args: [FFIType.u64_fast, "buffer", "i32"], returns: "i32" },
    GetWindowTextW: { args: [FFIType.u64_fast, "buffer", "i32"], returns: "i32" },
    GetWindowTextLengthW: { args: [FFIType.u64_fast], returns: "i32" },
    GetWindowRect: { args: [FFIType.u64_fast, "buffer"], returns: "bool" },
    GetClientRect: { args: [FFIType.u64_fast, "buffer"], returns: "bool" },
    // ClientToScreen 的 POINT 是「输入输出同体」：传进来客户区坐标，调用后就地改写成
    // 屏幕坐标。所以传进去的缓冲必须先填好值，不能是空指针（空指针会写崩）。
    ClientToScreen: { args: [FFIType.u64_fast, "buffer"], returns: "bool" },
    // GetDpiForWindow 需要 WINVER >= 0x0A00（Win10 1607+）；本仓 win32.ts 不定义
    // WINVER，但那是 MinGW 头文件的门控，运行时按导出名解析，与编译期宏无关。
    GetDpiForWindow: { args: [FFIType.u64_fast], returns: "u32" },
    GetForegroundWindow: { args: [], returns: FFIType.u64_fast },
    SetProcessDPIAware: { args: [], returns: "bool" },
    OpenInputDesktop: { args: ["u32", "bool", "u32"], returns: FFIType.u64_fast },
    OpenWindowStationW: { args: ["buffer", "bool", "u32"], returns: FFIType.u64_fast },
    DestroyIcon: { args: [FFIType.u64_fast], returns: "bool" },
    GetIconInfo: { args: [FFIType.u64_fast, "buffer"], returns: "bool" },
    // DrawIconEx 在 user32.dll —— 2026-10-20 实测：写进 gdi32 会报
    // `Symbol "DrawIconEx" not found in "gdi32.dll"`。同一族的 DestroyIcon 也在
    // user32。图标相关 API 两头都有，必须逐符号核实（pitfalls 3.7 的附带条款）。
    //
    // 九个参数一个都不能少：初版漏了第 8 个 `hbrFlickerFreeDraw`，
    // 结果 `diFlags` 错位收到 0 —— 调用照样返回 true，但什么都没画。
    // 见 docs/pitfalls.md 3.9。
    DrawIconEx: {
        args: [
            FFIType.u64_fast, // HDC
            "i32", // xLeft
            "i32", // yTop
            FFIType.u64_fast, // HICON
            "i32", // cxWidth
            "i32", // cyWidth
            "u32", // istepIfAniCur
            FFIType.u64_fast, // hbrFlickerFreeDraw
            "u32", // diFlags
        ],
        returns: "bool",
    },
    PrintWindow: { args: [FFIType.u64_fast, FFIType.u64_fast, "u32"], returns: "bool" },
    // ShowWindow 的返回值是「**之前**是否可见」，不是「这次成功与否」。
    // 因此它不能当判据：调用后必须用 IsWindowVisible 复核。
    // 而且第一次调用会被启动方的 STARTUPINFO 覆盖（`STARTF_USESHOWWINDOW` +
    // `SW_HIDE` 时我们传的 nCmdShow 被丢弃），见 pitfalls 2.9 与 native/shell.cc
    // 的 force_visible()。
    ShowWindow: { args: [FFIType.u64_fast, "i32"], returns: "bool" },
    IsZoomed: { args: [FFIType.u64_fast], returns: "bool" },
});

const kernel32 = dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "bool", "u32"], returns: FFIType.u64_fast },
    CloseHandle: { args: [FFIType.u64_fast], returns: "bool" },
    ReadProcessMemory: {
        args: [FFIType.u64_fast, FFIType.u64_fast, "buffer", FFIType.u64_fast, "buffer"],
        returns: "bool",
    },
    VirtualQueryEx: {
        args: [FFIType.u64_fast, FFIType.u64_fast, "buffer", FFIType.u64_fast],
        returns: FFIType.u64_fast,
    },
    GetProcessTimes: {
        args: [FFIType.u64_fast, "buffer", "buffer", "buffer", "buffer"],
        returns: "bool",
    },
    WTSGetActiveConsoleSessionId: { args: [], returns: "u32" },
    ProcessIdToSessionId: { args: ["u32", "buffer"], returns: "bool" },
    GetCurrentProcessId: { args: [], returns: "u32" },
});

/** DPI 感知必须尽早声明，否则矩形返回逻辑像素、与位图尺寸错配 */
export function setDpiAware(): void {
    user32.symbols.SetProcessDPIAware();
}

/** 读 RECT（4 × int32） */
export function readRect(bytes: Uint8Array, offset = 0): Rect {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
    return {
        left: view.getInt32(0, true),
        top: view.getInt32(4, true),
        right: view.getInt32(8, true),
        bottom: view.getInt32(12, true),
    };
}

function windowClassName(hwnd: bigint): string {
    textBuf.fill(0);
    const n = user32.symbols.GetClassNameW(hwnd, textBuf, textBuf.length / 2);
    return n > 0 ? readUtf16(textBuf) : "";
}

function windowTitle(hwnd: bigint): string {
    textBuf.fill(0);
    const n = user32.symbols.GetWindowTextW(hwnd, textBuf, textBuf.length / 2);
    return n > 0 ? readUtf16(textBuf) : "";
}

function windowPid(hwnd: bigint): number {
    const buf = new Uint32Array(1);
    user32.symbols.GetWindowThreadProcessId(hwnd, buf);
    return buf[0] ?? 0;
}

const rectBuf = new Uint8Array(16);
const pointBuf = new Uint8Array(8);

/**
 * 整窗矩形（屏幕坐标，物理像素）。
 *
 * 这就是 `PrintWindow` 拍出来的那张图的坐标基准：图像 (0,0) 对应 `left, top`。
 */
export function windowRect(hwnd: bigint): Rect {
    rectBuf.fill(0);
    if (!user32.symbols.GetWindowRect(hwnd, rectBuf)) {
        return { left: 0, top: 0, right: 0, bottom: 0 };
    }
    return readRect(rectBuf);
}

/**
 * 客户区矩形。
 *
 * 注意 `GetClientRect` 返回的恒以 `(0,0)` 为左上角——它是**尺寸**，不是位置。
 * 客户区在屏幕上的位置要用 {@link clientOrigin}。这两个概念混用是坐标映射里最容易
 * 错的一处：拿 `GetClientRect().left` 当屏幕 x 会恒得 0，于是「点击总是落在左上角」。
 */
export function clientRect(hwnd: bigint): Rect {
    rectBuf.fill(0);
    if (!user32.symbols.GetClientRect(hwnd, rectBuf)) {
        return { left: 0, top: 0, right: 0, bottom: 0 };
    }
    return readRect(rectBuf);
}

/**
 * 客户区左上角在屏幕上的位置（物理像素）。
 *
 * 这是「截图坐标 → 页面元素坐标」那条链的锚点：模型在一张 PrintWindow 图上圈出的点，
 * 先换算成整窗坐标，再减 `(clientOrigin - windowRect左上角)` 才是客户区坐标。
 *
 * 失败返回 `null` 而不是 `(0,0)`：`(0,0)` 是个合法坐标（左上角屏幕），
 * 用它表示失败会让调用方悄悄点到屏幕角落去。
 */
export function clientOrigin(hwnd: bigint): { x: number; y: number } | null {
    const view = new DataView(pointBuf.buffer);
    view.setInt32(0, 0, true);
    view.setInt32(4, 0, true);
    if (!user32.symbols.ClientToScreen(hwnd, pointBuf)) {
        return null;
    }
    return { x: view.getInt32(0, true), y: view.getInt32(4, true) };
}

/**
 * 窗口所在显示器的 DPI（96 = 100%）。
 *
 * 进程未声明 DPI 感知时系统会把坐标伪装成 96，所以调用方必须**先** `setDpiAware()`，
 * 否则这里读到 96、而窗口矩形其实是物理像素——两者比例对不上，映射会整体偏移。
 */
export function dpiOfWindow(hwnd: bigint): number {
    const dpi = user32.symbols.GetDpiForWindow(hwnd);
    return typeof dpi === "number" && dpi > 0 ? dpi : 96;
}

/**
 * 把 FFI 返回值归一为 `bigint` 句柄。
 *
 * `u64_fast` 的返回类型是 `number | bigint`（见 `ffi.d.ts` 的
 * `FFITypeToReturnsType`），调用点直接当 `bigint` 用会编译失败。
 * 0 / null / NaN 一律视为「空句柄」。
 */
export function toHandle(v: number | bigint | null | undefined): bigint {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) return BigInt(v);
    return 0n;
}

/**
 * 枚举所有顶层窗口。
 *
 * `EnumWindows` 需要 C→JS 回调；`GetTopWindow(0)` + `GetWindow(h, GW_HWNDNEXT)`
 * 是纯迭代的等价写法，不碰回调也不引入回调对象生命周期。实测可用
 * （见 `docs/pitfalls.md` 3.8）。
 *
 * `max` 是防死循环的硬止损：窗口链异常成环时不会挂死。
 */
export function listTopLevelWindows(max = 4000): WindowInfo[] {
    const out: WindowInfo[] = [];
    let hwnd = toHandle(user32.symbols.GetTopWindow(0n));
    let guard = 0;
    while (hwnd !== 0n && guard++ < max) {
        const rect = windowRect(hwnd);
        out.push({
            hwnd,
            className: windowClassName(hwnd),
            title: windowTitle(hwnd),
            pid: windowPid(hwnd),
            visible: user32.symbols.IsWindowVisible(hwnd) === true,
            rect,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        });
        const next = toHandle(user32.symbols.GetWindow(hwnd, GW_HWNDNEXT));
        if (next === 0n || next === hwnd) break;
        hwnd = next;
    }
    return out;
}

/** 目标进程的可见顶层窗口；`pid` 为 0 时不过滤 */
export function findWindows(pid: number): WindowInfo[] {
    return listTopLevelWindows().filter((w) => pid === 0 || w.pid === pid);
}

/**
 * 枚举某窗口的全部直接子窗口。
 *
 * `EnumChildWindows` 是递归的且需要回调；`GetWindow(h, GW_CHILD)` 只给**直接
 * 子窗口**，所以要自己按层级展开。这里的做法是「广度优先逐层展开」，
 * 与 `EnumChildWindows` 的深度优先结果集合相同、顺序不同——
 * 诊断脚本关心的是「有哪些」，不关心顺序。
 */
export function listChildWindows(parent: bigint, maxDepth = 8): WindowInfo[] {
    const out: WindowInfo[] = [];
    let level: bigint[] = childWindowsOf(parent);
    let depth = 0;
    while (level.length > 0 && depth++ < maxDepth) {
        const next: bigint[] = [];
        for (const hwnd of level) {
            const rect = windowRect(hwnd);
            out.push({
                hwnd,
                className: windowClassName(hwnd),
                title: windowTitle(hwnd),
                pid: windowPid(hwnd),
                visible: user32.symbols.IsWindowVisible(hwnd) === true,
                rect,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            });
            next.push(...childWindowsOf(hwnd));
        }
        level = next;
    }
    return out;
}

/** 一层直接子窗口 */
function childWindowsOf(parent: bigint): bigint[] {
    const out: bigint[] = [];
    let hwnd = toHandle(user32.symbols.GetWindow(parent, GW_CHILD));
    let guard = 0;
    while (hwnd !== 0n && guard++ < 2000) {
        out.push(hwnd);
        const next = toHandle(user32.symbols.GetWindow(hwnd, GW_HWNDNEXT));
        if (next === 0n || next === hwnd) break;
        hwnd = next;
    }
    return out;
}

/** 前台窗口的 hwnd；无前台返回 0 */
export function foregroundWindow(): bigint {
    return toHandle(user32.symbols.GetForegroundWindow());
}

/** `OpenInputDesktop` 的结果；0 表示当前会话没有交互式输入桌面 */
export function openInputDesktop(access = 0x0100): bigint {
    return toHandle(user32.symbols.OpenInputDesktop(0, false, access));
}

/** `OpenWindowStation("WinSta0")` 的结果；0 表示不可达 */
export function openWindowStation(name = "WinSta0", access = 0x0001): bigint {
    return toHandle(user32.symbols.OpenWindowStationW(utf16z(name), false, access));
}

export function closeHandle(h: bigint): boolean {
    return kernel32.symbols.CloseHandle(h) === true;
}

export function isIconic(hwnd: bigint): boolean {
    return user32.symbols.IsIconic(hwnd) === true;
}

/** `ShowWindow` 的 nCmdShow 取值（只列用到的） */
export const SW_MAXIMIZE = 3;
export const SW_SHOW = 5;

export function isZoomed(hwnd: bigint): boolean {
    return user32.symbols.IsZoomed(hwnd) === true;
}

/**
 * 显示 / 最大化窗口，并**用 `IsWindowVisible` 复核**。
 *
 * 不用 `ShowWindow` 的返回值当判据：它返回的是「之前是否可见」，
 * 与这次调用是否生效无关。更麻烦的是第一次调用会被启动方的 STARTUPINFO
 * 覆盖（见 `docs/pitfalls.md` 2.9），所以这里也做一次重试。
 *
 * 返回复核后的真实可见性，让调用方决定要不要把它当成失败。
 */
export function showWindow(hwnd: bigint, cmd: number): boolean {
    if (hwnd === 0n) return false;
    user32.symbols.ShowWindow(hwnd, cmd);
    if (user32.symbols.IsWindowVisible(hwnd) === true) return true;
    // 第一次可能被 STARTUPINFO 吃掉，再来一次
    user32.symbols.ShowWindow(hwnd, cmd);
    return user32.symbols.IsWindowVisible(hwnd) === true;
}

/** `PrintWindow` 的标志位：`PW_RENDERFULLCONTENT` 能捕获被遮挡的 WebView2 内容 */
export const PW_RENDERFULLCONTENT = 2;

export function printWindow(hwnd: bigint, hdc: bigint, flags = PW_RENDERFULLCONTENT): boolean {
    return user32.symbols.PrintWindow(hwnd, hdc, flags) === true;
}

// ---- 进程与内存 -------------------------------------------------------------

export const PROCESS_QUERY_INFORMATION = 0x0400;
export const PROCESS_VM_READ = 0x0010;

/** 打开目标的读取句柄；失败返回 0n（调用方可据此区分「权限不足」与「进程不在」） */
export function openProcess(pid: number, access = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ): bigint {
    return toHandle(kernel32.symbols.OpenProcess(access, false, pid));
}

export type MemoryRegion = {
    base: bigint;
    size: bigint;
    state: number;
    protect: number;
    type: number;
};

const MEM_COMMIT = 0x1000;

/**
 * 读 `MEMORY_BASIC_INFORMATION`（x64 下 48 字节）。
 *
 * 字段偏移：base 0、allocBase 8、allocProtect 16、（PartitionId 占 20，
 * 旧定义是 padding）、size 24、state 32、protect 36、type 40。
 * 带与不带 `PartitionId` 的两种定义在 `size` 偏移上一致，所以不必区分。
 */
export function virtualQueryEx(hProcess: bigint, address: bigint): MemoryRegion | null {
    const buf = new Uint8Array(48);
    const n = kernel32.symbols.VirtualQueryEx(hProcess, address, buf, BigInt(buf.length));
    if (typeof n !== "number" || n === 0) return null;
    const view = new DataView(buf.buffer);
    return {
        base: view.getBigUint64(0, true),
        size: view.getBigUint64(24, true),
        state: view.getUint32(32, true),
        protect: view.getUint32(36, true),
        type: view.getUint32(40, true),
    };
}

export function isCommittedRegion(r: MemoryRegion): boolean {
    return r.state === MEM_COMMIT;
}

/** 读目标进程内存；返回实际读到的字节数，0 表示失败 */
export function readProcessMemory(hProcess: bigint, address: bigint, target: Uint8Array): number {
    const read = new Uint8Array(8);
    const ok = kernel32.symbols.ReadProcessMemory(hProcess, address, target, BigInt(target.length), read);
    if (ok !== true) return 0;
    const view = new DataView(read.buffer);
    return Number(view.getBigUint64(0, true));
}

/** 进程创建时间（FILETIME → epoch ms）；失败返回 null */
export function processCreationTime(hProcess: bigint): number | null {
    const creation = new Uint8Array(8);
    const exit = new Uint8Array(8);
    const kernel = new Uint8Array(8);
    const user = new Uint8Array(8);
    const ok = kernel32.symbols.GetProcessTimes(hProcess, creation, exit, kernel, user);
    if (ok !== true) return null;
    const view = new DataView(creation.buffer);
    const filetime = view.getBigUint64(0, true);
    // FILETIME 是 100ns 单位，起点 1601-01-01
    const epoch100ns = 116444736000000000n;
    if (filetime < epoch100ns) return null;
    return Number((filetime - epoch100ns) / 10000n);
}

/** 当前进程所属会话 ID */
export function currentSessionId(): number {
    const pid = kernel32.symbols.GetCurrentProcessId();
    const buf = new Uint32Array(1);
    if (kernel32.symbols.ProcessIdToSessionId(pid, buf) !== true) return -1;
    return buf[0] ?? -1;
}

/** 交互式控制台会话 ID */
export function activeConsoleSessionId(): number {
    const v = kernel32.symbols.WTSGetActiveConsoleSessionId();
    return typeof v === "number" ? v : -1;
}

/** 会话 ID 与当前进程不同 → 跨会话探测，很多 GUI API 会失败 */
export function isCrossSession(pid: number): boolean {
    const self = currentSessionId();
    const buf = new Uint32Array(1);
    if (kernel32.symbols.ProcessIdToSessionId(pid, buf) !== true) return false;
    return (buf[0] ?? self) !== self;
}

// ---- 进程模块（psapi） ------------------------------------------------------

const psapi = dlopen("psapi.dll", {
    EnumProcesses: { args: ["buffer", "u32", "buffer"], returns: "i32" },
    EnumProcessModules: { args: [FFIType.u64_fast, "buffer", "u32", "buffer"], returns: "i32" },
    GetModuleBaseNameW: { args: [FFIType.u64_fast, FFIType.u64_fast, "buffer", "u32"], returns: "u32" },
    GetModuleInformation: {
        args: [FFIType.u64_fast, FFIType.u64_fast, "buffer", "u32"],
        returns: "i32",
    },
});

/** 枚举全部 PID */
export function listPids(): number[] {
    const buf = new Uint32Array(4096);
    const needed = new Uint32Array(1);
    const ok = psapi.symbols.EnumProcesses(buf, buf.byteLength, needed);
    if (ok === 0) return [];
    const count = (needed[0] ?? 0) / 4;
    const out: number[] = [];
    for (let i = 0; i < count && i < buf.length; i++) {
        const v = buf[i];
        if (v !== undefined && v !== 0) out.push(v);
    }
    return out;
}

export type ModuleInfo = { name: string; base: bigint; size: number };

const moduleBuf = new Uint8Array(1024 * 8);
const moduleInfoBuf = new Uint8Array(24);

/** 列出某进程已加载的模块；权限不足时返回空数组 */
export function listModules(hProcess: bigint): ModuleInfo[] {
    const needed = new Uint32Array(1);
    if (psapi.symbols.EnumProcessModules(hProcess, moduleBuf, moduleBuf.byteLength, needed) === 0) {
        return [];
    }
    const count = Math.min((needed[0] ?? 0) / 8, moduleBuf.byteLength / 8);
    const view = new DataView(moduleBuf.buffer);
    const out: ModuleInfo[] = [];
    for (let i = 0; i < count; i++) {
        const hModule = view.getBigUint64(i * 8, true);
        if (hModule === 0n) continue;
        textBuf.fill(0);
        const n = psapi.symbols.GetModuleBaseNameW(hProcess, hModule, textBuf, textBuf.length / 2);
        const name = n > 0 ? readUtf16(textBuf) : "";
        let size = 0;
        let base = hModule;
        if (psapi.symbols.GetModuleInformation(hProcess, hModule, moduleInfoBuf, moduleInfoBuf.length) !== 0) {
            const mview = new DataView(moduleInfoBuf.buffer);
            base = mview.getBigUint64(0, true);
            size = mview.getUint32(16, true);
        }
        out.push({ name, base, size });
    }
    return out;
}

/** 按进程映像名找 PID（不区分大小写，如 `msedgewebview2.exe`） */
export function findPidsByName(exeName: string): number[] {
    const want = exeName.toLowerCase();
    const out: number[] = [];
    for (const pid of listPids()) {
        const h = openProcess(pid, PROCESS_QUERY_INFORMATION);
        if (h === 0n) continue;
        try {
            const mods = listModules(h);
            const first = mods[0];
            if (first && first.name.toLowerCase() === want) out.push(pid);
        } finally {
            closeHandle(h);
        }
    }
    return out;
}

/** 在字节缓冲里找 ASCII 子串，返回首次出现的偏移；找不到返回 -1 */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    if (needle.length === 0) return 0;
    const first = needle[0];
    if (first === undefined) return -1;
    const limit = haystack.length - needle.length;
    for (let i = 0; i <= limit; i++) {
        if (haystack[i] !== first) continue;
        let ok = true;
        for (let j = 1; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return i;
    }
    return -1;
}

/** 释放所有 dlopen 句柄。诊断脚本退出前调用；失败不影响结论 */
export function closeAll(): void {
    for (const lib of [user32, kernel32, psapi]) {
        try {
            lib.close();
        } catch {
            // close 失败说明已经被关过，不改变任何判定
        }
    }
}

export const api = { user32, kernel32, psapi };
export { ptr };
