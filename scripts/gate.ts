#!/usr/bin/env bun
/**
 * gate.ts — 本地质量门禁
 *
 * 本仓库不使用远端 CI：账户 billing lock 导致 runner 无法分配，且项目本身是
 * Windows x64 单平台、单人开发、零外部服务依赖，远端 CI 的边际价值低于维护成本。
 * 门禁在本地执行。
 *
 * 四个阶段：
 *
 *     bun check                        类型检查
 *     .ps1 syntax                      剩余 PowerShell 脚本的语法校验
 *     bun test                         行为测试
 *     bun run scripts/verify-pack.ts   消费方验收（打包 → 白名单 → 装临时工程 → 类型 + 运行时）
 *
 * 第 3 段补的是仓库内 `bun test` 看不见的那一层：`bun test` 走「源码 + 本地 dist」，
 * 而「作为 tarball 被第三方安装」这条链路整段缺席。`exports` 拼错、`files` 漏项、
 * 类型声明缺位，这三种故障在仓库内全绿，装起来就炸。
 *
 * 第 2 段是迁移期的临时护栏：仓库里还剩 14 个依赖 Win32 API 的 `.ps1`，它们没有
 * 类型检查也没有测试（ADR 0012）。语法级校验挡不住语义错误，但比零覆盖强。
 * 等这些脚本全部迁走或明确留用，这一段就可以删掉。
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
 *   - 本文件受 `bun check` 覆盖，且自身的判定逻辑由 `tests/gate.test.ts` 覆盖
 *
 * 用法：
 *
 *     bun run scripts/gate.ts                 全部阶段
 *     bun run scripts/gate.ts --clean         在 HEAD 的干净副本里跑
 *     bun run scripts/gate.ts --skip-pack     跳过消费方验收（只在改门禁自身时用）
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
 *
 * 结构说明：纯函数（参数归一化、摘要解析、阶段编排、汇总格式）全部导出，
 * 执行部分通过 `GateDeps` 注入。这样 `tests/gate.test.ts` 能不启动子进程就
 * 覆盖判定逻辑——门禁是所有质量保证的入口，它自己最不该没有测试。
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

// ---- 类型 -------------------------------------------------------------------

export type RunResult = { code: number; out: string; err: string };

export type Stage = "check" | "ps1" | "test" | "pack";

export type StageResult = {
    stage: Stage;
    ok: boolean;
    rc: number;
    ms: number;
    detail: string;
};

export type GateOptions = {
    clean: boolean;
    keepClone: boolean;
    skipTest: boolean;
    skipPack: boolean;
};

export type GateIO = {
    step(text: string): void;
    log(line: string): void;
    warn(line: string): void;
};

/** 阶段执行器。测试注入假实现来验证短路，不必真的起四个子进程 */
export type StageRunner = Record<Stage, (cwd: string) => Promise<StageResult>>;

export type GateDeps = {
    io: GateIO;
    runner: StageRunner;
    hasPackageJson(dir: string): Promise<boolean>;
};

export const LABELS: Record<Stage, string> = {
    check: "bun check",
    ps1: ".ps1 syntax",
    test: "bun test",
    pack: "pack verification",
};

// ---- 纯函数 -----------------------------------------------------------------

/** `-SkipPack` / `--skip-pack` / `-skipPack` 归一为 `--skip-pack` */
export function normalizeArg(arg: string): string {
    const m = /^-{1,2}([A-Za-z][\w-]*)$/.exec(arg);
    if (!m?.[1]) {
        return arg;
    }
    const kebab = m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    return `--${kebab}`;
}

