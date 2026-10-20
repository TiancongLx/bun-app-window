#!/usr/bin/env bun
/**
 * gate.ts — 本地质量门禁
 *
 * 本仓库不使用远端 CI：账户 billing lock 导致 runner 无法分配，且项目本身是
 * Windows x64 单平台、单人开发、零外部服务依赖，远端 CI 的边际价值低于维护成本。
 * 门禁在本地执行。
 *
 * 三段：
 *
 *     bun check                    类型检查
 *     bun test                     行为测试
 *     bun run scripts/verify-pack.ts   消费方验收（打包 → 白名单 → 装临时工程 → 类型 + 运行时）
 *
 * 第三段补的是仓库内 `bun test` 看不见的那一层：`bun test` 走「源码 + 本地 dist」，
 * 而「作为 tarball 被第三方安装」这条链路整段缺席。`exports` 拼错、`files` 漏项、
 * 类型声明缺位，这三种故障在仓库内全绿，装起来就炸。
 *
 * `--clean` 在 %TEMP% 里 clone 一份干净副本再跑，消除 `.build/` / `node_modules/` /
 * `vendor/webview2/` 等本地残留掩盖问题的可能；未提交改动会被提示并排除在外。
 *
 * 为什么是 TypeScript 而不是 PowerShell（ADR 0012）：
 *
 *   - `$LASTEXITCODE` 是全局变量，只反映最后一条 native 命令；`Bun.spawn` 的
 *     `exited` 是每次调用绑定的值，不存在时序歧义
 *   - PowerShell 函数的所有输出都会进入返回值管道，写出「失败却报 GATE PASSED」
 *     那种 bug 的成本极低（docs/pitfalls.md 5.3 实录）；TS 没有这个语义陷阱
 *   - 本文件受 `bun check` 覆盖。此前的 gate.ps1 连类型都没有，唯一的静态判据
 *     是 `[Parser]::ParseFile`，而它本身还要在 pwsh 里跑
 *
 * 用法：
 *
 *     bun run scripts/gate.ts                 三段全跑
 *     bun run scripts/gate.ts --clean         在 HEAD 的干净副本里跑
 *     bun run scripts/gate.ts --skip-pack     跳过第三段（只在改门禁自身时用）
 *     bun run scripts/gate.ts --keep-clone    与 --clean 同用，保留副本供排查
 *
 * 退出码：0 = 全部通过，1 = 门禁失败，2 = 环境问题。
 *
 * 关于参数风格：同时接受 `--skip-pack` 与 `-SkipPack`。后者是 PowerShell 用户的
 * 肌肉记忆，改脚本不该顺带改掉人的习惯。
 *
 * 关于 shebang：`#!/usr/bin/env bun` 在 PowerShell 里无效（Windows 不解析 shebang，
 * 直接执行会被当作「打开文档」），但在 Git 的 `sh` 下生效——那正是 pre-push 钩子
 * 的运行环境。package.json 里不放 gate 脚本（AGENTS.md 限定 scripts 只能有
 * build:native / build:exe / demo / pack 四项），所以入口固定为
 * `bun run scripts/gate.ts`。
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;

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

const parsed = parseArgs({
    args: process.argv.slice(2).map(normalizeArg),
    options: {
        clean: { type: "boolean", default: false },
        "keep-clone": { type: "boolean", default: false },
        "skip-test": { type: "boolean", default: false },
        "skip-pack": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
});

const CLEAN = parsed.values.clean;
const KEEP_CLONE = parsed.values["keep-clone"];
const SKIP_TEST = parsed.values["skip-test"];
const SKIP_PACK = parsed.values["skip-pack"];

if (parsed.values.help) {
    console.log(`bun run scripts/gate.ts [options]

  --clean        在 HEAD 的干净副本里跑（消除本地产物掩盖问题的可能）
  --keep-clone   与 --clean 同用，保留副本供排查
  --skip-test    只跑类型检查，跳过行为测试与消费方验收
  --skip-pack    跳过消费方验收（只在改门禁自身时用）
  -h, --help     显示本帮助`);
    process.exitCode = 0;
    process.exit(0);
}

// ---- 工具 -------------------------------------------------------------------

function writeStep(text: string): void {
    console.log("");
    console.log(`=== ${text} ===`);
}

type RunResult = { code: number; out: string; err: string };

async function run(argv: readonly string[], cwd: string): Promise<RunResult> {
    const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out, err };
}

/** 原样回放子进程输出。`bun check` 的错误走 stdout、摘要走 stderr，两者都要 */
function replay(res: RunResult): void {
    if (res.out) {
        process.stdout.write(res.out.endsWith("\n") ? res.out : `${res.out}\n`);
    }
    if (res.err) {
        process.stderr.write(res.err.endsWith("\n") ? res.err : `${res.err}\n`);
    }
}

