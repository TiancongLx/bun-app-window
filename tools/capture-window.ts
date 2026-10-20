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

import { captureWindow, closeGdi, cropBgra, nonBlackPercent, parseCrop } from "../native/gdi";
import { estimateImageTokens, toModelImage, type ModelImageResult } from "../native/model-image";
import { encodePng, bgraToPng } from "../native/png";
import { downscaleBgra, fitInside } from "../native/resample";
import { closeAll, isIconic, listTopLevelWindows, setDpiAware, type WindowInfo } from "../native/win32";
import { isEntrypoint } from "../scripts/lib/entrypoint";

export type CapturePlan = {
    pid: number;
    className: string;
    shot: string;
    minNonBlackPercent: number;
    waitMs: number;
    /**
     * 裁剪区域（原图像素坐标）。给了就只输出这一块，**1:1 不缩放**。
     *
     * 这是「低成本看图」的首选手段：把整张缩到 800 长边字节是小了，但文字也糊了；
     * 只裁关心的那块，既小又清晰。`--max-edge` 仍可叠加，用于裁剪后再缩。
     */
    crop: { x: number; y: number; width: number; height: number } | null;
    /**
     * 输出的长边上限。默认 0（不缩）——裁剪之后通常已经够小，
     * 再缩只会把文字弄糊。整窗概览时才给 1024 之类。
     */
    maxEdge: number;
    /**
     * 输出格式。默认 `png` —— 走自家编码器（原始 BGRA 直编，不绕 Bun.Image 的解码）。
     *
     * 实测自家 PNG 比 `Bun.Image` 的 PNG **快 7–12 倍且更小**。
     * `palette` 体积最小但慢一个数量级（裁剪 800×600：198 ms vs 自家 6 ms），
     * 只在归档 / 长对话时按需选。
     *
     * 注意：**缩放不改变编码路线**。「缩小 + png」由 `native/resample.ts` 承担，
     * 同样不碰 `Bun.Image`（见 `pitfalls` 3.16）。
     */
    format: "png" | "palette" | "jpeg" | "webp";
    /**
     * zlib 压缩级别 1–9。默认 6。
     *
     * 实测（5 次取中位数，`docs/pitfalls.md` 3.14）：
     *
     *     level   裁剪 ms / KiB    全窗 ms / KiB
     *     1        3.2 /  90       22.0 / 617
     *     3        5.1 /  67       30.7 / 429
     *     6        6.0 /  62       39.0 / 392     ← 默认
     *     9       23.6 /  54      186.2 / 353
     *
     * 6 比 1 只慢约 3 ms 却小 31%，比 9 快 4 倍只大 13%。
     * 逐帧截图要的是「延迟 + 字节」双低，6 是拐点。
     */
    level: number;
    quality: number;
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
        crop: null,
        maxEdge: 0,
        format: "png",
        // 拐点值，见 `CapturePlan.level` 的实测表；不是「越小越好」也不是「越大越好」。
        level: 6,
        quality: 85,
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
        } else if (arg === "crop") {
            plan.crop = parseCrop(needValue());
        } else if (arg === "min-nonblack" || arg === "min-nonblack-percent") {
            const n = Number(needValue());
            if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("--min-nonblack 需要 0–100");
            plan.minNonBlackPercent = n;
        } else if (arg === "wait") {
            const n = Number(needValue());
            if (!Number.isFinite(n) || n < 0) throw new Error("--wait 需要非负毫秒");
            plan.waitMs = n;
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
        } else if (arg === "quality") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("--quality 需要 1–100");
            plan.quality = n;
        } else if (arg === "level") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error("--level 需要 1–9");
            plan.level = n;
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
    | {
          ok: true;
          method: "printwindow";
          /** 抓取时的原始窗口尺寸 */
          width: number;
          height: number;
          /** 是否应用了 `--crop` */
          cropped: boolean;
          /** 落盘产物的尺寸（受 --crop / --max-edge 影响） */
          outWidth: number;
          outHeight: number;
          outBytes: number;
          /** base64 后的字节数——OWUI 把历史消息留在内存里，这个数才是真正的成本 */
          outBase64Bytes: number;
          format: string;
          estimatedTokens: number;
          nonBlackPercent: number;
          path: string;
      }
    | { ok: false; error: string; detail: Record<string, unknown> };

export type EncoderRoute = "own" | "bun-image";

