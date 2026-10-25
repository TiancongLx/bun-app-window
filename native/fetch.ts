#!/usr/bin/env bun
/**
 * fetch.ts — 补齐重建 libshell.dll 所需的三份输入
 *
 * `vendor/` 在仓库里不是一整块，三份输入的来源各不相同：
 *
 *     vendor/webview/core/include/webview/webview.h              入库，随 clone 到位
 *     vendor/webview/compatibility/mingw/include/EventToken.h    入库，随 clone 到位
 *     vendor/webview2/build/native/include/WebView2.h            未入库，由 nupkg 解压
 *
 * 默认行为是「只补齐缺的」，且尽量离线：前两份通常已在 `vendor/webview` 里；
 * 第三份从同样已入库的 `vendor/Microsoft.Web.WebView2.<ver>.nupkg` 解压，不联网。
 * clone 上游源码属于例外，必须显式加 `--webview`——它会覆盖 `vendor/webview` 下
 * 145 个受版本控制的文件，`git diff` 会实实在在地变。
 *
 * 判据是 `native/build.ps1` 自己校验的那三个文件，不是旁证（有没有 `.git`、
 * 目录是否非空）。两个脚本因此不可能对「准备好了没有」给出两种答案。旧版
 * 判的是「`vendor/webview` 下有没有 `.git`」，而入库拷贝没有 `.git`——条件恒为真，
 * 于是每次都 clone 到非空目录，`git` 返回 128，脚本在第 1 步就死了，
 * 第 3 步的解压永远不执行（`docs/pitfalls.md` 5.5、ADR 0011）。
 *
 * 用法：
 *
 *     bun run native/fetch.ts              只补齐缺的输入（默认路径全程离线）
 *     bun run native/fetch.ts --sdk        重新下载并解压 SDK（怀疑 vendor/webview2 被改坏）
 *     bun run native/fetch.ts --webview    重新 clone 上游源码（覆盖 vendor/webview）
 *     bun run native/fetch.ts --force      等价于 --webview --sdk
 *
 * 同时接受 `-Webview` / `-Sdk` / `-Force` 这类 PowerShell 风格写法，与
 * `scripts/gate.ts` 保持一致——改脚本不该顺带改掉人的肌肉习惯。
 *
 * 退出码：0 = 三份输入齐备；1 = 有输入缺失且未获授权补齐；2 = 环境问题。
 *
 * 关于可移植性：本文件与 `scripts/gate.ts` 各有一份 10 行的参数名归一化。
 * 暂不提取共用模块——两处重复尚不值得引入跨目录依赖，出现第三处再抽。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntrypoint } from "../scripts/lib/entrypoint";

// ---- 常量 -------------------------------------------------------------------

const PKG_NAME = "Microsoft.Web.WebView2.1.0.4258.31.nupkg";
const PKG_VERSION = "1.0.4258.31";
const PKG_URL = `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${PKG_VERSION}`;
const WEBVIEW_REPO = "https://github.com/webview/webview.git";

/** 三份输入，路径与 `native/build.ps1` 的前置校验一一对应 */
export const INPUTS = [
    { name: "webview.h", dir: "webview", rel: "webview/core/include/webview/webview.h" },
    { name: "EventToken.h", dir: "webview", rel: "webview/compatibility/mingw/include/EventToken.h" },
    { name: "WebView2.h", dir: "webview2", rel: "webview2/build/native/include/WebView2.h" },
] as const;

// ---- 决策（纯函数，由 tests/fetch.test.ts 覆盖）-------------------------------

export type WebviewPlan =
    | { kind: "skip" }
    | { kind: "clone" }
    /** 目录在但不完整：补全会覆盖受版本控制的内容，必须显式授权 */
    | { kind: "refuse"; missing: string[] };

/**
 * 决定上游源码那一步做什么。
 *
 * 四种状态：
 *   1. 显式要求重拉            → clone
 *   2. 两份输入都在            → skip
 *   3. 目录整个不存在          → clone（没有可保护的内容）
 *   4. 目录在但输入不全        → refuse（覆盖现有内容需显式授权）
 */
export function decideWebview(opts: {
    forceClone: boolean;
    dirExists: boolean;
    missing: readonly string[];
}): WebviewPlan {
    if (opts.forceClone) {
        return { kind: "clone" };
    }
    if (opts.missing.length === 0) {
        return { kind: "skip" };
    }
    if (!opts.dirExists) {
        return { kind: "clone" };
    }
    return { kind: "refuse", missing: [...opts.missing] };
}

