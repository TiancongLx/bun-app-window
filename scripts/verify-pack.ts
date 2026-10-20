/**
 * verify-pack.ts — 消费方验收门禁
 *
 * 为什么需要它：仓库内的 `bun test` 走的是「源码 + 本地 dist」这条路径，覆盖不到
 * 「作为 tarball 被第三方安装」的真实链路。`exports` 拼错、`files` 漏项、类型声明
 * 缺位，这几种故障在仓库内全绿，在 npm 上装起来就炸。
 *
 * 三件事，缺一不可：
 *   1. 内容白名单：tarball 里只允许出现发布面文件；新增文件必须显式登记，
 *      否则判据失败——「不小心把 vendor/ 又打进去」这种回归没有别的防线
 *   2. 类型可达：把 tarball 装进临时工程，`bun check` 必须零错误
 *   3. 运行时可达：同一工程里逐个解析子路径，并真的 dlopen 原生库
 *
 *     bun run scripts/verify-pack.ts            # 跑完删临时目录
 *     bun run scripts/verify-pack.ts --keep     # 保留临时目录供排查
 *
 * 退出码：0 = 全部通过，1 = 判据失败，2 = 环境问题（bun / tar 不可用等）。
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUN = process.execPath;
const KEEP = process.argv.slice(2).includes("--keep");

/** 发布面白名单：默认拒绝，未登记的文件一律失败 */
const ALLOW: ReadonlyArray<readonly [RegExp, string]> = [
    [/^package\.json$/, "包清单"],
    [/^(LICENSE|CHANGELOG\.md|README\.md|README\.zh-CN\.md|README\.zh-TW\.md)$/, "文档"],
    [/^dist\/libshell\.dll$/, "预编译原生库"],
    [/^src\/shell\/[\w.-]+\.ts$/, "内核源码与其 .d.ts"],
    [/^src\/ui\/titlebar\.ts$/, "标题栏组件"],
];

/** 必须出现在 tarball 里的文件。少一个，消费方就会在某条子路径上撞墙 */
const REQUIRED: readonly string[] = [
    "package.json",
    "LICENSE",
    "CHANGELOG.md",
    "README.md",
    "README.zh-CN.md",
    "README.zh-TW.md",
    "dist/libshell.dll",
    "src/shell/index.ts",
    "src/shell/types.ts",
    "src/shell/native.ts",
    "src/shell/native-asset.d.ts",
    "src/shell/resolve.ts",
    "src/shell/port.ts",
    "src/shell/ipc.ts",
    "src/shell/state.ts",
    "src/shell/debug.ts",
    "src/shell/embedded.ts",
    "src/shell/assets.d.ts",
    "src/ui/titlebar.ts",
];

