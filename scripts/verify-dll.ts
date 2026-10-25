#!/usr/bin/env bun
/**
 * verify-dll.ts — 确认入库的 dist/libshell.dll 是用当前 native/shell.cc 编出来的
 *
 * ## 为什么需要它
 *
 * 这个仓库把编译产物纳入版本控制（消费方 `bun add` 时不该需要 clang 与 WebView2
 * 头文件，见 ADR 0010）。代价是它**可能悄悄变陈旧**：改了 `native/shell.cc` 但忘了
 * `bun run build:native`，仓库里躺的还是旧 DLL。
 *
 * 这种陈旧**不会让门禁变红**：测试加载的是旧 DLL，而旧 DLL 的 33 个导出符号也都还
 * 在，`native-surface.test.ts` 照样全绿。发布出去的包里因此是一个与源码不一致的
 * 二进制——行为差异只会在运行期以「莫名其妙」的形式出现。
 *
 * ## 判据为什么不是「字节相同」
 *
 * 不可行。clang 在 COFF 头里写 `TimeDateStamp`（链接时刻），还有一处 4 字节字段由
 * 它派生，所以同一份源码两次构建永远差 8 个字节。实测：
 *
 *     SOURCE_DATE_EPOCH=1600000000  → a509c4759e3e7a43
 *     SOURCE_DATE_EPOCH=1950000000  → 8d6c5c9074299977
 *     差异字节恰好 8 个：0x80..0x83 与 0x6b204..0x6b207
 *
 * 所以判据是：**从当前源码重建，把 8 个时间派生字节对齐后，必须与入库版逐字节相同。**
 * 时间派生字节的全集不写死，而是每次实测出来的——那 8 个偏移是 clang 版本与链接
 * 布局的函数，写死就会在下次升级工具链时假红。
 *
 * ## 为什么不进默认门禁
 *
 * 两次构建约 5 秒，比整条门禁还慢。它属于「改原生层之后、提交之前」的动作，
 * 写进 `AGENTS.md` §8 的收尾清单。
 *
 * 用法：
 *
 *     bun run scripts/verify-dll.ts
 *     bun run scripts/verify-dll.ts --keep    # 保留重建产物供排查
 *
 * 退出码：0 同源，1 陈旧/不一致，2 环境问题（缺 clang、缺产物）。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { buildPaths, clangArgs } from "../native/build";
import { isEntrypoint } from "./lib/entrypoint";

/** 本文件在 scripts/ 下，上一层是仓库根 */
const REPO_ROOT = resolve(import.meta.dir, "..");

/** 用固定的时间戳编两次，覆盖 4 字节时间字段的全部位 */
const EPOCH_A = "1600000000";
const EPOCH_B = "1950000000";

const short = (u: Uint8Array): string => createHash("sha256").update(u).digest("hex").slice(0, 16);

async function readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/** 返回所有不同字节的偏移；长度不同直接抛错 */
export function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
    if (a.length !== b.length) {
        throw new Error(`长度不同：${a.length} vs ${b.length}，不可能是同一份源码的产物`);
    }
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) out.push(i);
    }
    return out;
}

export type VerifyResult =
    { ok: true; hash: string; size: number; timeDerived: number[] } | { ok: false; reason: string; detail: string[] };

/**
 * 重建并与入库产物比对。
 *
 * `deps` 全部可注入，便于测试时不真的调 clang。
 */
export async function verifyCommittedDll(deps: {
    /** 与入库产物比对的字节 */
    committed: Uint8Array;
    /** 用给定 SOURCE_DATE_EPOCH 构建一次，返回产物字节 */
    build: (epoch: string) => Promise<Uint8Array>;
    /** 两个 epoch 的取值，默认覆盖 4 字节时间字段的全部位 */
    epochA?: string;
    epochB?: string;
}): Promise<VerifyResult> {
    const epochA = deps.epochA ?? EPOCH_A;
    const epochB = deps.epochB ?? EPOCH_B;

    const a = await deps.build(epochA);
    const b = await deps.build(epochB);

    // 1. 同一份源码的两次构建：差异集合就是「时间派生字节」全集
    let timeDerived: number[];
    try {
        timeDerived = diffOffsets(a, b);
    } catch (err) {
        return {
            ok: false,
            reason: "同一份源码的两次构建长度不同 —— 构建本身不确定，无法判定",
            detail: [String(err)],
        };
    }

    if (timeDerived.length === 0) {
        return {
            ok: false,
            reason: "两次构建字节完全相同 —— 说明 SOURCE_DATE_EPOCH 没生效，判据不成立",
            detail: ["LLVM 从某个版本起支持该变量；若工具链不认，本工具无法给出结论"],
        };
    }

    // 2. 把入库版的时间派生字节对齐到 a，再比
    if (deps.committed.length !== a.length) {
        return {
            ok: false,
            reason: "入库产物与重建产物长度不同",
            detail: [`committed ${deps.committed.length} B / rebuilt ${a.length} B`],
        };
    }

    const patched = new Uint8Array(deps.committed);
    for (const i of timeDerived) patched[i] = a[i]!;

    let remaining: number[];
    try {
        remaining = diffOffsets(patched, a);
    } catch (err) {
        return { ok: false, reason: "对齐后比对失败", detail: [String(err)] };
    }

    if (remaining.length > 0) {
        return {
            ok: false,
            reason: `入库产物与当前源码不同源（时间派生字节之外还有 ${remaining.length} 字节不同）`,
            detail: [
                `差异偏移：${remaining
                    .slice(0, 24)
                    .map((i) => `0x${i.toString(16)}`)
                    .join(" ")}${remaining.length > 24 ? " …" : ""}`,
                "处理：bun run build:native，然后把 dist/libshell.dll 一起提交",
            ],
        };
    }

    return { ok: true, hash: short(a), size: a.length, timeDerived };
}

