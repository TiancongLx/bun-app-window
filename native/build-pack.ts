#!/usr/bin/env bun
/**
 * build-pack.ts — 把自检程序打包成单文件 exe
 *
 * 替代 `native/build-pack.ps1`（ADR 0014 批次 1）。这一个是 12 个 `.ps1` 里
 * 唯一有硬依赖的：`package.json` 的 `build:exe`、`tests/version.test.ts`、
 * `scripts/bump-version.ts` 三者都直接引用它的源码文本。
 *
 * ## 与 PS1 版的三处差异
 *
 * 1. **打包后的三项校验不再依赖外部工具。** 原版靠 `llvm-objdump -p`、
 *    `rg -a -o`、`Get-AuthenticodeSignature` 分别读 Subsystem、内嵌资源名、
 *    签名状态。现在全部改成读 `native/pe.ts` 的纯字节解析——少三个工具依赖，
 *    而且判定能写成 `bun test` 断言。
 *
 * 2. **参数表是纯函数。** `packArgs()` 单独导出，`tests/build-pack.test.ts`
 *    能直接断言「传了什么给 bun build」，不必真的跑一次 90 MB 的编译。
 *
 * 3. **不改变版本号的落点。** `--windows-version` 仍然是源码里的一行字面量
 *    （形如 `"--windows-version", "<x.y.z.0>"`），只把引号从单改双（TS 惯例）。
 *    **注释里不写真实版本号** —— 写过一次，结果是 `version.test.ts` 的
 *    非锚定正则先命中注释、再命中断代码，读到的是注释里的旧值，
 *    而 `bump-version.ts` 的锚定正则改的却是真代码。两处都对，合起来错。
 *    `bump-version.ts` 与 `version.test.ts` 的定位正则同步放宽为接受两种引号。
 *
 * ## 为什么不用 process.exit()
 *
 * `main()` 返回退出码，由入口守卫赋给 `process.exitCode`。理由与 `gate.ts` 相同：
 * 直接 `process.exit()` 会跳过 finally，临时文件与句柄就漏了。
 *
 * 用法：
 *
 *     bun run build:exe               # 隐藏控制台（GUI 子系统）
 *     bun run build:exe --keep-console
 *     bun run native/build-pack.ts --help
 */

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isEntrypoint } from "../scripts/lib/entrypoint";
import {
    findEmbeddedAssets,
    hasAuthenticodeSignature,
    readCertificateDir,
    readSubsystem,
    subsystemLabel,
} from "./pe";

// ---- 常量 -------------------------------------------------------------------

/**
 * 仓库根目录。
 *
 * 本文件在 `native/` 下，所以是「上一级」。**导出它是为了让测试能断言**：
 * 初版写成 `resolve(dirname(import.meta.dir), "..")`，多退了一层，
 * 打包时把入口解析成 `_Repositories/src/host.ts` 而不是仓库内的 `src/host.ts`——
 * 而当时门禁是全绿的，因为 `main()` 的测试都把 root 当参数传，没人测这条路径。
 * 2026-10-20 首次真跑 `bun run build:exe` 才发现。
 */
export const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * 打包参数里与产物身份相关的部分。
 *
 * `--windows-version` 的值在 `packArgs()` 里写成**字面量**，不抽成常量：
 *
 *   - `scripts/bump-version.ts` 要用正则原位改写那一行（单一事实源在源码里）
 *   - `tests/version.test.ts` 要在不执行任何代码的前提下比对两处版本
 *
 * 抽成常量会让这两件事都失效——「版本号只有一处需要改」这个属性比「避免字面量重复」
 * 重要得多。重复的那一份由测试守住，不是靠人记得。
 */
export const WINDOWS_METADATA = {
    title: "WebView Shell",
    description: "Native shell for Bun + WebView2",
    publisher: "bun-app-window",
} as const;

/** Bun 给内嵌资源加的 hash 前缀，用于在产物里回查 */
export const ASSET_PREFIXES = ["libshell-", "index-"] as const;

// ---- 参数表（纯函数） -------------------------------------------------------

export type PackOptions = {
    /** 仓库根目录 */
    root: string;
    /** 是否保留控制台窗口 */
    keepConsole: boolean;
    /** 图标路径；undefined 表示不传 `--windows-icon` */
    iconPath: string | undefined;
    /** 输出文件路径 */
    outfile: string;
};

export type PackPlan = {
    argv: string[];
    outfile: string;
    /** 图标缺失时给调用方的提示；有图标时为 null */
    warning: string | null;
};

/**
 * 组装 `bun build` 的参数表。
 *
 * 顺序有意固定：`build` → 编译开关 → windows 元数据 → 可选图标 → 控制台开关
 * → 入口 → `--outfile` → 目标。`--outfile` 必须在位置参数之后，否则 bun 会把
 * 输出路径当成第二个入口。
 */
export function packArgs(opts: PackOptions): PackPlan {
    const argv: string[] = [
        "build",
        "--compile",
        "--minify",
        "--windows-title",
        WINDOWS_METADATA.title,
        "--windows-description",
        WINDOWS_METADATA.description,
        "--windows-publisher",
        WINDOWS_METADATA.publisher,
        // 下面这一行的版本号必须保持「字面量 + 与 --windows-version 同行」的形状：
        // bump-version.ts 原地改写它，version.test.ts 静态读取它。
        "--windows-version", "0.5.1.0",
    ];

    let warning: string | null = null;
    if (opts.iconPath) {
        argv.push("--windows-icon", opts.iconPath);
    } else {
        warning = "icon not found (run scripts/make-icon.ps1 first)";
    }

    if (!opts.keepConsole) {
        argv.push("--windows-hide-console");
    }

    argv.push(join(opts.root, "src", "host.ts"), "--outfile", opts.outfile);

    return { argv, outfile: opts.outfile, warning };
}

