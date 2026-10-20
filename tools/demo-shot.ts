#!/usr/bin/env bun
/**
 * demo-shot.ts — 一条命令拿到自检窗口的截图
 *
 * 2026-10-21 之前，「起 demo → 最大化 → 截图」这件事被临时脚本写了三次，
 * 每次都要重踩同一组坑：`HOLD` 下的窗口可见性、按类名而非 PID 找窗口、
 * 最大化之后要等布局、demo 进程必须回收。这个工具把它们固化成一条命令。
 *
 * 用法：
 *
 *     bun run tools/demo-shot.ts                              # → %TEMP%/demo-shot.png
 *     bun run tools/demo-shot.ts --shot dist/shot.png
 *     bun run tools/demo-shot.ts --crop 700,300,800,600       # 只看一块
 *     bun run tools/demo-shot.ts --no-maximize                # 保持初始 1000x680
 *     bun run tools/demo-shot.ts --keep                       # 截完不关窗口
 *
 * ## 三个刻意的设计决定
 *
 * 1. **自己 spawn `src/host.ts`，不走 `bun run demo`。**
 *    `demo` 是 `bun run ./src/host.ts`，中间会多一层 bun 进程；
 *    杀掉第一层会留下孤儿持有窗口。直接用当前解释器跑 ts 只有一层。
 *
 * 2. **用 `HOLD=1`。**
 *    非 HOLD 模式在 1800 ms 后自己 `toggleMaximize`、1400 ms 后再还原，
 *    时机完全不可控。HOLD 保持窗口不动，但**只有 25 秒**——所以本工具
 *    必须在 25 秒内完成，`--keep` 也受这个限制。
 *
 * 3. **按窗口类名找，不按 PID。**
 *    类名（`webview_shell`）是稳定的公开约定，见 `AGENTS.md` §6；
 *    PID 要跨进程传，而 Windows 上父进程拿不到孙进程的 PID。
 *
 * ## 与 capture-window 的关系
 *
 * 截图这一步完全复用 `tools/capture-window.ts` 的 `capture()`——本文件只管
 * 编排（起进程、等窗口、最大化、清理），不重复像素与编码逻辑。
 */

import { resolve } from "node:path";

import { closeGdi, parseCrop } from "../native/gdi";
import {
    SW_MAXIMIZE,
    closeAll,
    isZoomed,
    listTopLevelWindows,
    setDpiAware,
    showWindow,
    type WindowInfo,
} from "../native/win32";
import { isEntrypoint } from "../scripts/lib/entrypoint";
import { capture, type CaptureOutcome, type CapturePlan } from "./capture-window";

/** 仓库根：本文件在 `tools/` 下，上一层就是仓库根 */
const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * 窗口可见之后等一帧稳定的时长。
 *
 * 两个场景共用同一段等待，原因不同但结论一致：
 *
 * - **最大化时**：`ShowWindow(SW_MAXIMIZE)` → `WM_SIZE` → `fit_widget()` →
 *   `put_Bounds` → 页面重排。实测 500 ms 时偶发抓到重排中的中间帧，700 ms 起稳定。
 * - **不最大化时**：窗口刚 `show` 出来，页面还没绘制。实测 `PrintWindow` 抓到
 *   全黑（`nonBlackPercent = 0`），而 `printWindowOk` 却是 `true`——
 *   也就是说「没画」不会报错，只会给一张纯黑的图。
 *
 * 取 800 留一点余量。这个常量不能只在最大化分支里用。
 */
const SETTLE_MS = 800;

/** 等窗口出现的轮询间隔 */
const POLL_INTERVAL_MS = 120;

export type DemoShotPlan = {
    /** 目标窗口类名（`webview_shell` / `webview`） */
    className: string;
    /** 截图输出路径；为空时用 `%TEMP%/demo-shot.png` */
    shot: string;
    /** 最大化后再截 */
    maximize: boolean;
    crop: { x: number; y: number; width: number; height: number } | null;
    maxEdge: number;
    format: "png" | "palette" | "jpeg" | "webp";
    level: number;
    quality: number;
    /** 等窗口的上限；超过即失败，不去撞 demo 自己的 25 秒 HOLD */
    timeoutMs: number;
    /** 截图后不结束 demo 进程 */
    keep: boolean;
    help: boolean;
};