export function parseGateArgs(argv: readonly string[]): GateOptions & { help: boolean } {
    const parsed = parseArgs({
        args: argv.map(normalizeArg),
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
    return {
        clean: parsed.values.clean === true,
        keepClone: parsed.values["keep-clone"] === true,
        skipTest: parsed.values["skip-test"] === true,
        skipPack: parsed.values["skip-pack"] === true,
        help: parsed.values.help === true,
    };
}

/**
 * `bun check` 的摘要措辞有两种，成功与失败不同；都写在 stderr（stdout 是空的）。
 * 取文件数是为了挡住「tsconfig 的 include 写歪了所以检查了 0 个文件」这种满分答卷。
 */
export function checkedFileCount(res: RunResult): number {
    const combined = `${res.out}\n${res.err}`;
    const m =
        /No type errors in (\d+)\s+files?/i.exec(combined) ??
        /checked\s+(\d+)\s+files?/i.exec(combined);
    return m?.[1] ? Number(m[1]) : 0;
}

/** 从 `bun test` 的输出里取通过/失败计数；取不到返回 null */
export function parseTestCounts(res: RunResult): { pass: number; fail: number } | null {
    const combined = `${res.out}\n${res.err}`;
    const pass = /(\d+)\s+pass/m.exec(combined);
    if (!pass?.[1]) {
        return null;
    }
    const fail = /(\d+)\s+fail/m.exec(combined);
    return { pass: Number(pass[1]), fail: fail?.[1] ? Number(fail[1]) : 0 };
}

/** 从 verify-pack 的输出里取最后一行结论；取不到返回空串 */
export function parsePackSummary(res: RunResult): string {
    return (
        `${res.out}`
            .split(/\r?\n|\r/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("VERIFY-PACK") || l.startsWith("verify-pack:"))
            .pop() ?? ""
    );
}

/** 从 .ps1 语法检查的输出里取结论行 */
export function parsePs1Summary(res: RunResult): string {
    return (
        `${res.out}`
            .split(/\r?\n|\r/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("PS1 SYNTAX"))
            .pop() ?? ""
    );
}

/**
 * 该跑哪些阶段。
 *
 * `--skip-test` 连带跳过消费方验收——它与 `bun test` 同属「行为层」，
 * 单独留下的价值很低，且原版就是这个语义，不在这里改。
 */
export function planStages(opts: GateOptions): Stage[] {
    const stages: Stage[] = ["check", "ps1"];
    if (!opts.skipTest) {
        stages.push("test");
        if (!opts.skipPack) {
            stages.push("pack");
        }
    }
    return stages;
}

/** 单个阶段的一行结论 */
export function formatStage(r: StageResult): string {
    const seconds = (r.ms / 1000).toFixed(1);
    const tail = r.detail ? ` — ${r.detail}` : "";
    return r.ok
        ? `${LABELS[r.stage]} ok (${seconds}s)${tail}`
        : `${LABELS[r.stage]} FAILED (rc=${r.rc}, ${seconds}s)${tail}`;
}

/** 汇总表。返回行数组而不是直接打印，便于断言 */
export function summarize(results: readonly StageResult[]): string[] {
    const width = Math.max(...Object.values(LABELS).map((l) => l.length));
    const lines: string[] = ["", "--- summary ---"];
    for (const r of results) {
        const mark = r.ok ? "ok  " : "FAIL";
        const tail = r.detail ? `  ${r.detail}` : "";
        lines.push(`  ${mark} ${LABELS[r.stage].padEnd(width)} ${(r.ms / 1000).toFixed(2)}s${tail}`);
    }
    const total = results.reduce((sum, r) => sum + r.ms, 0);
    lines.push(`  total ${(total / 1000).toFixed(2)}s`);
    return lines;
}

// ---- 门禁主体 ---------------------------------------------------------------

/**
 * 按 `planStages` 的顺序跑，任一阶段失败立即短路。
 *
 * 短路不是优化，是语义：类型都过不了就没必要跑消费方验收，否则日志会被
 * 后续阶段的失败淹没，人只会看最后一行。
 */
export async function runGate(
    workDir: string,
    opts: GateOptions,
    deps: GateDeps,
): Promise<boolean> {
    if (!(await deps.hasPackageJson(workDir))) {
        deps.io.warn(`not a package root: ${workDir}`);
        return false;
    }

    const results: StageResult[] = [];

    for (const stage of planStages(opts)) {
        deps.io.step(LABELS[stage]);
        const result = await deps.runner[stage](workDir);
        results.push(result);
        deps.io.log(formatStage(result));
        if (!result.ok) {
            for (const line of summarize(results)) {
                deps.io.log(line);
            }
            return false;
        }
    }

    // 被跳过的阶段要留痕，否则「门禁通过」这句话的覆盖面是模糊的
    if (opts.skipTest) {
        deps.io.log("bun test skipped (--skip-test)");
    } else if (opts.skipPack) {
        deps.io.log("pack verification skipped (--skip-pack)");
    }

    for (const line of summarize(results)) {
        deps.io.log(line);
    }
    return true;
}

// ---- 真实执行器 -------------------------------------------------------------

function replay(res: RunResult): void {
    if (res.out) {
        process.stdout.write(res.out.endsWith("\n") ? res.out : `${res.out}\n`);
    }
    if (res.err) {
        process.stderr.write(res.err.endsWith("\n") ? res.err : `${res.err}\n`);
    }
}

async function spawn(argv: readonly string[], cwd: string): Promise<RunResult> {
    const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, out, err };
}

const BUN = process.execPath;

async function runCheck(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "check"], cwd);
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