type Stage = "check" | "test" | "pack";

type StageResult = { stage: Stage; ok: boolean; rc: number; ms: number; detail: string };

const LABELS: Record<Stage, string> = {
    check: "bun check",
    test: "bun test",
    pack: "pack verification",
};

/**
 * `bun check` 的摘要措辞有两种，成功与失败不同；都写在 stderr。
 * 取文件数是为了挡住「tsconfig 的 include 写歪了所以检查了 0 个文件」这种满分答卷。
 */
function checkedFileCount(res: RunResult): number {
    const combined = `${res.out}\n${res.err}`;
    const m = /No type errors in (\d+)\s+files?/i.exec(combined) ?? /checked\s+(\d+)\s+files?/i.exec(combined);
    return m?.[1] ? Number(m[1]) : 0;
}

// ---- 单个阶段 ---------------------------------------------------------------

async function runCheck(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await run([BUN, "check"], cwd);
    const ms = performance.now() - started;
    replay(res);

    // `bun check` 在没有可检查文件时也会 exit 1（文档明文），所以退出码是主判据
    if (res.code !== 0) {
        return { stage: "check", ok: false, rc: res.code, ms, detail: "type errors" };
    }

    const files = checkedFileCount(res);
    if (files < 1) {
        return {
            stage: "check",
            ok: false,
            rc: res.code,
            ms,
            detail: "退出码为 0 但没能确认检查了多少文件——tsconfig 的 include 可能写歪了",
        };
    }
    return { stage: "check", ok: true, rc: res.code, ms, detail: `${files} files` };
}

async function runTest(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await run([BUN, "test"], cwd);
    const ms = performance.now() - started;
    replay(res);

    const combined = `${res.out}\n${res.err}`;
    const m = /(\d+)\s+pass/m.exec(combined);
    const fail = /(\d+)\s+fail/m.exec(combined);
    const detail = m?.[1] ? `${m[1]} pass / ${fail?.[1] ?? "?"} fail` : "";

    return { stage: "test", ok: res.code === 0, rc: res.code, ms, detail };
}

async function runPack(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await run([BUN, "run", join(cwd, "scripts", "verify-pack.ts")], cwd);
    const ms = performance.now() - started;
    replay(res);

    const line =
        `${res.out}`
            .split(/\r?\n|\r/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("VERIFY-PACK") || l.startsWith("verify-pack:"))
            .pop() ?? "";

    return { stage: "pack", ok: res.code === 0, rc: res.code, ms, detail: line };
}

// ---- 门禁主体 ---------------------------------------------------------------

/** 在指定工作目录跑全部阶段。返回是否全部通过 */
async function runGate(workDir: string): Promise<boolean> {
    if (!(await Bun.file(join(workDir, "package.json")).exists())) {
        console.error(`not a package root: ${workDir}`);
        return false;
    }

    const results: StageResult[] = [];

    writeStep(LABELS.check);
    const check = await runCheck(workDir);
    results.push(check);
    reportStage(check);
    if (!check.ok) {
        return summarize(results, false);
    }

    if (!SKIP_TEST) {
        writeStep(LABELS.test);
        const test = await runTest(workDir);
        results.push(test);
        reportStage(test);
        if (!test.ok) {
            return summarize(results, false);
        }
    } else {
        console.log("bun test skipped (--skip-test)");
    }

    if (!SKIP_TEST && !SKIP_PACK) {
        writeStep(LABELS.pack);
        const pack = await runPack(workDir);
        results.push(pack);
        reportStage(pack);
        if (!pack.ok) {
            return summarize(results, false);
        }
    } else if (SKIP_PACK) {
        console.log("pack verification skipped (--skip-pack)");
    }

    return summarize(results, true);
}

function reportStage(r: StageResult): void {
    const seconds = (r.ms / 1000).toFixed(1);
    const tail = r.detail ? ` — ${r.detail}` : "";
    if (r.ok) {
        console.log(`${LABELS[r.stage]} ok (${seconds}s)${tail}`);
    } else {
        console.log(`${LABELS[r.stage]} FAILED (rc=${r.rc}, ${seconds}s)${tail}`);
    }
}

