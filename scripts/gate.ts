#!/usr/bin/env bun
/**
 * gate.ts — 本地质量门禁
 *
 * 本仓库不使用远端 CI：账户 billing lock 导致 runner 无法分配，且项目本身是
 * Windows x64 单平台、单人开发、零外部服务依赖，远端 CI 的边际价值低于维护成本。
 * 门禁在本地执行。
 *
 * 三个阶段：
 *
 *     bun check                        类型检查
 *     bun test                         行为测试
 *     bun run scripts/verify-pack.ts   消费方验收（打包 → 白名单 → 装临时工程 → 类型 + 运行时）
 *
 * 第 3 段补的是仓库内 `bun test` 看不见的那一层：`bun test` 走「源码 + 本地 dist」，
 * 而「作为 tarball 被第三方安装」这条链路整段缺席。`exports` 拼错、`files` 漏项、
 * 类型声明缺位，这三种故障在仓库内全绿，装起来就炸。
 *
 * **曾有第四个阶段（`.ps1` 语法校验）**，作为迁移期护栏存在（ADR 0012）。2026-10-21
 * 仓库里最后两个 `.ps1` 退役后它失去了对象，按 `ADR 0014` §4 的约定删掉了——
 * 「降到一个都不剩时，评估是否还值得付那 0.5 秒」，答案是连评估的对象都没了。
 *
 * `--clean` 在 %TEMP% 里 clone 一份干净副本再跑，消除 `.build/` / `node_modules/` /
 * `vendor/webview2/` 等本地残留掩盖问题的可能；未提交改动会被提示并排除在外。
 *
 * **`--clean` 的覆盖范围比工作区小，这一点每次都会打印出来。** `AGENTS.md` 与
 * `.internal/adr/` 不在版本控制里（`.gitignore`），干净副本没有它们，
 * `tests/agents-doc.test.ts` 的 `guard` 于是整组 `describe.skip`。连带后果是
 * `文档里的脚本路径引用` 那条也不跑，而它同时检查 `docs/pitfalls.md`——所以
 * 「文档里引用了不存在的路径」这一类问题，只有在不带 `--clean` 时才可能被抓到。
 * 打 `GATE PASSED` 一律带 `(clean)` 后缀，就是为了不让两种覆盖范围混为一谈。
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
 *     bun run scripts/gate.ts --verbose       回放每个阶段的完整输出
 *
 * 输出策略：默认只报每个阶段的结论行。`bun test` 通过时会打印 256 行 `(pass)`，
 * 加上各阶段的正常输出约 24 KB —— 对人和对代理都是纯噪音；真正有用的信息是
 * 「哪一段、多少项、耗时多久」。失败时相反：完整回放该阶段的原始输出，并在回放
 * 之前先把 `(fail)` 行摘出来，免得失败点埋在几百行 pass 里。`--verbose` 恢复
 * 「照单全收」的旧行为，用于排查「输出里有警告但阶段仍然通过」这类情形。
 * 被折叠的行数会报出来，不会静默吞掉。
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

import { isEntrypoint } from "./lib/entrypoint";

// ---- 类型 -------------------------------------------------------------------

export type RunResult = { code: number; out: string; err: string };

export type Stage = "check" | "test" | "fmt" | "pack";

export type StageResult = {
    stage: Stage;
    ok: boolean;
    rc: number;
    ms: number;
    detail: string;
    /** 子进程原始 stdout / stderr。回放还是折叠由 runGate 决定，执行器不碰 IO */
    out: string;
    err: string;
};

/** 任何「有原始输出」的东西：RunResult 与 StageResult 都能传 */
export type RawOutput = { out: string; err: string };

