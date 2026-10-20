#!/usr/bin/env bun
/**
 * make-icon.ts — 生成多尺寸 ICO（PNG 载荷），供 `bun build --windows-icon` 使用
 *
 * 替代 `scripts/make-icon.ps1`。这是整批迁移里唯一需要**自己光栅化**的脚本：
 * 原版靠 `System.Drawing` 画圆角矩形 + 线性渐变 + 圆点，TS 侧没有等价物。
 *
 * ## 为什么值得手写而不是留 PS1
 *
 * 1. 图形是纯数学：圆角矩形有标准距离场，渐变是投影插值，圆是距离判断。
 *    没有任何「只有 GDI+ 才能做」的东西。
 * 2. **抗锯齿变简单了**：`Graphics.SmoothingMode = AntiAlias` 是个黑箱；
 *    这里用 4×4 超采样，覆盖率直接可算，结果与采样数线性可控。
 * 3. **变成可测的纯函数**：`renderIcon(size)` 返回像素数组，测试能断言
 *    「256px 的图标中心像素是品牌绿」「16px 不画三个点」这类事实。
 *    PS1 版只能靠人眼看 PNG。
 *
 * ## 与原版的两处刻意差异
 *
 * - 原版 16px 也画外框描边（`$s * 0.055` = 0.88px），会糊成一片灰。
 *   这里 16px 只画底板，24px 起才画描边与三个点——小尺寸下**少画就是清晰**。
 * - 原版对 7 个尺寸各画一次，`New-IconPng` 每次重建 `Graphics`；
 *   这里 `renderIcon` 是纯函数，尺寸数组直接遍历，没有资源可泄漏。
 *
 * 用法：
 *
 *     bun run scripts/make-icon.ts
 *     bun run scripts/make-icon.ts --out assets/app.ico
 *     bun run scripts/make-icon.ts --sizes 16,32,48,256
 *     bun run scripts/make-icon.ts --help
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { encodePng, type PngImage } from "../native/png";
import { isEntrypoint } from "./lib/entrypoint";

// ---- 品牌色（与原 PS1 版逐值对齐） -----------------------------------------

const BG_TOP = { r: 32, g: 36, b: 48 };
const BG_BOTTOM = { r: 16, g: 18, b: 24 };
const ACCENT = { r: 126, g: 226, b: 168 };
const DOT = { r: 200, g: 210, b: 220 };

/** 默认尺寸集。256 是 Vista+ PNG 载荷的上限，也是资源管理器大图标用的那档 */
export const DEFAULT_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

// ---- 几何：圆角矩形距离场 ---------------------------------------------------

/**
 * 圆角矩形的有符号距离（负值在内部）。
 *
 * 这是 Inigo Quilez 的经典 SDF 形式：把矩形缩掉圆角半径，剩下的当普通矩形
 * 处理，最后减去半径。好处是**描边可以直接用 `|d| < halfStroke` 判定**，
 * 不需要再用「外框减内框」拼两个形状。
 */
export function sdRoundRect(
    px: number,
    py: number,
    cx: number,
    cy: number,
    hw: number,
    hh: number,
    radius: number,
): number {
    const qx = Math.abs(px - cx) - (hw - radius);
    const qy = Math.abs(py - cy) - (hh - radius);
    const ax = Math.max(qx, 0);
    const ay = Math.max(qy, 0);
    const outside = Math.hypot(ax, ay);
    const inside = Math.min(Math.max(qx, qy), 0);
    return outside + inside - radius;
}

/** 线性渐变的值：沿 (dx, dy) 方向把包围盒投影到 [0,1] */
export function gradientT(
    px: number,
    py: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    angleDeg: number,
): number {
    const rad = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    // 投影长度按包围盒对角线归一，保证 t ∈ [0,1]
    const half = (Math.abs((right - left) * dx) + Math.abs((bottom - top) * dy)) / 2;
    if (half === 0) return 0;
    const t = ((px - cx) * dx + (py - cy) * dy) / (half * 2) + 0.5;
    return Math.min(1, Math.max(0, t));
}

