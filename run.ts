#!/usr/bin/env bun
/**
 * run.ts — 开发态启动器
 *
 * 用法：
 *
 *     bun run native/../run.ts          启动自检程序（30 秒后自动退出并打印自检结果）
 *     bun run run.ts --hold             保持窗口 25 秒供截图
 *
 * 同时接受 `-Hold` 这类 PowerShell 风格写法。
 *
 * 为什么从 run.ps1 迁过来：
 *
 * 旧脚本把 `bun` 的路径硬编码成 `C:\Users\root\scoop\shims\bun.exe`，
 * 换机器、换安装方式立刻失效，而且它在启动前就 `throw`，报错信息指向的是
 * 一个与本项目无关的绝对路径。这里用 `process.execPath`——当前正在运行的
 * 就是 bun，没有任何理由去猜它装在哪。
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isEntrypoint } from "./scripts/lib/entrypoint";

const REPO_ROOT = resolve(import.meta.dir);

/** `-Hold` / `--hold` 归一为 `--hold` */
function normalizeArg(arg: string): string {
    const m = /^-{1,2}([A-Za-z][\w-]*)$/.exec(arg);
    if (!m?.[1]) {
        return arg;
    }
    const kebab = m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `--${kebab}`;
}

export async function main(argv: readonly string[]): Promise<number> {
    const { values } = parseArgs({
        args: argv.map(normalizeArg),
        options: {
            hold: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });

    if (values.help) {
        console.log(`bun run run.ts [options]

  --hold       保持窗口 25 秒供截图（HOLD=1）
  -h, --help   显示本帮助`);
        return 0;
    }

    const hold = values.hold === true;
    const entry = join(REPO_ROOT, "src", "host.ts");

    if (!(await Bun.file(entry).exists())) {
        console.error(`missing self-test entry: ${entry}`);
        return 2;
    }

    if (hold) {
        console.log("[run] HOLD=1（窗口保持）");
    }

    const proc = Bun.spawn([process.execPath, entry], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...(hold ? { HOLD: "1" } : {}) },
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
    });

    const rc = await proc.exited;
    if (hold) {
        console.log(`[run] 退出码 ${rc}`);
    }
    return rc;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2));
}
