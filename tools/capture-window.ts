#!/usr/bin/env bun
/**
 * capture-window.ts — 在交互式会话内截取目标窗口（不抢前台）
 *
 * 替代 `tools/capture-window.ps1`。核心手法不变：`PrintWindow(PW_RENDERFULLCONTENT)`
 * 能完整捕获被遮挡的 WebView2 内容（`pitfalls` 1.3 / `ADR 0006`）。
 *
 * 与 PS1 版的差异全在「怎么落盘」：
 *
 * - 原版 `Bitmap.Save(path, ImageFormat.Png)` → 现在 `native/png.ts` 自己编码
 * - 原版 `-Fallback` 退回全屏 `CopyFromScreen` → 现在**不实现全屏退路**：
 *   全屏截图会拍到用户桌面，而本工具的立身之本就是「不干扰远程会话」。
 *   改为明确失败并给出诊断信息（非黑像素占比），让人知道该查什么。
 *
 * 用法：
 *
 *     bun run tools/capture-window.ts --class webview_shell --shot dist/shot.png
 *     bun run tools/capture-window.ts --pid 12345
 *     bun run tools/capture-window.ts --class webview_shell      # 只定位不截图
 *     bun run tools/capture-window.ts --help
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { captureWindow, closeGdi, nonBlackPercent } from "../native/gdi";
import { encodePng, bgraToPng } from "../native/png";
import { closeAll, isIconic, listTopLevelWindows, setDpiAware, type WindowInfo } from "../native/win32";
import { isEntrypoint } from "../scripts/lib/entrypoint";

export type CapturePlan = {
    pid: number;
    className: string;
    shot: string;
    minNonBlackPercent: number;
    waitMs: number;
    help: boolean;
};

export function parseCaptureArgs(argv: readonly string[]): CapturePlan {
    const plan: CapturePlan = {
        pid: 0,
        className: "",
        shot: "",
        // 带 PW_RENDERFULLCONTENT 时实测非黑占比 ~90%；不带时 5.8%。
        // 1% 是「有没有画出东西」的宽松下限（pitfalls 1.3）。
        minNonBlackPercent: 1.0,
        waitMs: 0,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i] ?? "";
        const arg = raw.replace(/^-{1,2}/, "").toLowerCase();
        const needValue = (): string => {
            const v = argv[i + 1];
            if (!v) throw new Error(`${raw} 需要一个值`);
            i++;
            return v;
        };
        if (arg === "help" || arg === "h") {
            plan.help = true;
        } else if (arg === "pid") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n <= 0) throw new Error("--pid 不是合法进程号");
            plan.pid = n;
        } else if (arg === "class") {
            plan.className = needValue();
        } else if (arg === "shot") {
            plan.shot = needValue();
        } else if (arg === "min-nonblack" || arg === "min-nonblack-percent") {
            const n = Number(needValue());
            if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("--min-nonblack 需要 0–100");
            plan.minNonBlackPercent = n;
        } else if (arg === "wait") {
            const n = Number(needValue());
            if (!Number.isFinite(n) || n < 0) throw new Error("--wait 需要非负毫秒");
            plan.waitMs = n;
        } else if (arg.length > 0) {
            throw new Error(`unknown argument: ${raw}`);
        }
    }
    return plan;
}

/** 按 pid / 类名挑目标；宽度或高度为 0 的窗口跳过（不可见或已销毁） */
export function pickTarget(windows: readonly WindowInfo[], plan: CapturePlan): WindowInfo | null {
    const hit = windows.find((w) => {
        if (!w.visible || w.width <= 0 || w.height <= 0) return false;
        if (plan.pid !== 0 && w.pid !== plan.pid) return false;
        if (plan.className && w.className !== plan.className) return false;
        return true;
    });
    return hit ?? null;
}

export type CaptureOutcome =
    | { ok: true; method: "printwindow"; width: number; height: number; nonBlackPercent: number; path: string }
    | { ok: false; error: string; detail: Record<string, unknown> };

