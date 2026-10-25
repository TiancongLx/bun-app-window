/**
 * 真实按键探针：验证快捷键走的是 WebView2 的 `AcceleratorKeyPressed`，而不是 `WM_KEYDOWN`。
 *
 * 为什么非得「真的按一下」：
 *
 * `WM_KEYDOWN` 只投递给**焦点窗口**，而焦点在 WebView2 的渲染子窗口上，它不把未处理
 * 的按键转发给父窗口。于是直接 `PostMessage(hwnd, WM_KEYDOWN, VK_F11)` 能正常全屏、
 * 再发一次能还原——判定逻辑完全正确，而真实按 F11 毫无反应。**断的是消息路由**，
 * 只有系统级输入（`keybd_event`）才能区分这两种情形。
 *
 * 这个探针不进默认门禁，原因有三条：
 *   1. 需要交互式桌面（Session 1）；
 *   2. 会把窗口短暂全屏，不适合无人值守的批量跑；
 *   3. 要临时抢一次前台焦点（用 `AttachThreadInput` 绕开前台锁定）。
 *
 * 前台那一关是必须的：Windows 只允许**当前前台进程**调用 `SetForegroundWindow`
 * 成功，直接调会被静默拒绝。而按键只会投给前台窗口——抢不到焦点就去按键，
 * 等于把 F11 打给了别的应用（实测：浏览器会真的进全屏）。
 *
 * 用法：
 *   bun run scripts/probe-accelerator-keys.ts
 */

import { dlopen } from "bun:ffi";

import { findWindows, foregroundWindow, listChildWindows, toHandle, windowRect } from "../native/win32.ts";
import { FLAG_CENTER, FLAG_RESIZABLE, openShell } from "../src/shell/index.ts";

/** 与 `native/shell.cc` 里的 `handle_accelerator_key` 对齐的虚拟键码 */
const VK_F11 = 0x7a;
const KEYEVENTF_KEYUP = 0x0002;

const user32 = dlopen("user32.dll", {
    keybd_event: { args: ["u8", "u8", "u32", "ptr"], returns: "void" },
    SetForegroundWindow: { args: ["ptr"], returns: "i32" },
    AttachThreadInput: { args: ["u32", "u32", "i32"], returns: "i32" },
    GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
    SetActiveWindow: { args: ["ptr"], returns: "ptr" },
    SetFocus: { args: ["ptr"], returns: "ptr" },
});
const kernel32 = dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: "u32" },
});

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
    checks.push({ name, ok, detail });
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) {
            return true;
        }
        await Bun.sleep(16);
    }
    return cond();
}

/** 发一次真实的按下+抬起。与 SendInput 同层，绕不过焦点窗口的消息链。 */
function pressKey(vk: number): void {
    user32.symbols.keybd_event(vk, 0, 0, 0n);
    user32.symbols.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0n);
}

/**
 * 把窗口抢到前台。
 *
 * `SetForegroundWindow` 直接调会被前台锁定拒绝。`AttachThreadInput` 把本线程的输入
 * 状态挂到当前前台线程上，调用方的「前台身份」于是被临时共享出去——这是老 API，
 * 但仍是唯一不弹窗就能做到的方式。用完必须解挂。
 */
function forceForeground(hwnd: bigint): boolean {
    const fg = foregroundWindow();
    if (fg === hwnd) {
        return true;
    }
    const selfThread = kernel32.symbols.GetCurrentThreadId();
    const fgThread = user32.symbols.GetWindowThreadProcessId(fg, 0n);
    const targetThread = user32.symbols.GetWindowThreadProcessId(hwnd, 0n);

    // 挂到前台线程：临时共享「前台身份」，SetForegroundWindow 才不会被拒
    const attachedFg =
        fgThread !== 0 && fgThread !== selfThread
            ? user32.symbols.AttachThreadInput(selfThread, fgThread, 1) !== 0
            : false;
    // 挂到**目标**线程：SetFocus 只对同线程窗口生效
    const attachedTarget =
        targetThread !== 0 && targetThread !== selfThread
            ? user32.symbols.AttachThreadInput(selfThread, targetThread, 1) !== 0
            : false;

    user32.symbols.SetForegroundWindow(hwnd);
    user32.symbols.SetActiveWindow(hwnd);
    // 注意**不要** SetFocus(hwnd)：那会把焦点按在顶层窗口上，`WM_KEYDOWN` 于是
    // 直接投给 `handle_input_message`——测出来的是旧路径，而不是 AcceleratorKeyPressed。
    // 真实用户是「点一下页面」，焦点落在 WebView2 的渲染子窗口上。

    if (attachedTarget) {
        user32.symbols.AttachThreadInput(selfThread, targetThread, 0);
    }
    if (attachedFg) {
        user32.symbols.AttachThreadInput(selfThread, fgThread, 0);
    }
    return foregroundWindow() === hwnd;
}