/**
 * 选编码路线。签名只有 `format` —— `maxEdge` 传不进来，这类 bug 在类型层面不可复现。
 *
 * 判据的两个方向都有实测支撑（`pitfalls` 3.14 / 3.16）：truecolor PNG 自家编码
 * 比 `Bun.Image` 快 7–12 倍且更小；缩小由 `downscaleBgra` 的面积平均承担
 * （`lanczos3` 的振铃反而让图更大）。`Bun.Image` 只保留自家做不到的三件事：
 * palette 量化、jpeg / webp 编码。
 *
 * 历史：这条判据曾经是内联的
 *
 * ```ts
 * if (needsDownscale && target && plan.format === "png") { /* 自家 *\/ }
 * else if (plan.maxEdge > 0 || plan.format !== "png") { /* Bun.Image *\/ }
 * else { /* 自家 *\/ }
 * ```
 *
 * 中间那句 `plan.maxEdge > 0 ||` 是错的：窗口比上限还小时 `needsDownscale` 为假，
 * 于是「png + 给了 maxEdge」掉进 Bun.Image 分支——**不需要缩放却绕道重编了一次**。
 * 实测同一个 800×1032 窗口：不带 `--max-edge` 是 15,409 B，带 `--max-edge 1300`
 * 变成 17,601 B（大 14%），因为编码器换了。
 */
export function pickEncoder(format: CapturePlan["format"]): EncoderRoute {
    return format === "png" ? "own" : "bun-image";
}

/**
 * 执行一次截图。
 *
 * 判定链：找到窗口 → PrintWindow → 算非黑占比 → 过阈值才落盘。
 * 任何一环失败都返回结构化的 `ok:false`，让调用方（含 agent）能区分
 * 「窗口没找到」和「窗口找到了但画不出东西」。
 *
 * 落盘前会按 `--max-edge` / `--format` 压成模型友好尺寸，路线由 {@link pickEncoder}
 * 决定：`png` 全程走自家（缩不缩都不碰 `Bun.Image`），其余交给它。
 *
 * 提前缩到视觉模型的规范化上界（约 1300）是有意义的：模型侧无论如何都会缩，
 * 但在本地缩能省掉**上传字节**和**轮次驻留**（OWUI 把历史消息留在后端内存里，
 * base64 后每轮反复携带）。
 *
 * 注意 1300 长边**不等于**吃满 1024 token：token 按面积折算，1300×1300 才满，
 * 而 16:10 的屏幕缩到 1300 长边只有 1.01 MP，实测 611 token。
 */
export async function capture(
    plan: CapturePlan,
    opts: { windows?: readonly WindowInfo[]; now?: () => number; sleep?: (ms: number) => void } = {},
): Promise<CaptureOutcome> {
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

    // 先裁剪，再决定要不要缩。
    //
    // 顺序不能反：裁剪是「只看关心的那块」，1:1 清晰；缩放是「全都看但都糊」。
    // 对 Computer Use 这类场景，裁剪才是主路径。
    const outPath = resolve(plan.shot);
    let pixels = { bgra: shot.bgra, width: shot.width, height: shot.height };
    let cropped = false;
    if (plan.crop) {
        const c = cropBgra(shot.bgra, shot.width, shot.height, plan.crop);
        if (!c) {
            return {
                ok: false,
                error: "crop rectangle lies outside the captured image",
                detail: {
                    requested: plan.crop,
                    captured: { width: shot.width, height: shot.height },
                },
            };
        }
        pixels = c;
        cropped = true;
    }

    let model: ModelImageResult = {
        bytes: new Uint8Array(0),
        width: pixels.width,
        height: pixels.height,
        format: "png",
        estimatedTokens: estimateImageTokens(pixels.width, pixels.height),
    };

    if (plan.shot) {
        // 两条路，判据只有一个：**格式**。见 pickEncoder 的注释——
        // 这里曾经还看 `plan.maxEdge`，于是「窗口比上限小 + 给了 maxEdge」
        // 会绕道 Bun.Image 重编一次（实测大 14%）。
        const target =
            plan.maxEdge > 0 ? fitInside(pixels.width, pixels.height, plan.maxEdge) : null;
        const needsDownscale =
            target !== null && (target.width < pixels.width || target.height < pixels.height);

        if (pickEncoder(plan.format) === "own") {
            // 自家链路：缩就 downscaleBgra（面积平均），不缩就原样，都不碰 Bun.Image。
            //
            // 实测对比（3098×1850 → 1300×776，5 次取中位数）：
            //
            //     route                    ms        bytes
            //     自家 downscaleBgra        45.9     102,036
            //     Bun.Image resize + png    95.9     222,621
            //
            // 快 2.1 倍、小 2.2 倍。快是因为省掉「编码成 PNG 再解码」这一圈；
            // 小是因为它默认 lanczos3 —— 锐化滤波器在文字边缘产生振铃，
            // 高频细节反而更难压。面积平均对 UI 截图两头都占优。
            const src =
                needsDownscale && target
                    ? downscaleBgra(
                          pixels.bgra,
                          pixels.width,
                          pixels.height,
                          target.width,
                          target.height,
                      )
                    : pixels;
            if (!src) {
                return {
                    ok: false,
                    error: "downscale rejected the requested size",
                    detail: {
                        from: { width: pixels.width, height: pixels.height },
                        to: target,
                    },
                };
            }
            model = {
                bytes: encodePng(
                    bgraToPng(src.bgra, src.width, src.height, "rgb"),
                    "rgb",
                    plan.level,
                ),
                width: src.width,
                height: src.height,
                format: "png",
                estimatedTokens: estimateImageTokens(src.width, src.height),
            };
        } else {
            // Bun.Image：palette 量化、jpeg / webp 编码——这三件自家做不到。
            // 注意它吃的是**已编码字节**，所以这条路必然多一次解码。
            model = await toModelImage(
                encodePng(bgraToPng(pixels.bgra, pixels.width, pixels.height, "rgb"), "rgb", plan.level),
                {
                    maxEdge: plan.maxEdge,
                    format: plan.format,
                    quality: plan.quality,
                },
            );
        }
        mkdirSync(dirname(outPath), { recursive: true });
        await Bun.write(outPath, model.bytes);
    }

    return {
        ok: true,
        method: "printwindow",
        width: shot.width,
        height: shot.height,
        cropped,
        outWidth: model.width,
        outHeight: model.height,
        outBytes: model.bytes.length,
        /** base64 后的字节数——OWUI 把历史消息留在内存里，这个数才是真正的成本 */
        outBase64Bytes: Math.ceil(model.bytes.length / 3) * 4,
        format: model.format,
        estimatedTokens: model.estimatedTokens,
        nonBlackPercent: Number(pct.toFixed(1)),
        path: plan.shot ? outPath : "",
    };
}

