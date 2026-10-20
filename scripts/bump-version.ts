#!/usr/bin/env bun
/**
 * bump-version.ts — 一处输入、两处落盘地升级版本号
 *
 * 版本号有两处会进入构建产物，必须同时修改：
 *
 *     package.json               npm 发布用
 *     native/build-pack.ps1      exe 的 PE 版本资源（--windows-version）
 *
 * 手工改一处、漏一处不会报错，只会静默漂移（npm 上是 0.2.0，exe 属性页写着
 * 0.1.0.0）。本脚本消除这个漂移面，`tests/version.test.ts` 负责在提交前复验。
 *
 * CHANGELOG.md 不自动改写：版本段落的结构由人决定，脚本不去猜。
 *
 * 用法：
 *
 *     bun run scripts/bump-version.ts 0.3.0             写入
 *     bun run scripts/bump-version.ts 0.3.0 --dry-run   只预演
 *     bun run scripts/bump-version.ts --help
 *
 * 同时接受 `-DryRun` 这类 PowerShell 风格写法。
 *
 * 退出码：0 = 成功或无需改动；2 = 输入非法或找不到目标文件。
 *
 * 为什么从 .ps1 迁过来：替换发生在整段文本上，而 PowerShell 的
 * `Set-Content` 会把文件按 CRLF 重写、`-replace` 走的是正则引擎。
 * 本仓 `.gitattributes` 固化 LF，一次「只改了一个版本号」的操作可能顺带
 * 改掉整个文件的字节——`docs/pitfalls.md` 5.6 记过真实的 EOL 污染事故。
 * 这里改为「读字节 → 定点替换 → 写回原 EOL」，并在测试里断言旧 EOL 被保留。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntrypoint } from "./lib/entrypoint";

/** 仓库根：scripts/ 的上一级 */
export const REPO_ROOT = resolve(import.meta.dir, "..");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type BumpPlan = {
    /** 目标 semver，原样写入 package.json */
    version: string;
    /** PE 四段版本：前三段跟随 semver，第四段固定 0（PE 资源不承载 prerelease） */
    peVersion: string;
};

/** 由 semver 推出 PE 版本。非法 semver 返回 null，由调用方决定如何报错。 */
export function planBump(version: string): BumpPlan | null {
    const m = SEMVER.exec(version);
    if (!m) {
        return null;
    }
    const [, major, minor, patch] = m;
    return {
        version,
        peVersion: `${major}.${minor}.${patch}.0`,
    };
}