export function parseDemoShotArgs(argv: readonly string[]): DemoShotPlan {
    const plan: DemoShotPlan = {
        className: "webview_shell",
        shot: "",
        // 默认最大化：绝大多数调用要的是「整窗」，而不是初始 1000×680
        maximize: true,
        crop: null,
        // 1300 是视觉模型侧的规范化上界；提前缩到这里省上传字节与轮次驻留
        maxEdge: 1300,
        format: "png",
        level: 6,
        quality: 85,
        timeoutMs: 15000,
        keep: false,
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
        } else if (arg === "class") {
            plan.className = needValue();
        } else if (arg === "shot") {
            plan.shot = needValue();
        } else if (arg === "maximize") {
            plan.maximize = true;
        } else if (arg === "no-maximize") {
            plan.maximize = false;
        } else if (arg === "crop") {
            plan.crop = parseCrop(needValue());
        } else if (arg === "max-edge") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 0) throw new Error("--max-edge 需要非负整数（0 = 不缩）");
            plan.maxEdge = n;
        } else if (arg === "format") {
            const v = needValue().toLowerCase();
            if (v !== "png" && v !== "palette" && v !== "jpeg" && v !== "webp") {
                throw new Error(`--format 只支持 png / palette / jpeg / webp，收到 ${v}`);
            }
            plan.format = v;
        } else if (arg === "level") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("--level 需要 1–9");
            plan.level = n;
        } else if (arg === "quality") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("--quality 需要 1–100");
            plan.quality = n;
        } else if (arg === "timeout") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 1000 || n > 24000) {
                // 上限 24 秒：demo 的 HOLD 是 25 秒，超了就没窗口可等
                throw new Error("--timeout 需要 1000–24000 毫秒（demo 的 HOLD 只有 25 秒）");
            }
            plan.timeoutMs = n;
        } else if (arg === "keep") {
            plan.keep = true;
        } else if (arg.length > 0) {
            throw new Error(`unknown argument: ${raw}`);
        }
    }
    return plan;
}

/** 默认截图落点：`%TEMP%` 下，不污染仓库 */
export function defaultShotPath(env: Record<string, string | undefined> = process.env): string {
    const tmp = env.TEMP ?? env.TMP ?? ".";
    return resolve(tmp, "demo-shot.png");
}

/**
 * 把 demo-shot 的选项映射成 `capture()` 的 plan。
 *
 * 三个字段是刻意的固定值，不从外部透传：
 *
 * - `pid: 0` —— 按类名找，见文件头的设计决定 3
 * - `waitMs: 0` —— 调用方已经等到窗口了，不必让 `capture()` 再等
 * - `minNonBlackPercent: 1.0` —— 沿用 capture-window 的「有没有画出东西」下限，
 *   demo 页面是深色底，阈值调高会误判
 */
export function buildCapturePlan(plan: DemoShotPlan, shotPath: string): CapturePlan {
    return {
        pid: 0,
        className: plan.className,
        shot: shotPath,
        minNonBlackPercent: 1.0,
        waitMs: 0,
        crop: plan.crop,
        maxEdge: plan.maxEdge,
        format: plan.format,
        level: plan.level,
        quality: plan.quality,
        help: false,
    };
}

/** 在已扫描的窗口里挑目标；只认可见且有尺寸的 */
export function pickDemoWindow(
    windows: readonly WindowInfo[],
    className: string,
): WindowInfo | null {
    const hit = windows.find(
        (w) => w.className === className && w.visible && w.width > 0 && w.height > 0,
    );
    return hit ?? null;
}