// ---- 报告 -------------------------------------------------------------------

export type PackReport = {
    size: number;
    subsystem: number | null;
    signed: boolean;
    certBytes: number;
    assets: string[];
};

/** 从产物字节里读出报告字段。纯函数，测试可直接喂一段构造好的 PE */
export function inspectArtifact(bytes: Uint8Array): PackReport {
    const cert = readCertificateDir(bytes);
    return {
        size: bytes.length,
        subsystem: readSubsystem(bytes),
        signed: hasAuthenticodeSignature(bytes),
        certBytes: cert?.size ?? 0,
        assets: findEmbeddedAssets(bytes, ASSET_PREFIXES),
    };
}

/** 人类可读的 MiB，保留一位小数 */
export function formatMiB(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---- 编排 -------------------------------------------------------------------

type SpawnResult = { code: number; out: string; err: string };

async function spawn(argv: readonly string[], cwd: string): Promise<SpawnResult> {
    const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out, err };
}

export type PackDeps = {
    /** 替代真实 bun build，测试注入用 */
    build(argv: readonly string[], cwd: string): Promise<SpawnResult>;
    now(): number;
};

const REAL_DEPS: PackDeps = {
    build: (argv, cwd) => spawn([process.execPath, ...argv], cwd),
    now: () => Date.now(),
};

/**
 * 跑一次打包。
 *
 * 返回退出码：0 成功，1 打包失败，2 参数或环境问题。
 */
export async function main(
    argv: readonly string[],
    root: string,
    deps: PackDeps = REAL_DEPS,
): Promise<number> {
    let keepConsole = false;
    for (const raw of argv) {
        const arg = raw.replace(/^-{1,2}/, "").toLowerCase().replace(/_/g, "-");
        if (arg === "keep-console" || arg === "keepconsole") {
            keepConsole = true;
        } else if (arg === "help" || arg === "h") {
            printHelp();
            return 0;
        } else if (arg.length > 0) {
            // 不接受未知参数：静默忽略意味着打错一个字母就在你没预期的地方打包
            console.error(`unknown argument: ${raw}`);
            console.error("run with --help for usage");
            return 2;
        }
    }

    const distDir = join(root, "dist");
    const outfile = join(distDir, "bun-app-window.exe");
    const iconFull = join(root, "assets", "app.ico");

    let iconPath: string | undefined;
    try {
        if (statSync(iconFull).isFile()) iconPath = iconFull;
    } catch {
        iconPath = undefined;
    }

    const plan = packArgs({ root, keepConsole, iconPath, outfile });
    if (plan.warning) {
        console.warn(`warning: ${plan.warning}`);
    }

    mkdirSync(distDir, { recursive: true });

    console.log(`bun ${plan.argv.join(" ")}`);
    const started = deps.now();
    const res = await deps.build(plan.argv, root);
    const elapsed = ((deps.now() - started) / 1000).toFixed(1);

    if (res.out.trim()) console.log(res.out.trimEnd());
    if (res.err.trim()) console.error(res.err.trimEnd());

    if (res.code !== 0) {
        console.error(`bun build failed: rc=${res.code}`);
        return 1;
    }

    // 产物可能因平台差异没落在预期位置——读不到就是失败，不粉饰
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(readFileSync(plan.outfile));
    } catch (err) {
        console.error(
            `build reported success but artifact is unreadable: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        return 1;
    }

    const report = inspectArtifact(bytes);

    console.log("");
    console.log(`built : ${plan.outfile}`);
    console.log(`size  : ${report.size.toLocaleString("en-US")} bytes (${formatMiB(report.size)})`);
    console.log(`time  : ${elapsed}s`);
    console.log("");
    console.log("=== PE subsystem ===");
    console.log(
        `Subsystem: ${subsystemLabel(report.subsystem)}` +
            (report.subsystem === null ? "  ← 不是合法 PE 或字段越界" : ""),
    );
    if (!keepConsole && report.subsystem !== 2) {
        console.warn("warning: --windows-hide-console 没有生效（期望 Subsystem 2）");
    }
    console.log("");
    console.log("=== embedded assets ===");
    if (report.assets.length === 0) {
        console.log("  (none — 内嵌资源表为空，或命名规则变了；见 native/pe.ts 的 ASSET_PREFIXES)");
    } else {
        for (const name of report.assets) console.log(`  ${name}`);
    }
    if (!report.assets.some((n) => n.startsWith("libshell-"))) {
        // 当前入口 src/host.ts 只用 type:"text" 内嵌 HTML，DLL 靠 resolve.ts 从磁盘解析。
        // 没有 libshell-* 是正常形态，别误读成「内嵌失败」。
        console.log(
            "  (no libshell-* : 入口未静态 import 内嵌 DLL，DLL 走 resolve.ts 的磁盘解析)",
        );
    }
    console.log("");
    console.log("=== signature ===");
    console.log(
        report.signed
            ? `certificate table present (${report.certBytes.toLocaleString("en-US")} bytes)`
            : "not signed (certificate table empty)",
    );

    return 0;
}

function printHelp(): void {
    console.log(`bun run build:exe [options]

  无参数            打包 dist/bun-app-window.exe，隐藏控制台（GUI 子系统）
  --keep-console    保留控制台窗口（Subsystem 3，便于看 console.log）
  --help            显示本帮助`);
}

// ---- 入口 -------------------------------------------------------------------

// 判据不能只用 import.meta.main —— 见 scripts/lib/entrypoint.ts 的实测记录。
if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2), REPO_ROOT);
}