export type GateOptions = {
    clean: boolean;
    keepClone: boolean;
    skipTest: boolean;
    skipFmt: boolean;
    skipPack: boolean;
    /** 回放每个阶段的完整输出；默认只在失败时回放 */
    verbose: boolean;
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
    test: "bun test",
    fmt: "bun fmt",
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
            "skip-fmt": { type: "boolean", default: false },
            "skip-pack": { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });
    return {
        clean: parsed.values.clean === true,
        keepClone: parsed.values["keep-clone"] === true,
        skipTest: parsed.values["skip-test"] === true,
        skipFmt: parsed.values["skip-fmt"] === true,
        skipPack: parsed.values["skip-pack"] === true,
        verbose: parsed.values.verbose === true,
        help: parsed.values.help === true,
    };
}

/**
 * `bun check` 的摘要措辞有两种，成功与失败不同；都写在 stderr（stdout 是空的）。
 * 取文件数是为了挡住「tsconfig 的 include 写歪了所以检查了 0 个文件」这种满分答卷。
 */
export function checkedFileCount(res: RunResult): number {
    const combined = `${res.out}\n${res.err}`;
    const m = /No type errors in (\d+)\s+files?/i.exec(combined) ?? /checked\s+(\d+)\s+files?/i.exec(combined);
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

/**
 * 从 `bun test` 的输出里取测试文件数；取不到返回 0。
 *
 * 单独抓这个数是因为它是「覆盖面」的唯一可观测指标：删掉一个测试文件时
 * pass 数只掉几条，摘要里看着仍然很像正常。`Ran 256 tests across 19 files.`
 */
export function parseTestFileCount(res: RunResult): number {
    const m = /Ran \d+ tests? across (\d+) files?/i.exec(`${res.out}\n${res.err}`);
    return m?.[1] ? Number(m[1]) : 0;
}

/**
 * 从 `bun fmt --check` 的输出里取「参与格式化的文件数」。
 *
 * 成功时 stderr 是 `All 92 files are formatted.`，失败时是
 * `1 file needs formatting. Run bun fmt to fix it.` —— 两种措辞都要认。
 *
 * 取这个数不是为了好看，是为了挡住满分答卷：`.prettierignore` 写歪成 `*`
 * 之后，`bun fmt --check` 会正常退出 0 并报告「全部合规」，而它一个文件都没看。
 * 这与 `bun check` 那条「检查了 0 个文件」是同一类失败：判据自己瞎了，
 * 却报绿。取到 0 一律判失败。
 */
export function parseFmtFileCount(res: RunResult): number {
    const combined = `${res.out}\n${res.err}`;
    const ok = /All (\d+) files? (?:is|are) formatted/i.exec(combined);
    if (ok?.[1]) {
        return Number(ok[1]);
    }
    const bad = /(\d+) files? needs? formatting/i.exec(combined);
    return bad?.[1] ? Number(bad[1]) : 0;
}

/**
 * `fmt` 阶段的判定，抽成纯函数以便单测。
 *
 * 抽出来的原因是一次反向验证：把 `runFmt` 里「退出码非 0 即失败」与
 * 「取到 0 个文件即失败」这两条分别摘掉，测试全绿——因为 `runFmt` 只能
 * 通过真跑子进程来触达，而门禁的短路用例走的是假 runner。
 * 也就是说**判定逻辑当时没有任何判据守着**。这里改成纯函数后，
 * 两条防线各自有用例，摘掉哪条都会红。
 */
export function fmtVerdict(res: RunResult): { ok: boolean; detail: string } {
    const files = parseFmtFileCount(res);
    if (res.code !== 0) {
        return { ok: false, detail: `${files} file(s) need formatting` };
    }
    if (files < 1) {
        return {
            ok: false,
            detail: "退出码为 0 但没能确认检查了多少文件——.prettierignore 可能把一切都排除了",
        };
    }
    return { ok: true, detail: `${files} files` };
}

/** Bun 的测试结果行带 SGR 色码，摘取前必须剥掉，否则 startsWith 匹配不到 */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/**
 * 摘出 `(fail)` 行。
 *
 * 失败时这个函数的输出比原始日志有用得多：256 行 pass 里混着 1 行 fail，
 * 而回放会把它埋到屏幕上方。Bun 把结果行写到 stderr，所以两路都要看。
 */
export function failedCases(raw: RawOutput): string[] {
    const hits = splitLines(raw.out)
        .concat(splitLines(raw.err))
        .map((line) => line.replace(ANSI_SGR, "").trim())
        .filter((line) => line.startsWith("(fail)"))
        .map((line) => line.slice("(fail)".length).trim());

    // Bun 会把失败用例报两遍：逐条执行时一次，末尾 `N tests failed:` 段再一次。
    // 重复的聚焦行没有信息量。代价是两个完全同名的失败用例会被合并成一条——
    // 聚焦段只是路标，完整回放就在下面，这个取舍可以接受。
    return [...new Set(hits)];
}

/** 按行切分并丢掉末尾空行；内部空行保留（原始输出里的空行有分隔意义） */
export function splitLines(text: string): string[] {
    if (!text) {
        return [];
    }
    const lines = text.split(/\r?\n|\r/);
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
        lines.pop();
    }
    return lines;
}