export type DemoShotOutcome =
    | {
          ok: true;
          /** 窗口侧的事实：类名、尺寸、最大化是否真的生效 */
          window: {
              className: string;
              title: string;
              width: number;
              height: number;
              maximized: boolean;
              visible: boolean;
          };
          /** 截图侧的事实，来自 capture() */
          capture: Extract<CaptureOutcome, { ok: true }>;
      }
    | { ok: false; error: string; detail: Record<string, unknown> };

function sleepSync(ms: number): void {
    Bun.sleepSync(ms);
}

/** 起 demo：当前解释器 + 直接跑 ts，只有一层进程 */
function spawnDemo(repoRoot: string): ReturnType<typeof Bun.spawn> {
    // stdout / stderr 必须不管：本工具要往 stdout 写 JSON，子进程日志会污染它
    return Bun.spawn([process.execPath, "src/host.ts"], {
        cwd: repoRoot,
        env: { ...process.env, HOLD: "1" },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
    });
}

/** 结束 demo 并等它真的退出，避免留下持有窗口的孤儿 */
async function stopDemo(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
        proc.kill();
    } catch {
        // 已经退出；kill 抛错不改变任何判定
    }
    // 等 2 秒；超时说明它卡住了，此时强杀
    const settled = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    if (!settled) {
        try {
            proc.kill(9);
        } catch {
            // 同上
        }
        await proc.exited.catch(() => {});
    }
}

/**
 * 执行一次「起 demo → 最大化 → 截图」。
 *
 * 失败路径全部返回结构化 `ok:false`，让调用方（含 agent）能区分
 * 「窗口没起来」与「窗口起来了但截图失败」。
 */
export async function demoShot(
    plan: DemoShotPlan,
    deps: {
        repoRoot?: string;
        /** 注入用：默认 `spawnDemo` */
        spawn?: (repoRoot: string) => ReturnType<typeof Bun.spawn>;
        /** 注入用：默认 `Bun.sleepSync` —— 测试里换成空实现以免真的等待 */
        sleep?: (ms: number) => void;
        /** 注入用：默认 `performance.now` */
        now?: () => number;
    } = {},
): Promise<DemoShotOutcome> {
    setDpiAware();
    const repoRoot = deps.repoRoot ?? REPO_ROOT;
    const spawn = deps.spawn ?? spawnDemo;
    const sleep = deps.sleep ?? sleepSync;
    const now = deps.now ?? (() => performance.now());

    const shotPath = plan.shot ? resolve(plan.shot) : defaultShotPath();
    const proc = spawn(repoRoot);

    try {
        // ---- 1. 等窗口 ----
        const deadline = now() + plan.timeoutMs;
        let target: WindowInfo | null = null;
        let scanned: readonly WindowInfo[] = [];
        // 与 capture-window 同理：注入的时钟可能不前进，必须另有迭代上限
        let attempts = 0;
        const maxAttempts = Math.ceil(plan.timeoutMs / POLL_INTERVAL_MS) + 20;

        while (true) {
            scanned = listTopLevelWindows();
            target = pickDemoWindow(scanned, plan.className);
            if (target) break;
            if (now() >= deadline || ++attempts > maxAttempts) break;
            sleep(POLL_INTERVAL_MS);
        }

        if (!target) {
            return {
                ok: false,
                error: "demo window did not appear",
                detail: {
                    className: plan.className,
                    timeoutMs: plan.timeoutMs,
                    // 把「当时有哪些同族窗口」报出来：最常见的原因是类名传错
                    // （无边框是 webview_shell，带边框是 webview）
                    candidates: scanned
                        .filter((w) => w.className.startsWith("webview"))
                        .slice(0, 10)
                        .map((w) => `${w.className} visible=${w.visible} ${w.width}x${w.height}`),
                },
            };
        }

        // ---- 2. 最大化（可选）----
        //
        // 判据是 `showWindow()` 内部的 `IsWindowVisible` 复核结果，
        // 不是 `ShowWindow` 的返回值——后者给的是「之前是否可见」。
        // 见 docs/pitfalls.md 2.9。
        if (plan.maximize) {
            const visible = showWindow(target.hwnd, SW_MAXIMIZE);
            if (!visible) {
                return {
                    ok: false,
                    error: "window exists but could not be made visible",
                    detail: {
                        hwnd: `0x${target.hwnd.toString(16)}`,
                        className: target.className,
                        maximized: isZoomed(target.hwnd),
                    },
                };
            }
        }

        // 无论是否最大化都要等：不最大化时窗口刚 show 出来还没绘制，
        // PrintWindow 会给一张全黑的图而 printWindowOk 仍为 true。
        sleep(SETTLE_MS);

        // 最大化会改变尺寸，重新扫一遍拿真值（不要用最大化之前的矩形）
        const after = listTopLevelWindows().find((w) => w.hwnd === target!.hwnd);
        if (!after) {
            return {
                ok: false,
                error: "window vanished between maximize and capture",
                detail: { hwnd: `0x${target.hwnd.toString(16)}` },
            };
        }

        // ---- 3. 截图（复用 capture-window 的全部逻辑）----
        const outcome = await capture(buildCapturePlan(plan, shotPath));
        if (!outcome.ok) {
            return {
                ok: false,
                error: `capture failed: ${outcome.error}`,
                detail: { ...outcome.detail, window: describeWindow(after) },
            };
        }

        return {
            ok: true,
            window: describeWindow(after),
            capture: outcome,
        };
    } finally {
        // 无论成功失败都要回收：失败时留下窗口比失败本身更麻烦
        if (!plan.keep) {
            await stopDemo(proc);
        }
    }
}