function printHelp(): void {
    console.log(`bun run tools/capture-window.ts [options]

  --pid <n>                 目标进程号
  --class <name>            目标窗口类名（webview_shell / webview）
  --shot <path>             截图输出路径；省略则只定位不截图
  --crop <x,y,w,h>          只输出这一块，1:1 不缩放（低成本首选）
  --max-edge <px>           输出长边上限（默认 0 = 不缩）
  --format <fmt>            png / palette / jpeg / webp（默认 png）
  --level <1-9>             png 的 zlib 压缩级别（默认 6）
  --quality <1-100>         jpeg / webp 质量（默认 85）
  --min-nonblack <pct>      判定 PrintWindow 成功的非黑像素阈值（默认 1.0）
  --wait <ms>               定位窗口的额外等待（默认 0，上限受 6s 基础预算约束）
  --help                    显示本帮助

## 默认值是怎么定的

两条判据同时看：**延迟**和**字节**。

- 延迟：每次截图都要付一次。
- 字节：OWUI 把历史消息留在后端内存里，图片作为 base64 在之后每一轮被反复
  携带（再膨胀 4/3）。一张图是**复利成本**，不是一次性成本。

实测（3098×1850 真实窗口，裁剪区 800×600，5 次取中位数）：

  route                    全窗 ms / KiB     裁剪 ms / KiB
  自家 encodePng lv1        22.0 / 617        3.2 /  90
  自家 encodePng lv6        39.0 / 392        6.0 /  62    ← 默认
  自家 encodePng lv9       186.2 / 353       23.6 /  54
  Bun.Image png            458.3 / 531       40.0 /  84
  Bun.Image jpeg q85        23.8 / 406        4.0 /  67
  Bun.Image palette 256   2590.7 / 180      198.2 /  32

三条结论：

  1. **裁剪是主力手段** —— 全窗 392 KiB 缩到裁剪 62 KiB，时间同时从 39 ms 降到 6 ms。
  2. **level 6 是拐点** —— 比 1 只慢约 3 ms 却小 31%，比 9 快 4 倍只大 13%。
  3. **自家编码器胜过 Bun.Image 的 PNG**（快 7–12 倍且更小）。

## 缩放也是自家做

「缩小 + png」两个条件同时成立时，走 native/resample.ts 的面积平均降采样，
全程不碰 Bun.Image（实测 45.9 ms / 102 KB，对比它的 95.9 ms / 222 KB）。
Bun.Image 只保留自家做不到的：放大、palette 量化、jpeg / webp。

缩小会丢分辨率（而且重采样产生的中间色会让 palette 量化更差），裁剪不会。
所以「只看关心的那块」优于「全都看但都糊」。视觉模型侧的规范化上界约 1300，
提前缩到这里既不浪费上传字节，也不会被模型再缩一次。

退出码：0 成功，1 未找到窗口，2 参数错误，4 PrintWindow 无内容。`);
}

export async function main(argv: readonly string[]): Promise<number> {
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

    const outcome = await capture(plan);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.ok) return 0;
    return outcome.error === "target window not found" ? 1 : 4;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    try {
        process.exitCode = await main(process.argv.slice(2));
    } finally {
        closeGdi();
        closeAll();
    }
}