/**
 * 折叠掉的非空行数。
 *
 * 只统计通过的阶段——失败阶段的输出是要回放的，不算「被折叠」。
 * 这个数字必须报出来：静默丢弃输出会让「门禁绿了但 C++ 编译告警呢」无从查证。
 */
export function foldedLineCount(results: readonly StageResult[]): number {
    let total = 0;
    for (const r of results) {
        if (!r.ok) {
            continue;
        }
        total += splitLines(r.out).length + splitLines(r.err).length;
    }
    return total;
}

/** 把子进程原始输出写回终端：stdout 走 stdout，stderr 走 stderr */
export function replayOutput(raw: RawOutput, io: GateIO): void {
    for (const line of splitLines(raw.out)) {
        io.log(line);
    }
    for (const line of splitLines(raw.err)) {
        io.warn(line);
    }
}

/**
 * 该跑哪些阶段。
 *
 * `--skip-test` 连带跳过消费方验收——它与 `bun test` 同属「行为层」，
 * 单独留下的价值很低，且原版就是这个语义，不在这里改。
 *
 * `fmt` 排在 `test` 之后、`pack` 之前：它约 60 ms，比 pack 便宜得多，
 * 而格式问题属于本地代码质量，应当在打包前就失败。`--skip-test` 不连带
 * 跳过它——格式与测试没有从属关系，想跳过请显式写 `--skip-fmt`。
 */
export function planStages(opts: GateOptions): Stage[] {
    const stages: Stage[] = ["check"];
    if (!opts.skipTest) {
        stages.push("test");
    }
    if (!opts.skipFmt) {
        stages.push("fmt");
    }
    if (!opts.skipTest && !opts.skipPack) {
        stages.push("pack");
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
export async function runGate(workDir: string, opts: GateOptions, deps: GateDeps): Promise<boolean> {
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
            reportFailure(result, deps.io);
            for (const line of summarize(results)) {
                deps.io.log(line);
            }
            return false;
        }

        // 通过时只留结论行；--verbose 才照单全收
        if (opts.verbose) {
            replayOutput(result, deps.io);
        }
    }

    // 被跳过的阶段要留痕，否则「门禁通过」这句话的覆盖面是模糊的
    if (opts.skipTest) {
        deps.io.log("bun test skipped (--skip-test)");
    }
    if (opts.skipFmt) {
        deps.io.log("bun fmt skipped (--skip-fmt)");
    }
    if (!opts.skipTest && opts.skipPack) {
        deps.io.log("pack verification skipped (--skip-pack)");
    }

    // 折叠是默认行为，但折叠本身必须可见：静默吞输出会把「有告警」变成「看不见」
    const folded = foldedLineCount(results);
    if (!opts.verbose && folded > 1) {
        deps.io.log("");
        deps.io.log(`[output folded: ${folded} lines — rerun with --verbose to replay]`);
    }

    for (const line of summarize(results)) {
        deps.io.log(line);
    }
    return true;
}

