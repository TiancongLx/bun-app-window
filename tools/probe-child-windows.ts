#!/usr/bin/env bun
/**
 * probe-child-windows.ts — 枚举目标进程的窗口层级与实际矩形
 *
 * 替代 `tools/probe-child-windows.ps1`。原版两个 `EnumWindows` /
 * `EnumChildWindows` 回调换成迭代（`GetTopWindow` / `GetWindow(GW_CHILD)`），
 * 理由见 `native/win32.ts` 的模块注释。
 *
 * 用途：排查 `webview_shell` 与 WebView2 widget 子窗口的几何关系。
 * 尤其在验证 `pitfalls` 2.6（缩放边框命中需要 widget 子类化）时，
 * 需要看清 widget 的实际客户区尺寸。
 *
 * 用法：
 *
 *     bun run tools/probe-child-windows.ts --pid 12345
 *     bun run tools/probe-child-windows.ts --class webview_shell
 */

import { resolve } from "node:path";

import {
    closeAll,
    listChildWindows,
    listTopLevelWindows,
    setDpiAware,
    type WindowInfo,
} from "../native/win32";
import { isEntrypoint } from "../scripts/lib/entrypoint";

export type ProbePlan = { pid: number; className: string; help: boolean };

export function parseArgs(argv: readonly string[]): ProbePlan {
    const plan: ProbePlan = { pid: 0, className: "", help: false };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i] ?? "";
        const arg = raw.replace(/^-{1,2}/, "").toLowerCase();
        if (arg === "help" || arg === "h") {
            plan.help = true;
            continue;
        }
        if (arg === "pid") {
            const v = argv[i + 1];
            if (!v) throw new Error("--pid 需要一个数字");
            const n = Number(v);
            if (!Number.isInteger(n) || n <= 0) throw new Error(`--pid 不是合法进程号: ${v}`);
            plan.pid = n;
            i++;
            continue;
        }
        if (arg === "class") {
            const v = argv[i + 1];
            if (!v) throw new Error("--class 需要一个类名");
            plan.className = v;
            i++;
            continue;
        }
        if (arg.length > 0) throw new Error(`unknown argument: ${raw}`);
    }
    return plan;
}

/** 一行窗口摘要 */
export function formatWindow(w: WindowInfo, indent = ""): string[] {
    const lines = [
        `${indent}${w.className.padEnd(30)} visible=${String(w.visible).padEnd(5)} win=${w.width}x${w.height} at ${w.rect.left},${w.rect.top}`,
    ];
    if (w.title.length > 0) lines.push(`${indent}  title: ${w.title}`);
    return lines;
}

function printHelp(): void {
    console.log(`bun run tools/probe-child-windows.ts [options]

  --pid <n>       目标进程号
  --class <name>  目标窗口类名（如 webview_shell / webview）
  --help          显示本帮助

两个都不给时列出全部可见顶层窗口，供你挑目标。`);
}

export function main(argv: readonly string[]): number {
    let plan: ProbePlan;
    try {
        plan = parseArgs(argv);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    // 不声明 DPI 感知时 GetWindowRect 返回逻辑像素，与客户区尺寸对不上
    setDpiAware();

    const all = listTopLevelWindows();
    const matched = all.filter((w) => {
        if (plan.pid !== 0 && w.pid !== plan.pid) return false;
        if (plan.className && w.className !== plan.className) return false;
        return true;
    });

    if (matched.length === 0) {
        console.log(`no match (pid=${plan.pid || "any"} class=${plan.className || "any"})`);
        console.log("");
        console.log("visible top-level windows:");
        for (const w of all.filter((x) => x.visible && x.width > 0 && x.height > 0).slice(0, 20)) {
            console.log(`  ${w.className.padEnd(30)} pid=${String(w.pid).padEnd(8)} ${w.width}x${w.height}`);
        }
        return 1;
    }

    console.log(`matched top-level windows: ${matched.length}`);
    for (const w of matched) {
        for (const line of formatWindow(w)) console.log(line);
        const kids = listChildWindows(w.hwnd);
        console.log(`  child windows: ${kids.length}`);
        for (const k of kids) {
            for (const line of formatWindow(k, "    ")) console.log(line);
        }
        console.log("");
    }
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