/** 命中即给出「为什么它不该在这里」的提示，而不是只报一句 unexpected */
const NOISE_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^vendor\//, "上游源码属构建期依赖，重编需 clone 仓库"],
    [/^native\//, "原生层源码与构建脚本同上"],
    [/^tests\//, "测试不随包发布"],
    [/^scripts\//, "仓库脚本不随包发布"],
    [/^\.build\//, "编译中间产物"],
    [/^(src\/host\.ts|src\/ui\/index\.html)$/, "自检程序不属于发布包内容"],
    [/^(AGENTS\.md|\.internal\/|docs\/)/, "本地上下文不进版本控制，更不能进发布面"],
];

type Check = { name: string; ok: boolean; detail: string };

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

function hintFor(path: string): string {
    for (const [pattern, hint] of NOISE_HINTS) {
        if (pattern.test(path)) {
            return hint;
        }
    }
    return "新增发布文件需先在 ALLOW 表登记";
}

/** tar -tzf：列出归档内的普通文件（去掉包目录前缀与目录条目） */
async function listTarball(tarExe: string, tgz: string): Promise<RunResult & { files: string[] }> {
    const res = await run([tarExe, "-tzf", tgz], REPO_ROOT);
    const files = res.out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.endsWith("/"))
        .map((line) => line.replace(/^package\//, ""))
        .sort();
    return { ...res, files };
}

function checkPayload(files: readonly string[], declaredFiles: readonly string[]): Check[] {
    const checks: Check[] = [];
    const present = new Set(files);

    checks.push({
        name: "tarball 非空",
        ok: files.length > 0,
        detail: `${files.length} 个文件`,
    });

    const missing = REQUIRED.filter((f) => !present.has(f));
    checks.push({
        name: "必需文件全部在包内",
        ok: missing.length === 0,
        detail: missing.length === 0 ? `${REQUIRED.length} 项` : `缺 ${missing.join(", ")}`,
    });

    const disallowed = files.filter((f) => !ALLOW.some(([pattern]) => pattern.test(f)));
    checks.push({
        name: "无未登记的发布文件",
        ok: disallowed.length === 0,
        detail:
            disallowed.length === 0
                ? "全部命中白名单"
                : disallowed.map((f) => `${f}（${hintFor(f)}）`).join("; "),
    });

    // files 里写了却没打进包的条目，等于清单在说谎
    const unshipped = declaredFiles.filter((entry) => {
        if (entry.includes("*")) {
            return false;
        }
        if (present.has(entry)) {
            return false;
        }
        const prefix = `${entry.replace(/\/$/, "")}/`;
        return !files.some((f) => f.startsWith(prefix));
    });
    checks.push({
        name: "package.json 的 files 全部落地",
        ok: unshipped.length === 0,
        detail: unshipped.length === 0 ? `${declaredFiles.length} 项` : `未打进包：${unshipped.join(", ")}`,
    });

    return checks;
}

function checkConsumer(checkRun: RunResult, probeRun: RunResult): Check[] {
    const combined = `${checkRun.out}\n${checkRun.err}`;
    const lines = combined
        .split(/\r?\n|\r/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const errors = lines.filter((line) => line.includes("error TS"));

    // 「零错误」还不够：tsconfig 的 include 写歪了会得到「检查了 0 个文件」的满分答卷。
    // bun check 把摘要写在 stderr（标准输出是空的），两种措辞分别对应成功与失败。
    const counted =
        /checked\s+(\d+)\s+files?/i.exec(combined) ?? /No type errors in (\d+)\s+files?/i.exec(combined);
    const checkedFiles = counted?.[1] ? Number(counted[1]) : 0;

    return [
        {
            name: "消费方 bun check 零错误",
            ok: checkRun.code === 0 && errors.length === 0 && checkedFiles > 1,
            detail:
                checkRun.code === 0 && errors.length === 0 && checkedFiles > 1
                    ? `${checkedFiles} 个文件（含包内源码与探针）`
                    : checkedFiles <= 1
                      ? `只检查了 ${checkedFiles} 个文件，探针可能没被纳入`
                      : errors.slice(0, 5).join(" | "),
        },
        {
            name: "消费方运行时探针通过",
            ok: probeRun.code === 0,
            detail:
                probeRun.code === 0
                    ? (`${probeRun.out}`.split(/\r?\n|\r/).map((l) => l.trim()).filter((l) => l).pop() ?? "")
                    : `${probeRun.out}\n${probeRun.err}`
                          .split(/\r?\n|\r/)
                          .map((l) => l.trim())
                          .filter((l) => l)
                          .slice(-5)
                          .join(" | "),
        },
    ];
}

function printReport(checks: readonly Check[]): void {
    const width = checks.reduce((w, c) => Math.max(w, c.name.length), 0);
    for (const c of checks) {
        const mark = c.ok ? "ok  " : "FAIL";
        const tail = c.detail ? `  ${c.detail}` : "";
        console.log(`  ${mark} ${c.name.padEnd(width)}${tail}`);
    }
}

function fatal(message: string): never {
    console.error(`verify-pack: ${message}`);
    process.exit(2);
}

async function main(): Promise<void> {
    const tarExe = Bun.which("tar");
    if (!tarExe) {
        fatal("tar not found on PATH (needed to inspect the tarball)");
    }

    const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as {
        version?: string;
        files?: string[];
    };
    const declaredFiles = pkg.files ?? [];
    const version = pkg.version ?? "0.0.0";

    const workspace = await mkdtemp(join(tmpdir(), "baw-pack-"));
    const packDir = join(workspace, "pack");
    const consumerDir = join(workspace, "consumer");
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });

    try {
        // ---- 1. 打包 ---------------------------------------------------------
        const packStart = performance.now();
        const pack = await run(
            [BUN, "pm", "pack", "--destination", packDir, "--quiet"],
            REPO_ROOT,
        );
        const packMs = performance.now() - packStart;
        if (pack.code !== 0) {
            fatal(`bun pm pack failed (rc=${pack.code}): ${pack.err.trim() || pack.out.trim()}`);
        }

        const tgzName = (await readdir(packDir)).find((name) => name.endsWith(".tgz"));
        if (!tgzName) {
            fatal(`no tarball produced in ${packDir}`);
        }
        const tgz = join(packDir, tgzName);

        const listing = await listTarball(tarExe, tgz);
        if (listing.code !== 0) {
            fatal(`tar failed (rc=${listing.code}): ${listing.err.trim()}`);
        }

        const checks: Check[] = checkPayload(listing.files, declaredFiles);

        console.log("");
        console.log(
            `tarball: ${tgzName} (bun-app-window@${version}, ${listing.files.length} files, packed ${packMs.toFixed(0)}ms)`,
        );

        // ---- 2. 装进临时消费方工程 -------------------------------------------
        await writeFile(
            join(consumerDir, "package.json"),
            `${JSON.stringify({ name: "baw-consumer-probe", private: true, type: "module" }, null, 4)}\n`,
            "utf8",
        );

        const addStart = performance.now();
        const add = await run([BUN, "add", tgz], consumerDir);
        const addMs = performance.now() - addStart;
        if (add.code !== 0) {
            checks.push({
                name: "从 tarball 安装成功",
                ok: false,
                detail: `${add.out}\n${add.err}`.trim().split(/\r?\n/).slice(-5).join(" | "),
            });
            printReport(checks);
            console.log("");
            console.log("VERIFY-PACK FAILED");
            process.exit(1);
        }
        checks.push({ name: "从 tarball 安装成功", ok: true, detail: `${addMs.toFixed(0)}ms` });

        // 类型根指向本仓库的 node_modules：判据要能离线跑，
        // 而「消费方需自行安装 @types/bun」这件事由 README 承诺，不在这里重复验证
        const typeRoots = join(REPO_ROOT, "node_modules", "@types").replace(/\\/g, "/");
        await writeFile(
            join(consumerDir, "tsconfig.json"),
            `${JSON.stringify(
                {
                    compilerOptions: {
                        lib: ["ESNext"],
                        target: "ESNext",
                        module: "Preserve",
                        moduleResolution: "bundler",
                        types: ["bun"],
                        typeRoots: [typeRoots],
                        strict: true,
                        skipLibCheck: true,
                        noEmit: true,
                        resolveJsonModule: true,
                    },
                    include: ["probe.ts"],
                },
                null,
                4,
            )}\n`,
            "utf8",
        );

        const probeSource = await Bun.file(join(REPO_ROOT, "scripts", "consumer-probe.ts")).text();
        await writeFile(join(consumerDir, "probe.ts"), probeSource, "utf8");

        // ---- 3. 消费方类型检查 -----------------------------------------------
        const checkStart = performance.now();
        const checkRun = await run([BUN, "check"], consumerDir);
        const checkMs = performance.now() - checkStart;

        // ---- 4. 消费方运行时探针 ---------------------------------------------
        const probeStart = performance.now();
        const probeRun = await run(
            [BUN, "probe.ts", "--expect-source", "package"],
            consumerDir,
        );
        const probeMs = performance.now() - probeStart;

        checks.push(...checkConsumer(checkRun, probeRun));

        console.log("");
        printReport(checks);

        console.log("");
        console.log(
            `timing: pack ${packMs.toFixed(0)}ms · add ${addMs.toFixed(0)}ms · ` +
                `check ${checkMs.toFixed(0)}ms · probe ${probeMs.toFixed(0)}ms`,
        );

        const failed = checks.filter((c) => !c.ok);
        console.log("");
        if (failed.length > 0) {
            console.log(`VERIFY-PACK FAILED (${failed.length}/${checks.length})`);
            if (KEEP) {
                console.log(`workspace kept at: ${workspace}`);
                process.exit(1);
            }
            process.exit(1);
        }
        console.log(`VERIFY-PACK PASSED (${checks.length} checks)`);
    } finally {
        if (KEEP) {
            console.log(`workspace kept at: ${workspace}`);
        } else {
            await rm(workspace, { recursive: true, force: true }).catch(() => {});
        }
    }
}

await main();