/**
 * 剩余 `.ps1` 的语法校验。
 *
 * 依赖 pwsh 存在：本仓开发环境本来就需要它（`install-hooks.ps1`、`build.ps1` 还没迁），
 * 但门禁不该因为缺一个可选的检查工具而整体失败——缺 pwsh 时判为跳过并说明。
 * 一旦这些脚本全部迁走，这一段就该删掉，而不是留着当永久负担。
 */
async function runPs1Syntax(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const pwsh = Bun.which("pwsh");
    if (!pwsh) {
        const ms = performance.now() - started;
        return { stage: "ps1", ok: true, rc: 0, ms, detail: "pwsh not found — skipped" };
    }

    // 路径里的单引号在 PowerShell 单引号字符串里要成对转义
    const rootLiteral = cwd.replace(/'/g, "''");
    const script = `
$ErrorActionPreference = 'Stop'
$files = @(Get-ChildItem -LiteralPath '${rootLiteral}' -Filter *.ps1 -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '[\\\\/](node_modules|vendor)[\\\\/]' })
$bad = @()
foreach ($f in $files) {
    $err = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$err)
    foreach ($e in $err) {
        $bad += ('{0}:{1}: {2}' -f $f.FullName, $e.Extent.StartLineNumber, $e.Message)
    }
}
if ($files.Count -eq 0) { Write-Output 'PS1 SYNTAX OK (0 files)'; exit 0 }
if ($bad.Count -gt 0) {
    $bad | ForEach-Object { Write-Output $_ }
    Write-Output ('PS1 SYNTAX FAILED ({0} errors in {1} files)' -f $bad.Count, $files.Count)
    exit 1
}
Write-Output ('PS1 SYNTAX OK ({0} files)' -f $files.Count)
`;

    const res = await spawn([pwsh, "-NoProfile", "-NonInteractive", "-Command", script], cwd);
    const ms = performance.now() - started;
    replay(res);

    const detail = parsePs1Summary(res);
    return { stage: "ps1", ok: res.code === 0, rc: res.code, ms, detail };
}

async function runTest(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "test"], cwd);
    const ms = performance.now() - started;
    replay(res);

    const counts = parseTestCounts(res);
    const detail = counts ? `${counts.pass} pass / ${counts.fail} fail` : "";
    return { stage: "test", ok: res.code === 0, rc: res.code, ms, detail };
}

async function runPack(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "run", join(cwd, "scripts", "verify-pack.ts")], cwd);
    const ms = performance.now() - started;
    replay(res);

    return { stage: "pack", ok: res.code === 0, rc: res.code, ms, detail: parsePackSummary(res) };
}

const REAL_RUNNER: StageRunner = {
    check: runCheck,
    ps1: runPs1Syntax,
    test: runTest,
    pack: runPack,
};

const CONSOLE_IO: GateIO = {
    step(text) {
        console.log("");
        console.log(`=== ${text} ===`);
    },
    log(line) {
        console.log(line);
    },
    warn(line) {
        console.error(line);
    },
};

function realDeps(): GateDeps {
    return {
        io: CONSOLE_IO,
        runner: REAL_RUNNER,
        hasPackageJson: async (dir) => Bun.file(join(dir, "package.json")).exists(),
    };
}

// ---- 干净副本模式 -----------------------------------------------------------

/**
 * 删临时副本。失败必须被看见——静默吞掉会让 %TEMP% 每跑一次就多一份仓库，
 * 而门禁看起来一直是绿的。maxRetries 是给 Windows 的：刚退出的子进程可能
 * 还短暂持着句柄。
 */
