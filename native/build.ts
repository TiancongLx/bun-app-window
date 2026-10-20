#!/usr/bin/env bun
/**
 * build.ts — 编译原生层，生成 `.build/libshell.dll` 并同步至 `dist/`
 *
 * 用法：
 *
 *     bun run native/build.ts              编译（增量：已有的 .build 内容不动）
 *     bun run native/build.ts --clean      先清空 .build 下的文件再编译
 *     bun run native/build.ts --rebuild    等价于 --clean，保留旧写法
 *
 * 同时接受 `-Clean` 这类 PowerShell 风格写法。
 *
 * 三份输入必须齐备，判据与 `native/fetch.ts` 的 `INPUTS` 完全一致——
 * 两处都引同一个常量，不可能再对「准备好了没有」给出两种答案。
 *
 * 退出码：0 = 成功；1 = 编译失败；2 = 环境问题（缺工具或缺输入）。
 *
 * 为什么从 .ps1 迁过来（ADR 0012）：
 *   - `$LASTEXITCODE` 是全局变量、只反映最后一条 native 命令；`Bun.spawn` 的
 *     `exited` 是每次调用绑定的值
 *   - 参数拼装抽成纯函数后可被测试钉住：漏一个 `-l` 或写错一个 `-I`，
 *     PS1 版本只能靠编译报错才发现，且报错信息指向的是 C++ 而不是脚本
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntrypoint } from "../scripts/lib/entrypoint";
import { INPUTS } from "./fetch";

// ---- 纯函数（由 tests/build.test.ts 覆盖）------------------------------------

/** 必须链接的 Win32 导入库。顺序无关，但保持与旧版一致便于对照 */
export const LIBS = [
    "advapi32",
    "ole32",
    "oleaut32",
    "uuid",
    "shell32",
    "shlwapi",
    "user32",
    "version",
    "dwmapi",
] as const;

/** 与平台/优化相关的固定开关 */
export const BASE_FLAGS = [
    "-std=c++17",
    "-O2",
    "-shared",
    "-static-libgcc",
    "-static-libstdc++",
    "-DWEBVIEW_STATIC",
    "-DUNICODE",
    "-D_UNICODE",
    "-Wall",
    "-Wextra",
    "-Wno-unknown-pragmas",
    "-Wno-unused-parameter",
] as const;

export type BuildPaths = {
    root: string;
    vendor: string;
    includeDirs: string[];
    source: string;
    outDir: string;
    outDll: string;
    distDir: string;
    distDll: string;
};

/**
 * 由仓库根推出全部路径。
 *
 * 纯函数：不碰文件系统，因此「include 目录顺序」「输出位置」这类容易写错的
 * 东西可以在测试里直接断言，不需要真的跑一次 clang。
 */
export function buildPaths(root: string): BuildPaths {
    const vendor = join(root, "vendor");
    const outDir = join(root, ".build");
    const distDir = join(root, "dist");
    return {
        root,
        vendor,
        includeDirs: [
            join(vendor, "webview", "core", "include"),
            join(vendor, "webview", "compatibility", "mingw", "include"),
            join(vendor, "webview2", "build", "native", "include"),
        ],
        source: join(root, "native", "shell.cc"),
        outDir,
        outDll: join(outDir, "libshell.dll"),
        distDir,
        distDll: join(distDir, "libshell.dll"),
    };
}

/**
 * 拼出完整的 clang++ 参数表。
 *
 * 顺序有意义：`-I` 与源文件之后才是 `-o` 与 `-l`。导出成纯函数是为了让
 * 「漏了一个库」这类错误在 `bun test` 阶段就暴露，而不是等到链接期。
 */
export function clangArgs(paths: BuildPaths): string[] {
    const includes = paths.includeDirs.map((dir) => `-I${dir}`);
    const libs = LIBS.map((lib) => `-l${lib}`);
    return [
        ...BASE_FLAGS,
        ...includes,
        paths.source,
        "-o",
        paths.outDll,
        ...libs,
    ];
}

/** 三份输入是否齐备。返回缺失项，空数组表示齐备 */
export function missingInputs(root: string, exists: (p: string) => boolean = existsSync): string[] {
    const vendor = join(root, "vendor");
    return INPUTS.filter((input) => !exists(join(vendor, input.rel))).map((input) => input.rel);
}

// ---- 参数 -------------------------------------------------------------------