/** 把焦点放进 WebView2 的渲染子窗口，复现「用户点了一下页面」。返回落点的类名。 */
function focusPage(hwnd: bigint): string {
    const kids = listChildWindows(hwnd, 6);
    const target = kids.find(
        (c) =>
            c.className.includes("Chrome_RenderWidgetHostHWND") ||
            c.className.includes("Chrome_WidgetWin") ||
            c.className.includes("Intermediate D3D Window"),
    );
    if (!target) {
        return "";
    }
    user32.symbols.SetFocus(toHandle(target.hwnd));
    return target.className;
}

function widthOf(hwnd: bigint): number {
    const r = windowRect(hwnd);
    return r.right - r.left;
}

const title = `probe-kbd-${Date.now()}`;
const shell = await openShell({
    url: "about:blank",
    title,
    width: 900,
    height: 640,
    flags: FLAG_RESIZABLE | FLAG_CENTER,
});

// 同一进程里还有 WebView2 的辅助窗口（矩形为 0、不可见），必须按标题 + 可见性收窄
const mine = (): ReturnType<typeof findWindows> =>
    findWindows(process.pid).filter((w) => w.title === title && w.visible && w.width > 0);

const located = await waitFor(() => mine().length > 0, 5000);
const found = mine()[0];
const hwnd = found ? toHandle(found.hwnd) : 0n;
check("能定位到本进程的窗口", located && hwnd !== 0n, `${found?.width ?? 0}px wide`);

const before = hwnd !== 0n ? widthOf(hwnd) : 0;

let pageFocus = "";
if (hwnd !== 0n) {
    forceForeground(hwnd);
    const focused = await waitFor(() => foregroundWindow() === hwnd, 3000);
    check("窗口成为前台（按键会投给它）", focused, focused ? "" : "非前台");
    // 焦点必须落在渲染子窗口上，否则测的是旧的 WM_KEYDOWN 路径（见 forceForeground 注释）
    pageFocus = focusPage(hwnd);
    check("焦点落在 WebView2 子窗口", pageFocus !== "", pageFocus || "未找到子窗口");
}

if (hwnd !== 0n && foregroundWindow() === hwnd) {
    // 1. 真实按 F11 → 全屏
    pressKey(VK_F11);
    const wentFullscreen = await waitFor(() => widthOf(hwnd) > before + 100, 2000);
    check("真实按 F11 进入全屏", wentFullscreen, `${before}px → ${widthOf(hwnd)}px`);

    // 2. 再按一次 → 还原
    pressKey(VK_F11);
    const restored = await waitFor(() => Math.abs(widthOf(hwnd) - before) <= 2, 2000);
    check("再按一次 F11 还原", restored, `${widthOf(hwnd)}px（原 ${before}px）`);
} else {
    check("真实按 F11 进入全屏", false, "跳过：没拿到前台，按键会打到别的应用");
    check("再按一次 F11 还原", false, "跳过");
}

// 3. 反注册不能把 teardown 弄坏
shell.close();
const gone = await waitFor(() => mine().length === 0, 5000);
check("关闭后窗口消失", gone);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}          ${c.detail}`);
}
console.log(
    failed.length === 0
        ? `\nPROBE PASSED (${checks.length} checks)`
        : `\nPROBE FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