function printHelp(): void {
    console.log(`bun run scripts/verify-dll.ts [options]

  --keep     保留重建产物（.build/verify/*.dll）供人工比对
  --help     显示本帮助

## 它回答的问题

仓库里入库的 dist/libshell.dll，是不是用当前的 native/shell.cc 编出来的？

这个仓库把编译产物纳入版本控制（消费方装包时不该需要 clang）。风险是改了
shell.cc 却忘了 build:native —— 而**门禁不会红**：测试加载的是旧 DLL，旧 DLL 的
33 个导出符号也都在。

## 判据为什么不写死

clang 会在 COFF 头写链接时刻，并有一处 4 字节字段由它派生，所以同一份源码两次
构建永远差 8 个字节。本工具用 SOURCE_DATE_EPOCH 编两次，实测出「时间派生字节」
的偏移集合，再把入库版的对齐后逐字节比对。集合不写死，工具链升级也不会假红。

退出码：0 同源，1 陈旧，2 环境问题。`);
}

export async function main(argv: readonly string[]): Promise<number> {
    const args = argv.map((a) => a.replace(/^-{1,2}/, "").toLowerCase());
    if (args.includes("help") || args.includes("h")) {
        printHelp();
        return 0;
    }
    const keep = args.includes("keep");

    const paths = buildPaths(REPO_ROOT);
    const committedPath = `${REPO_ROOT}/dist/libshell.dll`;
    const verifyDir = `${REPO_ROOT}/.build/verify`;

    if (!existsSync(committedPath)) {
        console.error(`缺少入库产物：${committedPath}`);
        return 2;
    }
    if (Bun.which("clang++") === null) {
        // 不能静默通过：没有判据就没有结论
        console.error("找不到 clang++，无法重建比对。本工具不做「跳过即通过」的妥协。");
        return 2;
    }

    const committed = await readBytes(committedPath);

    const build = async (epoch: string): Promise<Uint8Array> => {
        const sp = Bun.spawn(["clang++", ...clangArgs(paths)], {
            stdout: "pipe",
            stderr: "pipe",
            // SOURCE_DATE_EPOCH 让 LLVM 把链接时刻固定下来，两次构建才可比
            env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
        });
        const rc = await sp.exited;
        if (rc !== 0) {
            throw new Error(`clang++ 失败 rc=${rc}\n${await new Response(sp.stderr).text()}`);
        }
        const bytes = await readBytes(paths.outDll);
        if (keep) {
            mkdirSync(verifyDir, { recursive: true });
            copyFileSync(paths.outDll, `${verifyDir}/libshell-${epoch}.dll`);
        }
        return bytes;
    };

    const result = await verifyCommittedDll({ committed, build });

    // 重建过程覆盖了 .build/libshell.dll。必须还原成入库那份，否则
    // `tests/resolve.test.ts` 的「.build 与 dist 是同一份产物」会红——
    // 而那不是产物的问题，是本工具留下的痕迹。
    copyFileSync(committedPath, paths.outDll);

    if (result.ok) {
        console.log(`VERIFY-DLL PASSED`);
        console.log(`  产物   ${result.size.toLocaleString("en-US")} B  sha256:${result.hash}…`);
        console.log(`  时间派生字节 ${result.timeDerived.length} 个（对齐后逐字节相同）`);
        console.log(`  结论   入库的 dist/libshell.dll 与 native/shell.cc 同源`);
        return 0;
    }

    console.error(`VERIFY-DLL FAILED`);
    console.error(`  ${result.reason}`);
    for (const line of result.detail) console.error(`  ${line}`);
    return 1;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2));
    if (!process.argv.includes("--keep")) {
        rmSync(`${REPO_ROOT}/.build/verify`, { recursive: true, force: true });
    }
}