/**
 * 失败时的输出顺序：结论行已在调用处打过 → 先 `(fail)` 聚焦 → 再完整回放。
 * 反过来做的话，失败点会被几百行 pass 顶到屏幕上方，等于没报。
 */
function reportFailure(result: StageResult, io: GateIO): void {
    const cases = failedCases(result);
    if (cases.length > 0) {
        io.log("");
        io.log(`--- failed cases (${cases.length}) ---`);
        for (const c of cases) {
            io.log(`  ${c}`);
        }
    }
    io.log("");
    io.log(`--- ${LABELS[result.stage]} output ---`);
    replayOutput(result, io);
}

// ---- 真实执行器 -------------------------------------------------------------

async function spawn(argv: readonly string[], cwd: string): Promise<RunResult> {
    const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, out, err };
}

const BUN = process.execPath;

async function runCheck(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "check"], cwd);
    const ms = performance.now() - started;
    const base = { stage: "check" as const, rc: res.code, ms, out: res.out, err: res.err };

    // `bun check` 在没有可检查文件时也会 exit 1（文档明文），所以退出码是主判据
    if (res.code !== 0) {
        return { ...base, ok: false, detail: "type errors" };
    }

    const files = checkedFileCount(res);
    if (files < 1) {
        return {
            ...base,
            ok: false,
            detail: "退出码为 0 但没能确认检查了多少文件——tsconfig 的 include 可能写歪了",
        };
    }
    return { ...base, ok: true, detail: `${files} files` };
}

async function runTest(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "test"], cwd);
    const ms = performance.now() - started;

    // 文件数是「覆盖面」的可观测指标：某次改动让一个测试文件整体跑不起来时，
    // pass 数只掉几条，摘要里看着仍然正常；文件数掉了才是真的掉了。
    const counts = parseTestCounts(res);
    const files = parseTestFileCount(res);
    const detail = [counts ? `${counts.pass} pass / ${counts.fail} fail` : "", files > 0 ? `${files} files` : ""]
        .filter((p) => p.length > 0)
        .join(" / ");

    return {
        stage: "test",
        ok: res.code === 0,
        rc: res.code,
        ms,
        detail,
        out: res.out,
        err: res.err,
    };
}

/**
 * 格式化检查。
 *
 * **必须带 `--no-script`。** `bun fmt --check` 在 `package.json` 有 `fmt`
 * script 时会把命令整个转交给那个 script，然后原样返回它的退出码——
 * 实测：script 里只打一行日志，`bun fmt --check` 就 exit 0 并输出那行日志。
 * 也就是说判据会静默变成「那个 script 成功了吗」，与格式无关。
 * 本仓当前没有 `fmt` script，所以不加也「碰巧」能跑；但这是一条
 * 一旦加了脚本就失效的形状，不能靠运气。
 *
 * 同理必须取文件数：`.prettierignore` 写歪成 `*` 之后，命令会正常
 * exit 0 并报告全部合规，而它一个文件都没看。
 */
async function runFmt(cwd: string): Promise<StageResult> {
    const started = performance.now();
    const res = await spawn([BUN, "fmt", "--check", "--no-script"], cwd);
    const ms = performance.now() - started;
    const base = { stage: "fmt" as const, rc: res.code, ms, out: res.out, err: res.err };

    const verdict = fmtVerdict(res);
    return { ...base, ok: verdict.ok, detail: verdict.detail };
}

async function runPack(cwd: string): Promise<StageResult> {
    const started = performance.now();
    // 直接 `bun <path>` 而不是 `bun run <path>`：`run` 子命令在某些 cwd 大小写
    // 组合下会给出 import.meta.main=false（见 scripts/lib/entrypoint.ts），
    // 虽然入口已加防护，但少绕一层更稳。
    const res = await spawn([BUN, join(cwd, "scripts", "verify-pack.ts")], cwd);
    const ms = performance.now() - started;

    return {
        stage: "pack",
        ok: res.code === 0,
        rc: res.code,
        ms,
        detail: parsePackSummary(res),
        out: res.out,
        err: res.err,
    };
}

