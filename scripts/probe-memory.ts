#!/usr/bin/env bun
/**
 * probe-memory.ts — 查 libshell 到底以什么形式存在于目标进程内存里
 *
 * 替代 `scripts/probe-memory.ps1`。这个问题来自 `pitfalls` 4.2：`type: "file"`
 * + dlopen 会把 DLL 提取到临时目录，之后是否还以「模块」形式存在，
 * 决定了要不要走 `Bun.embeddedFiles` 那条路（4.3）。
 *
 * 三件事：
 *
 * 1. 枚举目标进程的全部已加载模块（不打过滤，先看全貌）
 * 2. 用 `VirtualQueryEx` 遍历地址空间，在提交区里搜导出名 `shell_debug_dpi`
 * 3. 与磁盘上的 `libshell.dll` 做特征比对
 *
 * ## 与 PS1 版的差异
 *
 * - **不再用 `schtasks /IT` 跨会话拉起进程。** 那条路是为了把 GUI 进程送进
 *   Session 1，而 OTT 自 2026-10-18 起已直接运行在 Session 1（`AGENTS.md` §5
 *   第 4 条），所以直接 spawn 就够了。少一层计划任务，也少一处要在 finally 里
 *   清理的残留（`AGENTS.md` §8 要求不得遗留计划任务）。
 *
 * 用法：
 *
 *     bun run scripts/probe-memory.ts
 *     bun run scripts/probe-memory.ts --exe dist/bun-app-window.exe --hold 25
 *     bun run scripts/probe-memory.ts --attach 12345      # 不启动，只查已有进程
 *     bun run scripts/probe-memory.ts --help
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { locatePe, readSubsystem } from "../native/pe";
import {
    PROCESS_QUERY_INFORMATION,
    PROCESS_VM_READ,
    closeAll,
    closeHandle,
    findPidsByName,
    indexOfBytes,
    isCommittedRegion,
    listModules,
    listPids,
    openProcess,
    processCreationTime,
    readProcessMemory,
    virtualQueryEx,
} from "../native/win32";
import { isEntrypoint } from "./lib/entrypoint";

/** 用来在内存里定位 DLL 的导出名。改 FFI 声明时若删掉这个符号，扫描会失效 */
export const FINGERPRINT = "shell_debug_dpi";

/** 扫描上限：512 MiB。够覆盖一个 Bun 进程的提交区，又不至于跑几分钟 */
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
/** 单次读取上限：超过这个大小的区域分块读，避免一次分配几百 MB */
const MAX_REGION_BYTES = 64 * 1024 * 1024;

export type MemPlan = {
    exe: string;
    dll: string;
    holdSeconds: number;
    attachPid: number;
    help: boolean;
};

export function parseMemArgs(argv: readonly string[], root: string): MemPlan {
    const plan: MemPlan = {
        exe: resolve(root, "dist", "bun-app-window.exe"),
        dll: resolve(root, "dist", "libshell.dll"),
        holdSeconds: 25,
        attachPid: 0,
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
        } else if (arg === "dll") {
            plan.dll = resolve(needValue());
        } else if (arg === "hold") {
            const n = Number(needValue());
            if (!Number.isFinite(n) || n <= 0) throw new Error("--hold 需要正数秒");
            plan.holdSeconds = n;
        } else if (arg === "attach") {
            const n = Number(needValue());
            if (!Number.isInteger(n) || n <= 0) throw new Error("--attach 需要合法进程号");
            plan.attachPid = n;
        } else if (arg.length > 0) {
            throw new Error(`unknown argument: ${raw}`);
        }
    }
    return plan;
}

/** 磁盘 DLL 的特征：大小 + e_lfanew + PE 签名 + 导出名字符串偏移 */
export type DiskFingerprint = {
    path: string;
    size: number;
    peOffset: number;
    subsystem: number | null;
    fingerprintOffset: number;
};

