#!/usr/bin/env bun
/**
 * probe-gui-boundary.ts — 探测当前会话的 GUI 能力边界
 *
 * 替代 `tools/probe-gui-boundary.ps1`。原版七节探测里，五节能一对一映射：
 *
 * | 原版 | 现在 |
 * | --- | --- |
 * | `EnumWindows` 回调 | `listTopLevelWindows()` 迭代 |
 * | `GetForegroundWindow` | 同名声明 |
 * | `OpenInputDesktop` | 同名声明 |
 * | `OpenWindowStation` | 同名声明 |
 * | `WTSGetActiveConsoleSessionId` | 同名声明 |
 *
 * 两节**降级为不实现**，因为它们没有 FFI 等价物：
 *
 * - `CopyFromScreen`（屏幕捕获）：需要屏幕 DC + BitBlt，而本项目已有
 *   `tools/capture-window.ts` 用 `PrintWindow` 做同一件事且不抢前台。
 *   这里只报告「屏幕尺寸」替代。
 * - UI Automation：需要 COM 对象模型，`bun:ffi` 做这件事的复杂度远超收益。
 *   改为报告「UIA 未探测」，而不是假装探测过。**不报告等于诚实**——
 *   假装失败会误导排查方向（`pitfalls` 5.3 的教训）。
 *
 * 用途：对比 Session 0（服务会话）与 Session 1（交互式会话）的能力边界。
 * 见 `ADR 0005`（已废止）与 `AGENTS.md` §5 第 4 条的沿革。
 *
 * 用法：
 *
 *     bun run tools/probe-gui-boundary.ts
 */

import { resolve } from "node:path";

import {
    activeConsoleSessionId,
    closeAll,
    closeHandle,
    currentSessionId,
    foregroundWindow,
    listTopLevelWindows,
    openInputDesktop,
    openWindowStation,
    setDpiAware,
} from "../native/win32";
import { isEntrypoint } from "../scripts/lib/entrypoint";

export type ProbeReport = {
    sessionId: number;
    activeConsoleSession: number;
    visibleTopLevel: number;
    sampleClasses: string[];
    foregroundHwnd: string;
    foregroundPid: number;
    inputDesktop: "AVAILABLE" | "UNAVAILABLE";
    windowStation: "accessible" | "denied";
    notes: string[];
};

/**
 * 收集全部探测结果。
 *
 * 纯副作用函数（会调 Win32），但**把结果收进结构体再打印**——这样
 * 「哪些探测成功了」本身可以被断言，而不只是打给人看。
 */
export function probe(): ProbeReport {
    setDpiAware();

    const self = currentSessionId();
    const all = listTopLevelWindows().filter((w) => w.visible);
    const fg = foregroundWindow();

    const desktop = openInputDesktop();
    const inputDesktop: "AVAILABLE" | "UNAVAILABLE" = desktop !== 0n ? "AVAILABLE" : "UNAVAILABLE";
    if (desktop !== 0n) closeHandle(desktop);

    const station = openWindowStation();
    const windowStation: "accessible" | "denied" = station !== 0n ? "accessible" : "denied";
    if (station !== 0n) closeHandle(station);

    const notes: string[] = [];
    if (self !== activeConsoleSessionId()) {
        notes.push(
            `本进程在 Session ${self}，控制台会话是 ${activeConsoleSessionId()}——跨会话时 GUI API 行为不同`,
        );
    }
    notes.push("CopyFromScreen：未实现（改用 tools/capture-window.ts 的 PrintWindow）");
    notes.push("UI Automation：未探测（需要 COM 对象模型，bun:ffi 成本高于收益）");

    return {
        sessionId: self,
        activeConsoleSession: activeConsoleSessionId(),
        visibleTopLevel: all.length,
        sampleClasses: all.slice(0, 8).map((w) => `${w.className} pid=${w.pid}`),
        foregroundHwnd: `0x${fg.toString(16)}`,
        foregroundPid: fg === 0n ? 0 : (all.find((w) => w.hwnd === fg)?.pid ?? 0),
        inputDesktop,
        windowStation,
        notes,
    };
}

export function formatReport(r: ProbeReport): string[] {
    return [
        `session id               ${r.sessionId}`,
        `active console session   ${r.activeConsoleSession}`,
        "",
        "--- EnumWindows（可见顶层窗口）---",
        `count                    ${r.visibleTopLevel}`,
        ...r.sampleClasses.map((c) => `    ${c}`),
        "",
        "--- GetForegroundWindow ---",
        `hwnd                     ${r.foregroundHwnd}`,
        `pid                      ${r.foregroundPid === 0 ? "(none / 跨会话不可见)" : r.foregroundPid}`,
        "",
        "--- OpenInputDesktop ---",
        `result                   ${r.inputDesktop}`,
        "",
        "--- OpenWindowStation(WinSta0) ---",
        `result                   ${r.windowStation}`,
        "",
        "--- 未探测项 ---",
        ...r.notes.map((n) => `  ${n}`),
    ];
}

export function main(argv: readonly string[]): number {
    for (const raw of argv) {
        const arg = raw.replace(/^-{1,2}/, "").toLowerCase();
        if (arg === "help" || arg === "h") {
            console.log("bun run tools/probe-gui-boundary.ts\n\n无参数。打印当前会话的 GUI 能力边界。");
            return 0;
        }
        if (arg.length > 0) {
            console.error(`unknown argument: ${raw}`);
            return 2;
        }
    }
    for (const line of formatReport(probe())) console.log(line);
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    void resolve;
    try {
        process.exitCode = main(process.argv.slice(2));
    } finally {
        closeAll();
    }
}
