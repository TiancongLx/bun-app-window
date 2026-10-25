#!/usr/bin/env bun
/**
 * test-av.ts — 对产物做 Defender 自定义扫描，并核对威胁历史
 *
 * 替代 `scripts/test-av.ps1`。原版三处 .NET 便利设施全部有等价物：
 *
 * | 原 PS 版 | 现在 |
 * | --- | --- |
 * | `Get-AuthenticodeSignature` | `native/pe.ts` 读 Certificate Table |
 * | `Get-MpThreatDetection` | `wevtutil` 读 Defender 事件日志 1116/1117 |
 * | `Get-MpPreference` | `Get-MpComputerStatus` 之类无法替代 → 改为直接读注册表/跳过，见下 |
 *
 * 顺带把 `pitfalls` 1.7 那条坑封进代码：`MpCmdRun.exe` 不认含 `..` 的路径，
 * 会**静默跳过**扫描。所以这里一律先 `realpath` 再传。
 *
 * 用法：
 *
 *     bun run scripts/test-av.ts
 *     bun run scripts/test-av.ts --root <dir>
 *     bun run scripts/test-av.ts --help
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasAuthenticodeSignature } from "../native/pe";
import { isEntrypoint } from "./lib/entrypoint";

/** Defender 平台目录；版本号会变，所以取 current 再找实际子目录 */
const MP_ROOT = "C:\\ProgramData\\Microsoft\\Windows Defender\\Platform";

export type Target = {
    path: string;
    exists: boolean;
    size: number;
    signed: boolean;
};

/** 取 MpCmdRun.exe 的绝对路径；找不到返回 null（不猜、不改 PATH） */
export function findMpCmdRun(platformRoot = MP_ROOT): string | null {
    let entries: string[];
    try {
        entries = [...new Bun.Glob("*/MpCmdRun.exe").scanSync({ cwd: platformRoot })];
    } catch {
        return null;
    }
    if (entries.length === 0) return null;
    // 目录名是平台版本号，取字典序最大的那个（形如 4.18.24010.7-0）
    entries.sort();
    const last = entries[entries.length - 1];
    return last ? join(platformRoot, last) : null;
}

/**
 * 描述一个扫描目标。
 *
 * `path` 必须是**已解析的绝对路径**：`MpCmdRun -File` 遇到 `..` 会跳过该样本且
 * 返回 0，看起来像「扫描通过」。`pitfalls` 1.7 的原文就是这么写的。
 */
export function describeTarget(path: string): Target {
    const full = resolve(path);
    try {
        const st = statSync(full);
        if (!st.isFile()) return { path: full, exists: false, size: 0, signed: false };
        let signed = false;
        try {
            signed = hasAuthenticodeSignature(new Uint8Array(readFileSync(full)));
        } catch {
            signed = false;
        }
        return { path: full, exists: true, size: st.size, signed };
    } catch {
        return { path: full, exists: false, size: 0, signed: false };
    }
}

/** 从 `wevtutil` 的 text 输出里数 `Event[N]` 的个数 */
export function countEvents(text: string): number {
    return [...text.matchAll(/^Event\[\d+\]$/gm)].length;
}

export type RunResult = { code: number; out: string; err: string };

async function spawn(argv: readonly string[], cwd: string): Promise<RunResult> {
    // 可执行文件不存在时 `Bun.spawn` 直接抛 ENOENT，不会给出退出码。
    // 诊断脚本必须把「工具缺失」当成一种可报告的状态，而不是让调用方崩掉。
    try {
        const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        const code = await proc.exited;
        return { code, out, err };
    } catch (err) {
        return {
            code: -1,
            out: "",
            err: err instanceof Error ? err.message : String(err),
        };
    }
}

/** 查 Defender 的检测事件（1116 = 检测到，1117 = 已处置） */
export async function queryThreatEvents(wevtutil: string): Promise<{ count: number; text: string }> {
    const res = await spawn(
        [
            wevtutil,
            "qe",
            "Microsoft-Windows-Windows Defender/Operational",
            "/q:*[System[(EventID=1116 or EventID=1117)]]",
            "/c:10",
            "/rd:true",
            "/f:text",
        ],
        process.cwd(),
    );
    // 没有事件时 wevtutil 返回非 0；这不是错误，是「干净」
    return { count: res.code === 0 ? countEvents(res.out) : 0, text: res.out };
}

