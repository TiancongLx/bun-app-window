#!/usr/bin/env bun
/**
 * install-hooks.ts — 安装 Git 钩子。新机器 clone 后执行一次。
 *
 * Git 不允许跟踪 `.git/hooks/` 里的文件，所以钩子无法随仓库分发。本脚本把仓库内
 * 的钩子模板复制到 hooks 目录并标记为可执行，让门禁在任何机器上都能一致地恢复。
 *
 * 目前只安装 pre-push：它在推送前转调 `bun run scripts/gate.ts`。
 *
 * 用法：
 *
 *     bun run scripts/install-hooks.ts              已存在且内容相同则跳过
 *     bun run scripts/install-hooks.ts --force      覆盖已有的同名钩子
 *     bun run scripts/install-hooks.ts --dry-run    只打印将要写入的内容
 *
 * 同时接受 `-Force` / `-DryRun` 这类 PowerShell 风格写法。
 *
 * 退出码：0 = 已就位或成功写入；1 = 已存在且内容不同（未覆盖）；2 = 环境问题。
 *
 * 为什么从 .ps1 迁过来：PowerShell 的 `Set-Content` / `Out-File` 会按
 * `[Environment]::NewLine` 写盘，不保留原文件的 EOL。而本仓 `.gitattributes`
 * 固化 LF，钩子里若是 CRLF 会导致 `sh` 无法执行——`docs/pitfalls.md` 5.6 记过
 * 一次真实的 EOL 污染。TS 里写字节就是字节，不存在这个隐式转换。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntrypoint } from "./lib/entrypoint";

export const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * pre-push 钩子内容。
 *
 * 导出成常量而不是写在函数里，是为了让测试能断言它的关键性质：
 * 以 `#!/bin/sh` 开头、只做转调不含判定逻辑、调用的是当前存在的入口。
 *
 * **必须是 LF**。这里用模板字符串显式 `\n`，且写盘时不经过任何 EOL 转换。
 */
export const PRE_PUSH_HOOK = `#!/bin/sh
# pre-push —— 本地推送门禁
#
# 本仓库不使用远端 CI（账户 billing lock，且项目是单平台单人开发）。
# 门禁逻辑的唯一事实源是 scripts/gate.ts，本钩子只做转调，不复制逻辑，
# 以免两处判定标准漂移。
#
# 为什么用 \`bun run\` 而不是直接执行：Windows 不解析 shebang，\`./gate.ts\`
# 会被当作「打开文档」；bun 全平台一致，且本来就是本项目的硬前提。
#
# 归属：位于 .git/hooks/，不纳入版本控制，不随仓库分发。
#       新机器 clone 后需手动创建，或用 scripts/install-hooks.ts。
# 绕过：git push --no-verify
# 移除：删除本文件即可，无其他副作用。

cd "$(git rev-parse --show-toplevel)" || exit 1

if [ ! -f scripts/gate.ts ]; then
    echo "[pre-push] scripts/gate.ts 不存在，跳过门禁。" >&2
    echo "[pre-push] 若这是刚 clone 的仓库，请确认脚本已就位。" >&2
    exit 0
fi

bun run scripts/gate.ts
rc=$?

if [ "$rc" -ne 0 ]; then
    echo "[pre-push] 门禁未通过，推送已取消。" >&2
    echo "[pre-push] 修好后重推，或 git push --no-verify 临时绕过。" >&2
    exit 1
fi

exit 0
`;

/** `-SkipPack` / `-skip-pack` / `--skip-pack` 归一为 `--skip-pack` */
function normalizeArg(arg: string): string {
    const m = /^-{1,2}([A-Za-z][\w-]*)$/.exec(arg);
    if (!m?.[1]) {
        return arg;
    }
    const kebab = m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `--${kebab}`;
}

/**
 * 解析 `core.hooksPath`。
 *
 * 只保留纯解析部分，git 调用交给调用方——这样这段逻辑可以在没有仓库的地方测。
 * 相对路径按仓库根解析（git 的语义），绝对路径原样返回。
 */
export function resolveHooksDir(repoRoot: string, coreHooksPath: string | null | undefined): string {
    const custom = coreHooksPath?.trim();
    if (custom) {
        return isAbsolute(custom) ? custom : join(repoRoot, custom);
    }
    return join(repoRoot, ".git", "hooks");
}

/** EOL 归一化：用于比较，不用于写盘 */
export function normalizeEol(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

export type InstallPlan = "created" | "updated" | "unchanged" | "conflict" | "dry-run";

/**
 * 决定要做什么。纯函数，由 `tests/install-hooks.test.ts` 覆盖。
 *
 * 「已存在且内容相同」必须跳过而不是重写——否则每次执行都会改动 mtime，
 * 且在不必要的时刻触碰 `.git/hooks/` 下的文件。
 */
export function planInstall(opts: {
    exists: boolean;
    existingContent: string | null;
    force: boolean;
    dryRun: boolean;
    template: string;
}): InstallPlan {
    if (opts.dryRun) {
        return "dry-run";
    }
    if (!opts.exists) {
        return "created";
    }
    const same = opts.existingContent !== null && normalizeEol(opts.existingContent) === normalizeEol(opts.template);
    if (same) {
        return "unchanged";
    }
    return opts.force ? "updated" : "conflict";
}

async function gitConfigGet(cwd: string, key: string): Promise<string | null> {
    const proc = Bun.spawn(["git", "config", "--get", key], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) {
        return null;
    }
    const value = out.trim();
    return value.length > 0 ? value : null;
}

export async function main(argv: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv.map(normalizeArg),
        options: {
            force: { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });

    if (values.help) {
        console.log(`bun run scripts/install-hooks.ts [options]

  --force       覆盖已存在的同名钩子（默认不覆盖，避免冲掉本地自定义）
  --dry-run     只打印将要写入的内容，不落盘
  -h, --help    显示本帮助`);
        return 0;
    }

    const force = values.force === true;
    const dryRun = values["dry-run"] === true;

    if (!existsSync(join(REPO_ROOT, ".git"))) {
        console.error(`not a git repository: ${REPO_ROOT}`);
        return 2;
    }

    // 尊重 core.hooksPath：配了就装到那里，否则用默认 .git/hooks
    const custom = await gitConfigGet(REPO_ROOT, "core.hooksPath");
    const hooksDir = resolveHooksDir(REPO_ROOT, custom);

    if (!existsSync(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
    }

    console.log(`hooks dir: ${hooksDir}`);

    const target = join(hooksDir, "pre-push");
    const exists = existsSync(target);
    const existingContent = exists ? readFileSync(target, "utf8") : null;

    const plan = planInstall({
        exists,
        existingContent,
        force,
        dryRun,
        template: PRE_PUSH_HOOK,
    });

    switch (plan) {
        case "dry-run": {
            console.log("");
            console.log(`--- would write to ${target} ---`);
            console.log(PRE_PUSH_HOOK);
            return 0;
        }
        case "unchanged": {
            console.log("pre-push: already up to date");
            return 0;
        }
        case "conflict": {
            console.log("pre-push: exists with different content, not overwriting (use --force)");
            return 1;
        }
        case "created":
        case "updated": {
            // 显式 utf8：不传编码时 Bun 按 UTF-8 写，但写出来的是调用方给的字节，
            // 不做任何 EOL 转换——这正是我们要的（模板里只有 \n）
            writeFileSync(target, PRE_PUSH_HOOK, "utf8");
            console.log(`pre-push: ${plan === "created" ? "installed" : "updated"}`);
            console.log("");
            console.log("验证：git push --dry-run   （应看到 gate 输出）");
            return 0;
        }
    }
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2));
}