function mix(
    a: { r: number; g: number; b: number },
    b: { r: number; g: number; b: number },
    t: number,
): { r: number; g: number; b: number } {
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

// ---- 光栅化 -----------------------------------------------------------------

/** 每种尺寸的细节开关：小尺寸少画，避免糊成一团 */
export type Detail = { stroke: boolean; dots: boolean };

export function detailFor(size: number): Detail {
    return {
        // 16px 时描边宽度不到 1px，画出来是一片灰，不如不画
        stroke: size >= 24,
        // 三个点在 24px 以下会互相粘连
        dots: size >= 24,
    };
}

/**
 * 渲染一个尺寸的图标为 RGBA 像素（非预乘）。
 *
 * 4×4 超采样：每个像素取 16 个点判断覆盖率。这是最简单的抗锯齿，
 * 对圆角矩形/圆这类形状效果足够——它们只有边缘一像素需要混合。
 */
export function renderIcon(size: number, samples = 4): PngImage {
    if (size <= 0) throw new Error(`icon size must be positive, got ${size}`);
    const detail = detailFor(size);
    const pixels = new Uint8Array(size * size * 4);
    const s = size;

    // 几何参数全部按尺寸比例给出，与原 PS1 版逐项对应
    const pad = s * 0.06;
    const bgRect = { left: pad, top: pad, right: s - pad, bottom: s - pad };
    const bgCx = s / 2;
    const bgCy = s / 2;
    const bgHw = (bgRect.right - bgRect.left) / 2;
    const bgHh = (bgRect.bottom - bgRect.top) / 2;
    const bgRadius = s * 0.22;

    const inset = s * 0.2;
    const fRect = {
        left: inset,
        top: inset * 1.05,
        right: s - inset,
        bottom: s - inset * 1.05,
    };
    const fCx = (fRect.left + fRect.right) / 2;
    const fCy = (fRect.top + fRect.bottom) / 2;
    const fHw = (fRect.right - fRect.left) / 2;
    const fHh = (fRect.bottom - fRect.top) / 2;
    const fRadius = s * 0.07;
    const strokeWidth = s * 0.055;

    const barY = fRect.top + (fRect.bottom - fRect.top) * 0.26;
    const barHalf = strokeWidth / 2;

    const dotRadius = s * 0.028;
    const dotCy = fRect.top + (fRect.bottom - fRect.top) * 0.13;
    const dotCx0 = fRect.right - (fRect.right - fRect.left) * 0.1;
    const dotStep = dotRadius * 3;

    const inv = 1 / samples;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let bgCov = 0;
            let strokeCov = 0;
            let barCov = 0;
            let dotCov = 0;
            let bgR = 0;
            let bgG = 0;
            let bgB = 0;

            for (let sy = 0; sy < samples; sy++) {
                for (let sx = 0; sx < samples; sx++) {
                    const px = x + (sx + 0.5) * inv;
                    const py = y + (sy + 0.5) * inv;

                    // 1) 底板
                    const dBack = sdRoundRect(px, py, bgCx, bgCy, bgHw, bgHh, bgRadius);
                    if (dBack <= 0) {
                        bgCov += inv * inv;
                        const t = gradientT(
                            px,
                            py,
                            bgRect.left,
                            bgRect.top,
                            bgRect.right,
                            bgRect.bottom,
                            45,
                        );
                        const c = mix(BG_TOP, BG_BOTTOM, t);
                        bgR += c.r * inv * inv;
                        bgG += c.g * inv * inv;
                        bgB += c.b * inv * inv;
                    }

                    if (!detail.stroke) continue;

                    // 2) 窗口框描边
                    const dFrame = sdRoundRect(px, py, fCx, fCy, fHw, fHh, fRadius);
                    if (Math.abs(dFrame) <= strokeWidth / 2) strokeCov += inv * inv;

                    // 3) 标题栏分隔线（水平线段，限制在框内）
                    if (
                        Math.abs(py - barY) <= barHalf &&
                        px >= fRect.left &&
                        px <= fRect.right
                    ) {
                        barCov += inv * inv;
                    }

                    // 4) 三个窗口按钮点
                    if (detail.dots) {
                        for (let i = 0; i < 3; i++) {
                            const cx = dotCx0 - i * dotStep;
                            if (Math.hypot(px - cx, py - dotCy) <= dotRadius) {
                                dotCov += inv * inv;
                                break; // 一个采样点只算一次
                            }
                        }
                    }
                }
            }

            // 合成：底板 → 描边 → 分隔线 → 圆点（全部同一强调色，alpha 叠加）
            const at = (y * size + x) * 4;
            const accentCov = Math.min(1, strokeCov + barCov);
            const totalAccent = Math.min(1, accentCov + dotCov);

            // 底板颜色（按 bgCov 归一化，避免除以 0）
            const br = bgCov > 0 ? bgR / bgCov : 0;
            const bg = bgCov > 0 ? bgG / bgCov : 0;
            const bb = bgCov > 0 ? bgB / bgCov : 0;

            // 强调色覆盖在底板上；圆点颜色略有不同
            const dotWeight = totalAccent > 0 ? dotCov / totalAccent : 0;
            const accentR = ACCENT.r * (1 - dotWeight) + DOT.r * dotWeight;
            const accentG = ACCENT.g * (1 - dotWeight) + DOT.g * dotWeight;
            const accentB = ACCENT.b * (1 - dotWeight) + DOT.b * dotWeight;

            const outA = Math.min(1, bgCov + totalAccent);
            if (outA <= 0) {
                pixels[at] = 0;
                pixels[at + 1] = 0;
                pixels[at + 2] = 0;
                pixels[at + 3] = 0;
            } else {
                // 非预乘 alpha：颜色按各自覆盖率加权
                const rr = (br * bgCov + accentR * totalAccent) / outA;
                const gg = (bg * bgCov + accentG * totalAccent) / outA;
                const bbb = (bb * bgCov + accentB * totalAccent) / outA;
                pixels[at] = Math.round(rr);
                pixels[at + 1] = Math.round(gg);
                pixels[at + 2] = Math.round(bbb);
                pixels[at + 3] = Math.round(outA * 255);
            }
        }
    }

    return { width: size, height: size, channels: 4, pixels };
}