/** 窗口快照，供报告与断言使用 */
function describeWindow(w: WindowInfo): {
    className: string;
    title: string;
    width: number;
    height: number;
    maximized: boolean;
    visible: boolean;
} {
    return {
        className: w.className,
        title: w.title,
        width: w.width,
        height: w.height,
        // 注意用 IsZoomed 复核，不要从「尺寸等于工作区」反推
        maximized: isZoomed(w.hwnd),
        visible: w.visible,
    };
}

function printHelp(): void {
    console.log(`bun run tools/demo-shot.ts [options]

  --shot <path>             截图输出路径（默认 %TEMP%/demo-shot.png）
  --class <name>            目标窗口类名（默认 webview_shell）
  --maximize / --no-maximize  最大化后再截（默认开启）
  --crop <x,y,w,h>          只输出这一块，1:1 不缩放
  --max-edge <px>           输出长边上限（默认 1300）
  --format <fmt>            png / palette / jpeg / webp（默认 png）
  --level <1-9>             png 的 zlib 压缩级别（默认 6）
  --quality <1-100>         jpeg / webp 质量（默认 85）
  --timeout <ms>            等窗口出现的上限，1000–24000（默认 15000）
  --keep                    截图后不结束 demo 进程
  --help                    显示本帮助

## 它替你做的事

1. 以 HOLD 模式起 \`src/host.ts\`（不自己切换最大化/还原，时机可控）
2. 按窗口类名等到窗口出现
3. 需要时最大化，并等布局稳定
4. 调用 capture-window 的 capture() 落盘
5. 无论成功失败都回收 demo 进程

## 两条限制值得先知道

- **demo 的 HOLD 只有 25 秒**，所以 \`--timeout\` 上限是 24 秒，
  \`--keep\` 之后窗口也只再活 25 秒。
- **需要交互式桌面**。与 \`bun run demo\` 同前提，因此不进默认门禁。

退出码：0 成功，1 窗口没出现，2 参数错误，3 窗口不可见，4 截图失败。`);
}

export async function main(argv: readonly string[]): Promise<number> {
    let plan: DemoShotPlan;
    try {
        plan = parseDemoShotArgs(argv);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const outcome = await demoShot(plan);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.ok) return 0;
    if (outcome.error === "demo window did not appear") return 1;
    if (outcome.error.startsWith("capture failed")) return 4;
    return 3;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    try {
        process.exitCode = await main(process.argv.slice(2));
    } finally {
        closeGdi();
        closeAll();
    }
}