export function fingerprintDll(path: string): DiskFingerprint | null {
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(readFileSync(path));
    } catch {
        return null;
    }
    const layout = locatePe(bytes);
    if (!layout) return null;
    const needle = new TextEncoder().encode(FINGERPRINT);
    return {
        path,
        size: bytes.length,
        peOffset: layout.peOffset,
        subsystem: readSubsystem(bytes),
        fingerprintOffset: indexOfBytes(bytes, needle),
    };
}

export type ModuleHit = { name: string; size: number; base: string };

/** 目标进程里名字含 `needle` 的模块（默认 `shell`） */
export function findModuleHits(hProcess: bigint, needle = "shell"): ModuleHit[] {
    const lower = needle.toLowerCase();
    return listModules(hProcess)
        .filter((m) => m.name.toLowerCase().includes(lower))
        .map((m) => ({
            name: m.name,
            size: m.size,
            base: `0x${m.base.toString(16)}`,
        }));
}

export type MemoryHit = { virtualAddress: string; regionBase: string; protect: string };

/**
 * 在目标进程的已提交区里搜指纹字节。
 *
 * 找到第一处就返回——多份副本没有额外信息，而全量扫描要付双倍时间。
 * 读失败的区（保护属性不允许）静默跳过：那是正常现象，不是错误。
 */
export function scanForFingerprint(
    hProcess: bigint,
    needle: Uint8Array,
    maxBytes = MAX_SCAN_BYTES,
): { hit: MemoryHit | null; scannedRegions: number; scannedBytes: number } {
    let address = 0n;
    let scannedRegions = 0;
    let scannedBytes = 0;

    while (scannedBytes < maxBytes) {
        const region = virtualQueryEx(hProcess, address);
        if (!region) break;

        const size = Number(region.size);
        if (isCommittedRegion(region) && size > 0 && size <= MAX_REGION_BYTES) {
            const buf = new Uint8Array(size);
            const read = readProcessMemory(hProcess, region.base, buf);
            if (read > 0) {
                scannedRegions++;
                scannedBytes += read;
                const at = indexOfBytes(buf.subarray(0, read), needle);
                if (at >= 0) {
                    const va = region.base + BigInt(at);
                    return {
                        hit: {
                            virtualAddress: `0x${va.toString(16)}`,
                            regionBase: `0x${region.base.toString(16)}`,
                            protect: `0x${region.protect.toString(16)}`,
                        },
                        scannedRegions,
                        scannedBytes,
                    };
                }
            }
        }

        const nextAddress = region.base + region.size;
        if (nextAddress <= address) break; // 防御：地址不再前进说明链断了
        address = nextAddress;
        if (address > 0x7fffffffffffn) break;
    }

    return { hit: null, scannedRegions, scannedBytes };
}

/** 等一个进程出现；超时返回 0 */
export function waitForPid(match: (pid: number) => boolean, timeoutMs: number): number {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const pid of listPids()) {
            if (match(pid)) return pid;
        }
        Bun.sleepSync(300);
    }
    return 0;
}

function printHelp(): void {
    console.log(`bun run scripts/probe-memory.ts [options]

  --exe <path>      要启动的自检程序（默认 dist/bun-app-window.exe）
  --dll <path>      磁盘上的 DLL 基准（默认 dist/libshell.dll）
  --hold <seconds>  目标进程保持存活的秒数（默认 25，靠 HOLD=1 环境变量）
  --attach <pid>    不启动新进程，直接查已有进程
  --help            显示本帮助`);
}