async function removeClone(dir: string, io: GateIO): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        io.log("clean clone removed");
    } catch (err) {
        io.warn("");
        io.warn(`warning: could not remove clean clone: ${dir}`);
        io.warn(`         ${err instanceof Error ? err.message : String(err)}`);
        io.warn("         remove it by hand");
    }
}

export async function gateClean(root: string, opts: GateOptions, deps: GateDeps): Promise<boolean> {
    const io = deps.io;
    const status = await spawn(["git", "status", "--porcelain"], root);
    const head = await spawn(["git", "rev-parse", "--short", "HEAD"], root);
    const headSha = head.out.trim() || "unknown";

    const dirty = status.out.split(/\r?\n|\r/).filter((line) => line.trim().length > 0);
    if (dirty.length > 0) {
        io.log("");
        io.log("WARNING: working tree has uncommitted changes.");
        io.log("         --clean clones HEAD only; those changes are NOT included.");
        for (const line of dirty) {
            io.log(`         ${line}`);
        }
        io.log("         Run without --clean to verify the working tree as-is.");
    }

    // 只留数字：toISOString() 是 2026-10-20T14:25:07.123Z，去掉 -:T 后仍剩小数点，
    // 而 Windows 不允许目录名以点结尾（git clone 会报 Invalid argument）
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const probe = join(tmpdir(), `baw-gate-${stamp}`);
    const totalStart = performance.now();

    io.step(`clean clone HEAD(${headSha}) -> ${probe}`);

    // file:// 前缀：本地路径直接 clone 时 git 会忽略 --depth 并告警
    const srcUrl = `file:///${root.replace(/\\/g, "/")}`;
    const clone = await spawn(["git", "clone", "--quiet", "--depth", "1", srcUrl, probe], root);
    if (clone.code !== 0) {
        io.warn(`git clone failed (rc=${clone.code})`);
        replay(clone);
        return false;
    }

    try {
        io.step("bun install --frozen-lockfile");
        const install = await spawn([BUN, "install", "--frozen-lockfile"], probe);
        replay(install);
        if (install.code !== 0) {
            io.warn(`bun install failed (rc=${install.code})`);
            return false;
        }

        const ok = await runGate(probe, opts, deps);
        const elapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
        io.log("");
        io.log(`total (clean): ${elapsed}s`);
        return ok;
    } finally {
        if (opts.keepClone) {
            io.log("");
            io.log(`clone kept at: ${probe}`);
        } else {
            await removeClone(probe, io);
        }
    }
}

// ---- 入口 -------------------------------------------------------------------

/** 跑完整个门禁并设置退出码。返回退出码，便于测试 */
export async function main(argv: readonly string[], root: string): Promise<number> {
    const parsed = parseGateArgs(argv);

    if (parsed.help) {
        console.log(`bun run scripts/gate.ts [options]

  --clean        在 HEAD 的干净副本里跑（消除本地产物掩盖问题的可能）
  --keep-clone   与 --clean 同用，保留副本供排查
  --skip-test    只跑类型检查与 .ps1 语法，跳过行为测试与消费方验收
  --skip-pack    跳过消费方验收（只在改门禁自身时用）
  -h, --help     显示本帮助`);
        return 0;
    }

    const opts: GateOptions = {
        clean: parsed.clean,
        keepClone: parsed.keepClone,
        skipTest: parsed.skipTest,
        skipPack: parsed.skipPack,
    };
    const deps = realDeps();

    // 不用 process.exit() 表达结果：它立即终止进程，会跳过 gateClean 的 finally，
    // 临时副本因此漏删（scripts/verify-pack.ts 踩过同一个坑，2026-10-20 实测）。
    let ok: boolean;
    let envProblem = false;
    try {
        ok = opts.clean ? await gateClean(root, opts, deps) : await runGate(root, opts, deps);
    } catch (err) {
        CONSOLE_IO.warn("");
        CONSOLE_IO.warn(
            `gate: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        ok = false;
        envProblem = true;
    }

    const suffix = opts.clean ? " (clean)" : "";
    console.log("");
    if (envProblem) {
        console.log(`GATE ERROR${suffix}`);
        return 2;
    }
    if (ok) {
        console.log(`GATE PASSED${suffix}`);
        return 0;
    }
    console.log(`GATE FAILED${suffix}`);
    return 1;
}

// 只有直接执行时才跑；被 tests/ 导入时不产生副作用
if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dir, ".."));
}