function printHelp(): void {
    console.log(`bun run scripts/test-av.ts [options]

  --root <dir>   仓库根目录（默认：本文件的上一级）
  --help         显示本帮助

扫描目标（存在才扫）：dist/bun-app-window.exe、dist/bun-app-window.signed.exe、.build/libshell.dll`);
}

export type AvDeps = {
    spawn(argv: readonly string[], cwd: string): Promise<RunResult>;
};

const REAL_DEPS: AvDeps = { spawn };

export async function main(argv: readonly string[], root: string, deps: AvDeps = REAL_DEPS): Promise<number> {
    let rootDir = root;
    for (let i = 0; i < argv.length; i++) {
        const arg = (argv[i] ?? "").replace(/^-{1,2}/, "").toLowerCase();
        if (arg === "help" || arg === "h") {
            printHelp();
            return 0;
        }
        if (arg === "root") {
            const v = argv[i + 1];
            if (!v) {
                console.error("--root 需要一个目录参数");
                return 2;
            }
            rootDir = resolve(v);
            i++;
            continue;
        }
        if (arg.length > 0) {
            console.error(`unknown argument: ${argv[i]}`);
            console.error("run with --help for usage");
            return 2;
        }
    }

    const mp = findMpCmdRun();
    if (!mp) {
        console.error(`MpCmdRun.exe not found under ${MP_ROOT}`);
        console.error("（非 Defender 环境或平台目录不存在，这是环境问题，不是产物问题）");
        return 2;
    }

    const candidates = [
        join(rootDir, "dist", "bun-app-window.exe"),
        join(rootDir, "dist", "bun-app-window.signed.exe"),
        join(rootDir, ".build", "libshell.dll"),
    ];
    const targets = candidates.map(describeTarget).filter((t) => t.exists);

    console.log("=== targets ===");
    if (targets.length === 0) {
        console.log("  (none — 先跑 bun run build:exe 或 bun run build:native)");
        return 1;
    }
    for (const t of targets) {
        console.log(
            `  ${t.path.padEnd(52)} ${t.size.toLocaleString("en-US").padStart(13)} bytes  sig=${t.signed ? "present" : "none"}`,
        );
    }
    console.log("");

    const wevtutil = Bun.which("wevtutil");
    if (wevtutil) {
        const before = await queryThreatEvents(wevtutil);
        console.log(`threat detections before: ${before.count}`);
        console.log("");
    }

    let scanFailures = 0;
    for (const t of targets) {
        console.log(`=== scan: ${t.path} ===`);
        const started = performance.now();
        // -DisableRemediation：只检测不处置，避免扫描过程改动样本
        const res = await deps.spawn([mp, "-Scan", "-ScanType", "3", "-File", t.path, "-DisableRemediation"], rootDir);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        for (const line of `${res.out}${res.err}`.split(/\r?\n/)) {
            if (line.trim()) console.log(`  ${line.trim()}`);
        }
        console.log(`  exit=${res.code} elapsed=${seconds}s`);
        if (res.code !== 0) scanFailures++;
        console.log("");
    }

    if (wevtutil) {
        const after = await queryThreatEvents(wevtutil);
        console.log("=== threat detections after ===");
        console.log(`count: ${after.count}`);
        if (after.count > 0) {
            for (const line of after.text.split(/\r?\n/).slice(0, 40)) {
                if (line.trim()) console.log(`  ${line.trim()}`);
            }
        }
        console.log("");
    }

    // 判定只看「扫描本身是否成功」，不看威胁数量——后者由人读日志
    if (scanFailures > 0) {
        console.error(`FAILED: ${scanFailures} of ${targets.length} scans returned non-zero`);
        return 1;
    }
    console.log(`OK: ${targets.length} target(s) scanned without error`);
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dir, ".."));
}