/**
 * 执行一次截图。
 *
 * 判定链：找到窗口 → PrintWindow → 算非黑占比 → 过阈值才落盘。
 * 任何一环失败都返回结构化的 `ok:false`，让调用方（含 agent）能区分
 * 「窗口没找到」和「窗口找到了但画不出东西」。
 */
export function capture(
    plan: CapturePlan,
    opts: { windows?: readonly WindowInfo[]; now?: () => number; sleep?: (ms: number) => void } = {},
): CaptureOutcome {
    setDpiAware();
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms));

    const deadline = now() + 6000 + plan.waitMs;
    let target: WindowInfo | null = null;
    let scanned: readonly WindowInfo[] = [];
    // 迭代上限是给注入时钟（或系统时间被改动）准备的第二道保险：
    // 只靠 deadline 的话，一个不前进的 now() 会让这个循环永远转下去。
    // 6000ms / 250ms = 24 次正常上限，给到 64 次足够宽松。
    const maxAttempts = Math.ceil((6000 + plan.waitMs) / 250) + 40;
    let attempts = 0;

    while (true) {
        scanned = opts.windows ?? listTopLevelWindows();
        target = pickTarget(scanned, plan);
        if (target) break;
        if (now() >= deadline || ++attempts > maxAttempts) break;
        sleep(250);
    }

    if (!target) {
        return {
            ok: false,
            error: "target window not found",
            detail: {
                pid: plan.pid,
                class: plan.className,
                visible: scanned
                    .filter((w) => w.visible && w.width > 0 && w.height > 0)
                    .slice(0, 15)
                    .map((w) => `${w.className} pid=${w.pid} ${w.width}x${w.height}`),
            },
        };
    }

    const shot = captureWindow(target.hwnd, { width: target.width, height: target.height });
    if (!shot) {
        return {
            ok: false,
            error: "could not create a DIB of the target size (window vanished or size is zero)",
            detail: { width: target.width, height: target.height, iconic: isIconic(target.hwnd) },
        };
    }

    const pct = nonBlackPercent(shot.bgra, shot.width, shot.height);

    if (!shot.printWindowOk || pct < plan.minNonBlackPercent) {
        return {
            ok: false,
            error:
                "PrintWindow produced no usable content; " +
                "全屏退路已刻意移除（会拍到用户桌面），请检查窗口是否已渲染或目标类名是否正确",
            detail: {
                printWindowOk: shot.printWindowOk,
                nonBlackPercent: Number(pct.toFixed(1)),
                threshold: plan.minNonBlackPercent,
                width: shot.width,
                height: shot.height,
            },
        };
    }

    const png = encodePng(
        bgraToPng(shot.bgra, shot.width, shot.height, "rgb"),
        "rgb",
    );
    const outPath = resolve(plan.shot);
    if (plan.shot) {
        mkdirSync(dirname(outPath), { recursive: true });
        Bun.write(outPath, png);
    }

    return {
        ok: true,
        method: "printwindow",
        width: shot.width,
        height: shot.height,
        nonBlackPercent: Number(pct.toFixed(1)),
        path: plan.shot ? outPath : "",
    };
}

function printHelp(): void {
    console.log(`bun run tools/capture-window.ts [options]

  --pid <n>                 目标进程号
  --class <name>            目标窗口类名（webview_shell / webview）
  --shot <path>             截图输出路径；省略则只定位不截图
  --min-nonblack <pct>      判定 PrintWindow 成功的非黑像素阈值（默认 1.0）
  --wait <ms>               定位窗口的额外等待（默认 0，上限受 6s 基础预算约束）
  --help                    显示本帮助

退出码：0 成功，1 未找到窗口，2 参数错误，4 PrintWindow 无内容。`);
}

export function main(argv: readonly string[]): number {
    let plan: CapturePlan;
    try {
        plan = parseCaptureArgs(argv);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const outcome = capture(plan);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.ok) return 0;
    return outcome.error === "target window not found" ? 1 : 4;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } finally {
        closeGdi();
        closeAll();
    }
}