const REAL_RUNNER: StageRunner = {
    check: runCheck,
    test: runTest,
    fmt: runFmt,
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

    // 显式声明覆盖范围的缺口。不写出来的话，`GATE PASSED (clean)` 会被读成
    // 「比工作区更严格」——而实际上它**少**了一整组断言：`AGENTS.md` 与
    // `.internal/adr/` 都不在版本控制里，干净副本没有它们，
    // `tests/agents-doc.test.ts` 的 `guard` 于是整组 `describe.skip`。
    // 连带后果容易被忽略：`文档里的脚本路径引用` 那条同时检查 `docs/pitfalls.md`
    // （版控内），也一并被跳过了，所以文档里的幽灵路径引用在 --clean 下不会被抓。
    // 数字不写死（会漂移），只声明覆盖了哪些、没覆盖哪些。
    //
    // 走 `io.log` 而不是 `io.warn`：它是**信息性声明**而非错误，且 stdout / stderr
    // 被分开收集时（工具调用、CI、重定向），warn 会让这段跑到输出的末尾去，
    // 与它要解释的那行脱节。
    for (const line of [
        "         NOTE: this run does NOT cover documentation consistency.",
        "               AGENTS.md and .internal/adr/ are not version-controlled,",
        "               so tests/agents-doc.test.ts skips its guard group here —",
        "               including the docs path-reference check, which also covers",
        "               docs/pitfalls.md. Run without --clean to exercise it.",
    ]) {
        io.log(line);
    }

    // file:// 前缀：本地路径直接 clone 时 git 会忽略 --depth 并告警
    const srcUrl = `file:///${root.replace(/\\/g, "/")}`;
    const clone = await spawn(["git", "clone", "--quiet", "--depth", "1", srcUrl, probe], root);
    if (clone.code !== 0) {
        io.warn(`git clone failed (rc=${clone.code})`);
        replayOutput(clone, io);
        return false;
    }

    try {
        io.step("bun install --frozen-lockfile");
        const install = await spawn([BUN, "install", "--frozen-lockfile"], probe);
        if (install.code !== 0) {
            io.warn(`bun install failed (rc=${install.code})`);
            replayOutput(install, io);
            return false;
        }
        if (opts.verbose) {
            replayOutput(install, io);
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
                 ⚠ 覆盖范围比工作区小：AGENTS.md 与 .internal/adr/ 不在版本控制里，
                   干净副本没有它们，tests/agents-doc.test.ts 的整组断言会 skip，
                   连带 docs/pitfalls.md 的路径引用检查也不跑。每次运行都会提示。
  --keep-clone   与 --clean 同用，保留副本供排查
  --skip-test    只跑类型检查与格式化，跳过行为测试与消费方验收
  --skip-fmt     跳过格式化检查（bun fmt --check --no-script）
  --skip-pack    跳过消费方验收（只在改门禁自身时用）
  --verbose      回放每个阶段的完整输出（默认只报结论，失败时才回放）
  -h, --help     显示本帮助`);
        return 0;
    }

    const opts: GateOptions = {
        clean: parsed.clean,
        keepClone: parsed.keepClone,
        skipTest: parsed.skipTest,
        skipFmt: parsed.skipFmt,
        skipPack: parsed.skipPack,
        verbose: parsed.verbose,
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
        CONSOLE_IO.warn(`gate: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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

// 只有直接执行时才跑；被 tests/ 导入时不产生副作用。
// 判据不能只用 import.meta.main —— 见 scripts/lib/entrypoint.ts 里的实测记录。
if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main(process.argv.slice(2), resolve(import.meta.dir, ".."));
}