// ---- ICO 容器 ---------------------------------------------------------------

/**
 * 把若干 PNG 打成 ICO。
 *
 * Vista 起 ICO 允许 PNG 载荷（`ICONDIRENTRY` 指向一段完整 PNG 文件），
 * 这比未压缩的 DIB 小一个数量级，也是原 PS1 版的做法。
 *
 * `width`/`height` 字段是单字节，**0 表示 256** —— 这是最容易写错的一处。
 */
export function buildIco(pngs: readonly { size: number; png: Uint8Array }[]): Uint8Array {
    if (pngs.length === 0) throw new Error("cannot build an ICO with zero images");
    if (pngs.length > 255) throw new Error("ICO supports at most 255 images");

    const headerSize = 6 + 16 * pngs.length;
    const total = headerSize + pngs.reduce((n, p) => n + p.png.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);

    view.setUint16(0, 0, true); // reserved
    view.setUint16(2, 1, true); // type = icon
    view.setUint16(4, pngs.length, true);

    let offset = headerSize;
    pngs.forEach((p, i) => {
        const at = 6 + i * 16;
        // 0 表示 256：单字节存不下 256，规范用 0 代表它
        out[at] = p.size >= 256 ? 0 : p.size;
        out[at + 1] = p.size >= 256 ? 0 : p.size;
        out[at + 2] = 0; // color count（真彩色不用调色板）
        out[at + 3] = 0; // reserved
        view.setUint16(at + 4, 1, true); // planes
        view.setUint16(at + 6, 32, true); // bit count
        view.setUint32(at + 8, p.png.length, true);
        view.setUint32(at + 12, offset, true);
        out.set(p.png, offset);
        offset += p.png.length;
    });

    return out;
}

/** 读 ICO 头部，返回每项的尺寸与载荷偏移（用于回读校验，不解析 PNG） */
export function readIcoIndex(ico: Uint8Array): { count: number; entries: { size: number; bytes: number; offset: number }[] } {
    if (ico.length < 6) throw new Error("ICO too short");
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
        throw new Error("not an ICO file (bad reserved/type)");
    }
    const count = view.getUint16(4, true);
    const entries: { size: number; bytes: number; offset: number }[] = [];
    for (let i = 0; i < count; i++) {
        const at = 6 + i * 16;
        const w = ico[at] ?? 0;
        entries.push({
            size: w === 0 ? 256 : w,
            bytes: view.getUint32(at + 8, true),
            offset: view.getUint32(at + 12, true),
        });
    }
    return { count, entries };
}

// ---- CLI --------------------------------------------------------------------

export type IconPlan = { out: string; sizes: number[]; help: boolean };

export function parseIconArgs(argv: readonly string[], root: string): IconPlan {
    const plan: IconPlan = {
        out: resolve(root, "assets", "app.ico"),
        sizes: [...DEFAULT_SIZES],
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
        } else if (arg === "out") {
            plan.out = resolve(needValue());
        } else if (arg === "sizes") {
            const parts = needValue()
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isFinite(n));
            if (parts.length === 0) throw new Error("--sizes 需要至少一个数字");
            const bad = parts.filter((n) => !Number.isInteger(n) || n < 1 || n > 256);
            if (bad.length > 0) throw new Error(`尺寸必须是 1–256 的整数，收到: ${bad.join(", ")}`);
            plan.sizes = [...new Set(parts)].sort((a, b) => a - b);
        } else if (arg.length > 0) {
            throw new Error(`unknown argument: ${raw}`);
        }
    }
    return plan;
}

function printHelp(): void {
    console.log(`bun run scripts/make-icon.ts [options]

  --out <path>     输出 ICO 路径（默认 assets/app.ico）
  --sizes <a,b,c>  尺寸列表（默认 ${DEFAULT_SIZES.join(",")}）
  --help           显示本帮助

生成的是 PNG 载荷 ICO（Vista+），供 bun run build:exe 的 --windows-icon 使用。`);
}

export function main(argv: readonly string[], root: string): number {
    let plan: IconPlan;
    try {
        plan = parseIconArgs(argv, root);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const built: { size: number; png: Uint8Array }[] = [];
    for (const size of plan.sizes) {
        const img = renderIcon(size);
        const png = encodePng(img, "rgba");
        if (png.length < 60) {
            console.error(`png for ${size}px is suspiciously small: ${png.length} bytes`);
            return 1;
        }
        built.push({ size, png });
        console.log(`  ${String(size).padStart(3)}px -> ${png.length.toLocaleString("en-US").padStart(7)} bytes`);
    }

    const ico = buildIco(built);
    mkdirSync(dirname(plan.out), { recursive: true });
    Bun.write(plan.out, ico);

    const reread = readIcoIndex(ico);
    console.log("");
    console.log(`icon: ${plan.out} (${ico.length.toLocaleString("en-US")} bytes, ${reread.count} sizes)`);
    console.log(`readback: ${reread.entries.map((e) => e.size).join(", ")}`);
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = main(process.argv.slice(2), resolve(import.meta.dir, ".."));
}
