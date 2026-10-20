#!/usr/bin/env bun
/**
 * extract-icon.ts — 从 exe 的 PE 资源里提取图标，证明 `--windows-icon` 生效
 *
 * 替代 `scripts/extract-icon.ps1`。原版靠 `ExtractIconExW` + `Icon.ToBitmap()`
 * + `Bitmap.Save(Png)`；这里前半段一样，后半段换成 `native/gdi.ts` 的
 * `DrawIconEx` + `native/png.ts` 自编码。
 *
 * 与 PS1 版的差异：**尺寸由系统决定，不猜**。原版直接 `$ico.Width` 拿尺寸，
 * 但多尺寸 ICO 里 `ExtractIconExW` 返回的是「系统选定的大图标」——
 * 32px 还是 256px 取决于 DPI 与 shell 设置。这里如实报告实际拿到的尺寸，
 * 因为「提取到了哪个尺寸」本身就是验证 `--windows-icon` 是否生效的证据。
 *
 * 用法：
 *
 *     bun run scripts/extract-icon.ts --exe dist/bun-app-window.exe --out dist/icon.png
 *     bun run scripts/extract-icon.ts --exe dist/bun-app-window.exe    # 只报告
 *     bun run scripts/extract-icon.ts --help
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { closeGdi, extractIcon } from "../native/gdi";
import { bgraToPng, encodePng } from "../native/png";
import { closeAll, utf16z } from "../native/win32";
import { isEntrypoint } from "./lib/entrypoint";

export type ExtractPlan = {
    exe: string;
    out: string;
    index: number;
    help: boolean;
};

export function parseExtractArgs(argv: readonly string[], root: string): ExtractPlan {
    const plan: ExtractPlan = {
        exe: resolve(root, "dist", "bun-app-window.exe"),
        out: "",
        index: 0,
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
        } else if (arg === "exe") {
            plan.exe = resolve(needValue());
        } else if (arg === "out") {
            plan.out = resolve(needValue());
        } else if (arg === "index") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n < 0) throw new Error("--index 需要非负整数");
            plan.index = n;
        } else if (arg.length > 0) {
            throw new Error(`unknown argument: ${raw}`);
        }
    }
    return plan;
}

export type ExtractOutcome =
    | { ok: true; width: number; height: number; iconCount: number; path: string; bytes: number }
    | { ok: false; error: string };

/** 提取并（可选）写 PNG */
export function runExtract(plan: ExtractPlan): ExtractOutcome {
    const icon = extractIcon(utf16z(plan.exe), plan.index);
    if (!icon) {
        return {
            ok: false,
            error:
                "ExtractIconExW 返回 0 或图标句柄为空 —— " +
                "该 exe 没有图标资源（打包时 --windows-icon 未生效，或路径不是 PE 文件）",
        };
    }

    if (!plan.out) {
        return {
            ok: true,
            width: icon.width,
            height: icon.height,
            iconCount: icon.count,
            path: "",
            bytes: 0,
        };
    }

    const png = encodePng(
        bgraToPng(icon.bgra, icon.width, icon.height, "rgba", {
            // 部分 ICO 的 32bpp 位图 alpha 全 0（掩码在 hbmMask 里），
            // DrawIconEx 已经合成过，这里再兜一次
            treatZeroAlphaAsOpaque: true,
        }),
        "rgba",
    );
    const outPath = resolve(plan.out);
    mkdirSync(dirname(outPath), { recursive: true });
    Bun.write(outPath, png);

    return {
        ok: true,
        width: icon.width,
        height: icon.height,
        iconCount: icon.count,
        path: outPath,
        bytes: png.length,
    };
}

function printHelp(): void {
    console.log(`bun run scripts/extract-icon.ts [options]

  --exe <path>    目标 PE 文件（默认 dist/bun-app-window.exe）
  --out <path>    输出 PNG；省略则只报告尺寸
  --index <n>     图标序号（默认 0）
  --help          显示本帮助

退出码：0 成功，2 参数或资源问题。`);
}

export function main(argv: readonly string[], root: string): number {
    let plan: ExtractPlan;
    try {
        plan = parseExtractArgs(argv, root);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const result = runExtract(plan);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    try {
        process.exitCode = main(process.argv.slice(2), resolve(import.meta.dir, ".."));
    } finally {
        closeGdi();
        closeAll();
    }
}