/** 检测文本的主导 EOL。无换行时返回 "\n"。 */
export function detectEol(text: string): "\r\n" | "\n" {
    return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 把 `package.json` 的 version 字段改掉。
 *
 * 只认 `"version": "..."` 这一行，用行内定位而不是全局正则替换——
 * 全局替换会连带改到 `engines` 或依赖里形似的键。返回 null 表示定位失败。
 */
export function replacePkgVersion(raw: string, version: string): string | null {
    const pattern = /^(\s*"version"\s*:\s*")[^"]+(")/m;
    if (!pattern.test(raw)) {
        return null;
    }
    return raw.replace(pattern, `$1${version}$2`);
}

/**
 * 把 `build-pack.ps1` 的 `--windows-version` 改掉。
 *
 * 同样只认那一行的字面量。返回 null 表示定位失败。
 */
export function replacePeVersion(raw: string, peVersion: string): string | null {
    const pattern = /^(\s*'--windows-version'\s*,\s*')[^']+(')/m;
    if (!pattern.test(raw)) {
        return null;
    }
    return raw.replace(pattern, `$1${peVersion}$2`);
}

/** `-DryRun` / `--dry-run` 归一为 `--dry-run` */
function normalizeArg(arg: string): string {
    const m = /^-{1,2}([A-Za-z][\w-]*)$/.exec(arg);
    if (!m?.[1]) {
        return arg;
    }
    const kebab = m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `--${kebab}`;
}

export async function main(argv: readonly string[], root: string = REPO_ROOT): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv.map(normalizeArg),
        options: {
            "dry-run": { type: "boolean", default: false },
            root: { type: "string" },
            help: { type: "boolean", default: false },
        },
        allowPositionals: true,
        strict: true,
    });

    if (values.help) {
        console.log(`bun run scripts/bump-version.ts <version> [options]

  <version>      目标版本号，形如 1.2.3 或 1.2.3-beta.1
                 PE 四段版本固定取前三段补 .0
  --dry-run      只显示将要产生的改动，不写盘
  --root <dir>   仓库根目录（默认：本文件的上一级）
  -h, --help     显示本帮助`);
        return 0;
    }

    const target = positionals[0];
    if (!target) {
        console.error("missing version argument (e.g. 0.3.0)");
        return 2;
    }

    const plan = planBump(target);
    if (!plan) {
        console.error(`版本号必须形如 1.2.3 或 1.2.3-beta.1，收到：${target}`);
        return 2;
    }

    const base = values.root ? resolve(values.root) : root;
    const dryRun = values["dry-run"] === true;

    const pkgPath = join(base, "package.json");
    const packPath = join(base, "native", "build-pack.ps1");

    let pkgRaw: string;
    let packRaw: string;
    try {
        pkgRaw = readFileSync(pkgPath, "utf8");
        packRaw = readFileSync(packPath, "utf8");
    } catch (err) {
        console.error(`cannot read target file: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }

    const pkgNew = replacePkgVersion(pkgRaw, plan.version);
    const packNew = replacePeVersion(packRaw, plan.peVersion);

    if (pkgNew === null) {
        console.error(`package.json 里定位不到 version 字段`);
        return 2;
    }
    if (packNew === null) {
        console.error(`native/build-pack.ps1 里定位不到 --windows-version`);
        return 2;
    }

    console.log("");
    console.log(`目标版本：${plan.version}（exe PE 版本：${plan.peVersion}）`);
    console.log("");
    console.log(`  package.json          -> "version": "${plan.version}"`);
    console.log(`  native/build-pack.ps1 -> '--windows-version', '${plan.peVersion}'`);
    console.log("");

    if (dryRun) {
        console.log("（dry-run：未写入任何文件）");
        return 0;
    }

    if (pkgNew === pkgRaw && packNew === packRaw) {
        console.log("两处均已是目标版本，无改动。");
        return 0;
    }

    // 写回时用原文的 EOL：替换只动了版本号那几个字节，其余字节必须原样保留。
    // 直接把 newText 交给 writeFileSync 会写 UTF-8 字面量，而 oldText 已含原 EOL，
    // 所以两者一致——显式断言一次，避免将来有人改成按行重排。
    const eolPkg = detectEol(pkgRaw);
    const eolPack = detectEol(packRaw);
    if (detectEol(pkgNew) !== eolPkg || detectEol(packNew) !== eolPack) {
        console.error("internal: EOL changed during replacement — refusing to write");
        return 2;
    }

    if (pkgNew !== pkgRaw) {
        writeFileSync(pkgPath, pkgNew, "utf8");
        console.log(`已写入 ${pkgPath}`);
    }
    if (packNew !== packRaw) {
        writeFileSync(packPath, packNew, "utf8");
        console.log(`已写入 ${packPath}`);
    }

    console.log("");
    console.log("下一步：");
    console.log("  1. 在 CHANGELOG.md 里为新版本补一段（Unreleased 内容下移）");
    console.log("  2. bun run scripts/gate.ts    # version.test.ts 会复验两处一致");
    console.log(`  3. git commit -m "chore: 版本号升至 ${plan.version}"`);
    console.log("  4. bun publish               # 会弹 passkey 2FA，需人工确认");
    console.log(`  5. git tag -a v${plan.version} -m "bun-app-window ${plan.version}" && git push origin v${plan.version}`);
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2));
}