export type SdkPlan =
    | { kind: "skip" }
    /** `download` 为真表示 nupkg 也不在仓库里，需要联网 */
    | { kind: "install"; download: boolean };

/**
 * 决定 WebView2 SDK 那一步做什么。
 *
 *   1. 显式要求重下            → install + download
 *   2. 头文件已在              → skip
 *   3. 头文件缺、nupkg 不在    → install + download
 *   4. 头文件缺、nupkg 在      → install，离线解压
 */
export function decideSdk(opts: { forceDownload: boolean; headerPresent: boolean; pkgPresent: boolean }): SdkPlan {
    if (opts.forceDownload) {
        return { kind: "install", download: true };
    }
    if (opts.headerPresent) {
        return { kind: "skip" };
    }
    return { kind: "install", download: !opts.pkgPresent };
}

// ---- 参数 -------------------------------------------------------------------

/** `-SkipPack` / `-skip-pack` / `--skip-pack` 归一为 `--skip-pack` */
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

async function run(argv: string[], cwd?: string): Promise<number> {
    const proc = Bun.spawn(argv, {
        ...(cwd === undefined ? {} : { cwd }),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (out.trim()) {
        process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
    }
    if (err.trim()) {
        process.stderr.write(err.endsWith("\n") ? err : `${err}\n`);
    }
    return code;
}

function step(text: string): void {
    console.log("");
    console.log(`=== ${text} ===`);
}

async function installWebview(root: string): Promise<void> {
    step("clone webview/webview（需要联网）");
    const git = assertTool("git", "webview 源码需由 git 拉取");

    const vendor = join(root, "vendor");
    const wvDir = join(vendor, "webview");
    mkdirSync(vendor, { recursive: true });

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const staging = join(tmpdir(), `baw-webview-${stamp}`);

    try {
        const rc = await run([git, "clone", "--depth", "1", WEBVIEW_REPO, staging]);
        if (rc !== 0) {
            throw new Fatal(`git clone failed: ${rc}`);
        }

        // 入库的 vendor/webview 是「无 .git 的纯文件拷贝」。留下 .git 会让父仓库
        // 多出一个嵌套仓库，git status 的语义随环境而变（与 .gitignore 第 4 行
        // 那条「不依赖用户环境的全局配置」同一个取向）。保留内容、剥掉仓库元信息。
        rmSync(join(staging, ".git"), { recursive: true, force: true });

        rmSync(wvDir, { recursive: true, force: true });
        renameSync(staging, wvDir);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

async function installSdk(root: string, download: boolean): Promise<void> {
    step("WebView2 SDK");

    const vendor = join(root, "vendor");
    const sdkDir = join(vendor, "webview2");
    const pkgPath = join(vendor, PKG_NAME);

    if (!existsSync(pkgPath) || download) {
        const aria = assertTool("aria2c", "WebView2 nupkg 不在仓库里，需由 aria2c 下载");
        console.log(`downloading ${PKG_NAME} ...`);
        const rc = await run([
            aria,
            "--console-log-level=warn",
            "--summary-interval=0",
            "--max-tries=3",
            "-d",
            vendor,
            "-o",
            PKG_NAME,
            PKG_URL,
        ]);
        if (rc !== 0) {
            throw new Fatal(`aria2c failed: ${rc}`);
        }
    } else {
        console.log(`${PKG_NAME} 已在仓库内，跳过下载`);
    }

    const sevenZip = assertTool("7z", "nupkg 是 zip 容器，需由 7z 解压");
    console.log("extracting ...");
    rmSync(sdkDir, { recursive: true, force: true });
    const rc = await run([sevenZip, "x", pkgPath, `-o${sdkDir}`, "-y"]);
    if (rc !== 0) {
        throw new Fatal(`7z failed: ${rc}`);
    }
}

// ---- 汇总 -------------------------------------------------------------------

function readUpstreamVersion(root: string): string[] {
    const file = join(root, "vendor", "webview", "core", "include", "webview", "version.h");
    if (!existsSync(file)) {
        return [];
    }
    // 只认 `#define WEBVIEW_VERSION_X 12` 这种取值行；`#ifndef` 守卫行不含数字，一并排除
    const pattern = /^\s*#define\s+(WEBVIEW_VERSION_(?:MAJOR|MINOR|PATCH))\s+(\d+)/;
    return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => pattern.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => `${m[1]} ${m[2]}`);
}

function summarize(root: string): boolean {
    step("summary");

    const rows = INPUTS.map((input) => {
        const abs = join(root, "vendor", input.rel);
        const ok = existsSync(abs);
        return { rel: input.rel, ok, size: ok ? statSync(abs).size : 0 };
    });

    const width = rows.reduce((w, r) => Math.max(w, r.rel.length), 0);
    let allOk = true;
    for (const row of rows) {
        if (!row.ok) {
            allOk = false;
        }
        const mark = row.ok ? "ok  " : "MISS";
        const size = row.ok ? `${row.size.toLocaleString("en-US")} B` : "";
        console.log(`  ${mark} ${row.rel.padEnd(width)}  ${size}`);
    }

    const versions = readUpstreamVersion(root);
    if (versions.length > 0) {
        console.log("");
        console.log("  upstream version:");
        for (const line of versions) {
            console.log(`    ${line}`);
        }
    }

    console.log("");
    if (allOk) {
        console.log("FETCH OK");
    } else {
        console.log("FETCH FAILED: not all inputs are present");
    }
    return allOk;
}

// ---- 入口 -------------------------------------------------------------------

export async function main(argv: readonly string[], root: string): Promise<number> {
    const { values } = parseArgs({
        args: argv.map(normalizeArg),
        options: {
            root: { type: "string" },
            webview: { type: "boolean", default: false },
            sdk: { type: "boolean", default: false },
            force: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });

    if (values.help) {
        console.log(`bun run native/fetch.ts [options]

  --root <dir>   仓库根目录（默认：本文件的上一级）
  --webview      重新 clone 上游 webview/webview 源码（联网，会覆盖 vendor/webview）
  --sdk          重新下载并解压 WebView2 SDK（联网）
  --force        等价于 --webview --sdk
  -h, --help     显示本帮助`);
        return 0;
    }

    const base = values.root ? resolve(values.root) : root;
    const forceAll = values.force === true;
    const wantWebview = forceAll || values.webview === true;
    const wantSdk = forceAll || values.sdk === true;

    const vendor = join(base, "vendor");
    const wvDir = join(vendor, "webview");
    const pkgPath = join(vendor, PKG_NAME);

    try {
        // ---- 1. 上游 webview 源码 -------------------------------------------
        const missing = INPUTS.filter((i) => i.dir === "webview")
            .filter((i) => !existsSync(join(vendor, i.rel)))
            .map((i) => i.rel);

        const wvPlan = decideWebview({
            forceClone: wantWebview,
            dirExists: existsSync(wvDir),
            missing,
        });

        if (wvPlan.kind === "clone") {
            await installWebview(base);
        } else if (wvPlan.kind === "skip") {
            console.log("[1/2] webview 源码完整，跳过");
        } else {
            step("vendor/webview 存在但不完整");
            for (const m of wvPlan.missing) {
                console.log(`  缺 ${m}`);
            }
            console.log("");
            console.log("补齐需要重新 clone 上游源码（联网，且会覆盖现有目录）。");
            console.log("确认后重跑：bun run native/fetch.ts --webview");
            return 1;
        }

        // ---- 2. WebView2 SDK -------------------------------------------------
        const headerPresent = existsSync(join(vendor, INPUTS[2].rel));
        const pkgPresent = existsSync(pkgPath);

        const sdkPlan = decideSdk({
            forceDownload: wantSdk,
            headerPresent,
            pkgPresent,
        });

        if (sdkPlan.kind === "skip") {
            console.log("[2/2] WebView2 SDK 已解压，跳过");
        } else {
            if (sdkPlan.download) {
                console.log("[2/2] WebView2 头文件或 nupkg 缺失，需下载");
            } else {
                console.log("[2/2] WebView2 头文件缺失，从仓库内 nupkg 离线解压");
            }
            await installSdk(base, sdkPlan.download);
        }

        // ---- 3. 汇总 ---------------------------------------------------------
        return summarize(base) ? 0 : 1;
    } catch (err) {
        if (err instanceof Fatal) {
            console.error("");
            console.error(`fetch: ${err.message}`);
            return 2;
        }
        throw err;
    }
}

// 只有直接执行时才跑 main；被 tests/ 导入时不产生副作用。
// 判据不能只用 import.meta.main —— 见 scripts/lib/entrypoint.ts 里的实测记录。
if (isEntrypoint(import.meta.main, import.meta.path)) {
    const root = resolve(import.meta.dir, "..");
    const code = await main(process.argv.slice(2), root);
    process.exitCode = code;
}