function summarize(results: readonly StageResult[], ok: boolean): boolean {
    console.log("");
    console.log("--- summary ---");
    for (const r of results) {
        const mark = r.ok ? "ok  " : "FAIL";
        const tail = r.detail ? `  ${r.detail}` : "";
        console.log(`  ${mark} ${LABELS[r.stage].padEnd(18)} ${(r.ms / 1000).toFixed(2)}s${tail}`);
    }
    const total = results.reduce((sum, r) => sum + r.ms, 0);
    console.log(`  total ${(total / 1000).toFixed(2)}s`);
    return ok;
}

// ---- 干净副本模式 -----------------------------------------------------------

/**
 * 删临时副本。失败必须被看见——静默吞掉会让 %TEMP% 每跑一次就多一份仓库，
 * 而门禁看起来一直是绿的。maxRetries 是给 Windows 的：刚退出的子进程可能
 * 还短暂持着句柄。
 */
async function removeClone(dir: string): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        console.log("clean clone removed");
    } catch (err) {
        console.warn("");
        console.warn(`warning: could not remove clean clone: ${dir}`);
        console.warn(`         ${err instanceof Error ? err.message : String(err)}`);
        console.warn("         remove it by hand");
    }
}

async function gateClean(): Promise<boolean> {
    const status = await run(["git", "status", "--porcelain"], REPO_ROOT);
    const head = await run(["git", "rev-parse", "--short", "HEAD"], REPO_ROOT);
    const headSha = head.out.trim() || "unknown";

    const dirty = status.out.split(/\r?\n|\r/).filter((line) => line.trim().length > 0);
    if (dirty.length > 0) {
        console.log("");
        console.log("WARNING: working tree has uncommitted changes.");
        console.log("         --clean clones HEAD only; those changes are NOT included.");
        for (const line of dirty) {
            console.log(`         ${line}`);
        }
        console.log("         Run without --clean to verify the working tree as-is.");
    }

    // 只留数字：toISOString() 是 2026-10-20T14:25:07.123Z，去掉 -:T 后仍剩小数点，
    // 而 Windows 不允许目录名以点结尾（git clone 会报 Invalid argument）
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const probe = join(tmpdir(), `baw-gate-${stamp}`);
    const totalStart = performance.now();

    writeStep(`clean clone HEAD(${headSha}) -> ${probe}`);

    // file:// 前缀：本地路径直接 clone 时 git 会忽略 --depth 并告警
    const srcUrl = `file:///${REPO_ROOT.replace(/\\/g, "/")}`;
    const clone = await run(["git", "clone", "--quiet", "--depth", "1", srcUrl, probe], REPO_ROOT);
    if (clone.code !== 0) {
        console.error(`git clone failed (rc=${clone.code})`);
        replay(clone);
        return false;
    }

    try {
        writeStep("bun install --frozen-lockfile");
        const install = await run([BUN, "install", "--frozen-lockfile"], probe);
        replay(install);
        if (install.code !== 0) {
            console.error(`bun install failed (rc=${install.code})`);
            return false;
        }

        const ok = await runGate(probe);
        const elapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
        console.log("");
        console.log(`total (clean): ${elapsed}s`);
        return ok;
    } finally {
        if (KEEP_CLONE) {
            console.log("");
            console.log(`clone kept at: ${probe}`);
        } else {
            await removeClone(probe);
        }
    }
}

// ---- 入口 -------------------------------------------------------------------

// 不用 process.exit() 表达结果：它立即终止进程，会跳过 gateClean 的 finally，
// 临时副本因此漏删（scripts/verify-pack.ts 踩过同一个坑，2026-10-20 实测）。
let ok: boolean;
let envProblem = false;
try {
    ok = CLEAN ? await gateClean() : await runGate(REPO_ROOT);
} catch (err) {
    console.error("");
    console.error(
        `gate: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    ok = false;
    envProblem = true;
}

console.log("");
if (envProblem) {
    console.log(CLEAN ? "GATE ERROR (clean)" : "GATE ERROR");
    process.exitCode = 2;
} else if (ok) {
    console.log(CLEAN ? "GATE PASSED (clean)" : "GATE PASSED");
    process.exitCode = 0;
} else {
    console.log(CLEAN ? "GATE FAILED (clean)" : "GATE FAILED");
    process.exitCode = 1;
}