export async function main(argv: readonly string[], root: string): Promise<number> {
    let plan: MemPlan;
    try {
        plan = parseMemArgs(argv, root);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const disk = fingerprintDll(plan.dll);
    if (!disk) {
        console.error(`not a readable PE file: ${plan.dll}`);
        return 2;
    }
    console.log("=== disk fingerprint ===");
    console.log(`  ${disk.path}`);
    console.log(`  size           ${disk.size.toLocaleString("en-US")} bytes`);
    console.log(`  e_lfanew       0x${disk.peOffset.toString(16)}`);
    console.log(`  subsystem      ${disk.subsystem ?? "unknown"}`);
    console.log(`  '${FINGERPRINT}' @ 0x${disk.fingerprintOffset.toString(16)}`);
    console.log("");

    let child: ReturnType<typeof Bun.spawn> | null = null;
    let pid = plan.attachPid;

    if (pid === 0) {
        // HOLD=1 让自检程序在窗口关闭后仍存活一段时间，给扫描留窗口期
        child = Bun.spawn([plan.exe], {
            cwd: root,
            env: { ...process.env, HOLD: "1" },
            stdout: "ignore",
            stderr: "ignore",
        });
        const wanted = child.pid;
        pid = waitForPid((p) => p === wanted, 10_000);
        if (pid === 0) {
            console.error("target process did not appear within 10s");
            return 2;
        }
    }

    console.log(`=== target pid=${pid} ===`);

    const hProcess = openProcess(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ);
    if (hProcess === 0n) {
        console.error("OpenProcess failed（权限不足？本进程与目标是否同一完整性级别）");
        return 2;
    }

    try {
        const modules = listModules(hProcess);
        console.log(`loaded modules: ${modules.length}`);
        const hits = findModuleHits(hProcess, "shell");
        if (hits.length === 0) {
            console.log(`  no module name contains "shell"  → libshell 未注册为常规模块`);
            console.log(`  （若走 embedded 分支，这是预期结果：DLL 从内存映射加载）`);
        } else {
            for (const h of hits) {
                console.log(`  HIT ${h.name}  ${h.size.toLocaleString("en-US")} bytes  base=${h.base}`);
            }
        }
        console.log("");

        console.log(`=== scanning committed regions for '${FINGERPRINT}' ===`);
        const needle = new TextEncoder().encode(FINGERPRINT);
        const result = scanForFingerprint(hProcess, needle);
        console.log(
            `  scanned regions=${result.scannedRegions} bytes=${result.scannedBytes.toLocaleString("en-US")}`,
        );
        if (result.hit) {
            console.log(`  FOUND at VA ${result.hit.virtualAddress}`);
            console.log(`        region ${result.hit.regionBase}  protect ${result.hit.protect}`);
        } else {
            console.log("  NOT FOUND");
        }
        console.log("");

        // WebView2 子进程：原 test-av-runtime.ps1 的独特能力之一。
        // 那个脚本靠 schtasks /IT 跨会话拉起进程再跨会话观察；OTT 迁到
        // Session 1 之后不再需要跨会话，直接按映像名找 PID 就够了。
        const webview2 = findPidsByName("msedgewebview2.exe");
        console.log(`=== WebView2 child processes ===`);
        console.log(`  count: ${webview2.length}`);
        for (const p of webview2.slice(0, 10)) {
            const h = openProcess(p, PROCESS_QUERY_INFORMATION);
            const created = h !== 0n ? processCreationTime(h) : null;
            if (h !== 0n) closeHandle(h);
            const age = created === null ? "?" : `${Math.round((Date.now() - created) / 1000)}s ago`;
            console.log(`  pid=${String(p).padEnd(8)} created=${age}`);
        }
        console.log("");

        const hit = result.hit !== null;
        if (!hit && hits.length === 0) {
            console.log("verdict: DLL 既不在模块表、也不在提交内存里 —— 可能尚未被加载");
        } else if (hit) {
            console.log("verdict: DLL 已映射进内存（无论是否注册为模块）");
        } else {
            console.log("verdict: DLL 是模块但指纹未命中 —— 可能是不同构建，或只扫描了前 512 MiB");
        }
        return 0;
    } finally {
        closeHandle(hProcess);
        if (child) {
            try {
                child.kill();
            } catch {
                // 进程可能已自行退出
            }
        }
    }
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    try {
        process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dir, ".."));
    } finally {
        closeAll();
    }
}