/** `-Clean` / `-clean` / `--clean` 归一为 `--clean` */
function normalizeArg(arg: string): string {
    const m = /^-{1,2}([A-Za-z][\w-]*)$/.exec(arg);
    if (!m?.[1]) {
        return arg;
    }
    const kebab = m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `--${kebab}`;
}

// ---- 执行 -------------------------------------------------------------------

class Fatal extends Error {}

function assertTool(name: string, hint: string): string {
    const found = Bun.which(name);
    if (found) {
        return found;
    }
    throw new Fatal(`missing tool: ${name}${hint ? `\n  ${hint}` : ""}`);
}

async function runCapture(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out, err };
}

function replay(res: { out: string; err: string }): void {
    if (res.out) {
        process.stdout.write(res.out.endsWith("\n") ? res.out : `${res.out}\n`);
    }
    if (res.err) {
        process.stderr.write(res.err.endsWith("\n") ? res.err : `${res.err}\n`);
    }
}

export async function main(argv: readonly string[], root: string): Promise<number> {
    const { values } = parseArgs({
        args: argv.map(normalizeArg),
        options: {
            root: { type: "string" },
            clean: { type: "boolean", default: false },
            rebuild: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });

    if (values.help) {
        console.log(`bun run native/build.ts [options]

  --root <dir>   仓库根目录（默认：本文件的上一级）
  --clean        先清空 .build 下的文件再编译
  --rebuild      等价于 --clean
  -h, --help     显示本帮助`);
        return 0;
    }

    const base = values.root ? resolve(values.root) : root;
    const clean = values.clean === true || values.rebuild === true;
    const paths = buildPaths(base);

    try {
        // ---- 1. 前置检查 -----------------------------------------------------
        const missing = missingInputs(base);
        if (missing.length > 0) {
            for (const rel of missing) {
                console.error(`missing prerequisite: vendor/${rel}`);
            }
            console.error("");
            console.error("补齐输入：bun run native/fetch.ts");
            return 2;
        }

        const clang = assertTool("clang++", "原生层需要一个 C++17 编译器（llvm-mingw 的 clang++）");

        mkdirSync(paths.outDir, { recursive: true });
        if (clean && existsSync(paths.outDir)) {
            for (const name of readdirSync(paths.outDir)) {
                const p = join(paths.outDir, name);
                if (statSync(p).isFile()) {
                    rmSync(p, { force: true });
                }
            }
        }

        // ---- 2. 编译 ---------------------------------------------------------
        const args = clangArgs(paths);
        console.log(`clang++ ${args.join(" ")}`);
        console.log("");

        const build = await runCapture([clang, ...args], base);
        replay(build);
        if (build.code !== 0) {
            console.error(`clang++ failed: ${build.code}`);
            return 1;
        }

        if (!existsSync(paths.outDll)) {
            console.error(`clang++ reported success but produced no output: ${paths.outDll}`);
            return 1;
        }

        // ---- 3. 同步到 dist/ -------------------------------------------------
        // 包分发从 dist/ 取：package.json 的 files 与 embedded 入口都指向它
        mkdirSync(paths.distDir, { recursive: true });
        copyFileSync(paths.outDll, paths.distDll);

        console.log("");
        console.log(`built : ${paths.outDll} (${statSync(paths.outDll).size.toLocaleString("en-US")} bytes)`);
        console.log(`staged: ${paths.distDll}`);

        // ---- 4. 报告 ---------------------------------------------------------
        const nm = Bun.which("llvm-nm");
        if (nm) {
            console.log("");
            console.log("=== exported symbols ===");
            const res = await runCapture([nm, "--defined-only", "--extern-only", "--demangle", paths.outDll], base);
            const symbols = `${res.out}\n${res.err}`
                .split(/\r?\n/)
                .filter((line) => line.includes("shell_"));
            for (const line of symbols) {
                console.log(line);
            }
            console.log(`(${symbols.length} matching lines)`);
        }

        const objdump = Bun.which("llvm-objdump");
        if (objdump) {
            console.log("");
            console.log("=== runtime deps ===");
            const res = await runCapture([objdump, "-p", paths.outDll], base);
            const deps = `${res.out}\n${res.err}`
                .split(/\r?\n/)
                .filter((line) => line.includes("DLL Name"));
            for (const line of deps) {
                console.log(line);
            }
        }

        return 0;
    } catch (err) {
        if (err instanceof Fatal) {
            console.error("");
            console.error(`build: ${err.message}`);
            return 2;
        }
        throw err;
    }
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dir, ".."));
}
