#!/usr/bin/env bun
/**
 * release-sentinel.ts — 发版前的**本地**一致性哨兵
 *
 * ## 它只守 `bun test` 守不了的那部分
 *
 * 一次发版要往六个载体写同一件事。其中两类**已经在每次提交时被守住了**：
 * `tests/version.test.ts` 管 `package.json` ↔ `build-pack.ts` 的两处版本号，
 * `tests/readme-contract.test.ts` 管三份 README 的结构同构、标志位/子路径覆盖、
 * 不引用发布面之外的文件、无自身版本字面量。那些判据在正常开发中不会合法地失败，
 * 所以它们的位置是门禁。
 *
 * 剩下的三类**在正常开发中会合法地失败**，因此不能进 `bun test`：
 *
 *   - **实测型**：包体积要真打包解包才知道，而 `bun test` 不该依赖打包
 *   - **git 态型**：工作区是否干净、本版 tag 是否已占用，只在发版瞬间有意义
 *   - **CHANGELOG 型**：那一版段落还没写是常态；`version.test.ts` 的注释已明确
 *     把它排除在断言之外
 *
 * 本脚本**只做这三类**，不重复实现测试已经守过的判据。两份实现必然会出现
 * 「测试说合格、哨兵说不合格」，那时人只会绕过更严的那个——而更严的那个
 * 恰好是没人维护的那个。
 *
 * ## 它不是原子性的全部
 *
 * 本脚本只管**本地**六载体一致，它回答不了「远端发生了什么」。跨载体的原子性
 * 由 `scripts/release-verify.ts` 承担：`git push` / `tag` / `gh release create`
 * 之后、`bun publish` 之前跑一次（`--pre-publish`），`bun publish` 之后再跑一次
 * （无参数）。
 *
 * 分界只有一条：`push` → `tag` → `release` 三步都可回退，`publish` 不可回退。
 * 所以不可回退那一步必须由「前三步已落地」来授权，而不是由本脚本授权。
 *
 * ## 退出码
 *
 * 0 = 本地就绪；1 = 有阻塞项；2 = 环境问题（打包失败、读不到文件）
 *
 * ## 用法
 *
 * ```powershell
 * bun run scripts/release-sentinel.ts              # 全量检查（含打包实测）
 * bun run scripts/release-sentinel.ts --no-pack    # 跳过实测（快速预检）
 * bun run scripts/release-sentinel.ts --allow-dirty # 允许工作区有未提交改动
 * ```
 *
 * **前提**：`bun test` 已绿。本脚本不替你验证 README 契约与双处版本号。
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRunner, type Check } from "./lib/check-runner";
import { isEntrypoint } from "./lib/entrypoint";
import { README_FILES, parsePackageSize, type DeclaredPackageSize } from "./lib/readme-contract";

const ROOT = resolve(import.meta.dir, "..");

// ---- 判定原语 ---------------------------------------------------------------

const runner = createRunner();

const read = (rel: string) => Bun.file(join(ROOT, rel)).text();

// ---- 载体读取 ---------------------------------------------------------------

const PKG = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
const VERSION = PKG.version;

const READMES = new Map<string, string>();
for (const name of README_FILES) {
    READMES.set(name, await read(name));
}

// ---- 实测：打包并解包 ---------------------------------------------------------

/**
 * 打包 → 解包 → 量体积。
 *
 * 为什么不复用 `verify-pack.ts`：那个脚本的职责是「装进临时工程跑运行时断言」，
 * 它不报告「解包后总计多少字节」。这里的判据恰好是后者，硬塞进去会让它的输出
 * 变成两种用途的混合体。
 *
 * 用 `bun pm pack` 而不是 `bun publish --dry-run`：后者会读凭据、打网络，
 * 而判据只关心本地字节数。
 */
async function measureTarball(): Promise<{ ok: true; size: DeclaredPackageSize } | { ok: false; error: string }> {
    const work = join(tmpdir(), `baw-sentinel-${Date.now()}`);
    const src = join(work, "src");
    const out = join(work, "out");
    try {
        const mk = Bun.spawnSync(["mkdir.exe", "-p", src, out]);
        if (mk.exitCode !== 0) return { ok: false, error: `mkdir 失败：${mk.stderr.toString()}` };

        const pack = Bun.spawnSync(["bun.exe", "pm", "pack", "--destination", out], { cwd: ROOT });
        const packOut = pack.stdout.toString() + pack.stderr.toString();
        if (pack.exitCode !== 0) return { ok: false, error: `bun pm pack 失败：${packOut}` };
        const tgzName = /bun-app-window-[\d.]+\.tgz/.exec(packOut)?.[0];
        if (!tgzName) return { ok: false, error: `没找到产出的 tgz：${packOut}` };

        const tgzPath = join(out, tgzName);
        const tgzSize = (await Bun.file(tgzPath).size) ?? 0;

        const untar = Bun.spawnSync(["tar.exe", "-xzf", tgzPath, "-C", src]);
        if (untar.exitCode !== 0) return { ok: false, error: `解包失败：${untar.stderr.toString()}` };

        const root = join(src, "package");
        let files = 0;
        let total = 0;
        const glob = new Bun.Glob("**/*");
        for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
            total += (await Bun.file(join(root, rel)).size) ?? 0;
            files += 1;
        }

        return {
            ok: true,
            size: {
                files,
                packedMB: Number((tgzSize / 1_000_000).toFixed(2)),
                unpackedMB: Number((total / 1_000_000).toFixed(2)),
            },
        };
    } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
    }
}

// ---- 检查清单 ---------------------------------------------------------------

const opts = {
    noPack: process.argv.includes("--no-pack"),
    allowDirty: process.argv.includes("--allow-dirty"),
};

/**
 * 打包实测只做一次，且**推迟到真的需要时**。
 *
 * 不用模块顶层 await：那样任何 `import` 本文件的行为（测试、`--only` 查单条）
 * 都会付一次打包的代价。用闭包缓存，代价与调用次数对齐。
 */
let measured: Awaited<ReturnType<typeof measureTarball>> | null | undefined;
async function getMeasured(): Promise<Awaited<ReturnType<typeof measureTarball>> | null> {
    if (measured === undefined) {
        measured = opts.noPack ? null : await measureTarball();
    }
    return measured;
}

const checks: Check[] = [];

checks.push({
    id: "changelog-section",
    title: "CHANGELOG 有本版段落",
    run: async () => {
        const text = await read("CHANGELOG.md");
        const heading = `## [${VERSION}]`;
        const ok = text.includes(heading);
        return {
            ok,
            detail: ok ? `找到 ${heading}` : `缺少 ${heading} —— 发版前手工补一段（脚本不代写叙述）`,
        };
    },
});

checks.push({
    id: "changelog-link",
    title: "CHANGELOG 链接定义完整",
    run: async () => {
        const text = await read("CHANGELOG.md");
        const missing: string[] = [];
        if (!text.includes(`[${VERSION}]:`)) missing.push(`[${VERSION}]:`);
        // Unreleased 必须指向当前版本的 compare，否则「相对上一版改了什么」永远指着旧版
        const unreleased = /^\[Unreleased\]:\s*(\S+)$/m.exec(text)?.[1] ?? "";
        const wantUnreleased = `compare/v${VERSION}...HEAD`;
        const unreleasedOk = unreleased.includes(wantUnreleased);
        if (!unreleasedOk) missing.push(`[Unreleased] → ${wantUnreleased}`);
        return {
            ok: missing.length === 0,
            detail: missing.length === 0 ? `[${VERSION}]: 与 [Unreleased]: 都对` : `需补/改：${missing.join(" · ")}`,
        };
    },
});

checks.push({
    id: "unreleased-empty",
    title: "CHANGELOG 的 Unreleased 段已清空",
    run: async () => {
        const text = await read("CHANGELOG.md");
        const m = /## \[Unreleased\]\r?\n([\s\S]*?)(?=\r?\n## \[)/.exec(text);
        if (!m) return { ok: false, detail: "找不到 `## [Unreleased]` 段" };
        const body = (m[1] ?? "").trim();
        return {
            ok: body === "",
            detail: body === "" ? "空" : `还有 ${body.split(/\r?\n/).filter(Boolean).length} 行未归档内容`,
        };
    },
});

checks.push({
    id: "git-clean",
    title: "工作区没有未提交改动",
    run: () => {
        if (opts.allowDirty) return { ok: true, detail: "(--allow-dirty 跳过)" };
        const st = Bun.spawnSync(["git.exe", "-C", ROOT, "status", "--porcelain", "-s"]);
        if (st.exitCode !== 0) return { ok: false, detail: `git status 失败：${st.stderr.toString()}` };
        const dirty = st.stdout.toString().split(/\r?\n/).filter(Boolean);
        return {
            ok: dirty.length === 0,
            detail: dirty.length === 0 ? "clean" : `${dirty.length} 处未提交：${dirty.slice(0, 4).join(" | ")}`,
        };
    },
});

checks.push({
    id: "git-tag-absent",
    title: "本版 tag 尚未存在（防重复发版）",
    run: () => {
        const tag = `v${VERSION}`;
        const r = Bun.spawnSync(["git.exe", "-C", ROOT, "tag", "--list", tag]);
        if (r.exitCode !== 0) return { ok: false, detail: `git tag 失败：${r.stderr.toString()}` };
        const exists = r.stdout.toString().trim() === tag;
        return {
            ok: !exists,
            detail: exists
                ? `${tag} 已存在 —— 若确要重发，先确认 npm 上是不是同一版（版本号不可复用）`
                : `${tag} 未占用`,
        };
    },
});

/**
 * 体积声明与实测。
 *
 * 三条判据合并成一条：三份文档描述的是**同一个包**，那是同一个事实说了三遍。
 * 「三份彼此一致」已由 `tests/readme-contract.test.ts` 守住，这里补的是它结构上
 * 做不到的那半——**与真打包出来的字节比对**。
 */
checks.push({
    id: "package-size",
    title: "三份 README 的体积声明与实测一致",
    run: async () => {
        const m = await getMeasured();
        const declared = README_FILES.map((n) => ({ file: n, size: parsePackageSize(READMES.get(n) ?? "") }));

        const absent = declared.filter((x) => x.size === null).map((x) => x.file);
        if (absent.length > 0) {
            return { ok: false, detail: `${absent.join(" · ")} 找不到体积声明——被删掉也算漂移` };
        }

        if (m === null) {
            // --no-pack：降级为「三份彼此一致」，与静态测试同判据
            const first = declared[0]!.size!;
            const off = declared.filter(
                (x) =>
                    x.size!.files !== first.files ||
                    x.size!.packedMB !== first.packedMB ||
                    x.size!.unpackedMB !== first.unpackedMB,
            );
            return {
                ok: off.length === 0,
                detail:
                    off.length === 0
                        ? `${first.files} files / ${first.packedMB} MB / ${first.unpackedMB} MB（--no-pack 未与实测比对）`
                        : `三份不一致：${declared.map((x) => `${x.file}=${x.size!.unpackedMB}MB`).join(" ")}`,
            };
        }
        if (!m.ok) return { ok: false, detail: m.error };

        const real = m.size;
        const off = declared.filter(
            (x) =>
                x.size!.files !== real.files ||
                x.size!.packedMB !== real.packedMB ||
                x.size!.unpackedMB !== real.unpackedMB,
        );
        return {
            ok: off.length === 0,
            detail:
                off.length === 0
                    ? `${real.files} files / ${real.packedMB} MB packed / ${real.unpackedMB} MB unpacked`
                    : `${off.map((x) => `${x.file} 声明 ${x.size!.files}/${x.size!.packedMB}/${x.size!.unpackedMB}`).join(" · ")}` +
                      ` ≠ 实测 ${real.files}/${real.packedMB}/${real.unpackedMB}`,
        };
    },
});

// ---- 主流程 -----------------------------------------------------------------

async function main(): Promise<number> {
    console.log(`release sentinel — 目标版本 ${VERSION}`);
    console.log("前提：bun test 已绿（README 契约与双处版本号不在本脚本范围内）");
    console.log("");

    for (const check of checks) {
        await runner.run(check);
    }

    const { total, failed } = runner.summary();
    console.log("");
    console.log(`--- ${total - failed} PASS / ${failed} FAIL（共 ${total} 项）---`);

    if (failed > 0) {
        console.log("");
        console.log("阻塞项：");
        for (const r of runner.rows.filter((x) => !x.ok)) console.log(`  - ${r.title}：${r.detail}`);
        console.log("");
        console.log("SENTINEL BLOCKED — 不要 push / publish");
        return 1;
    }

    console.log("");
    console.log("SENTINEL CLEAR — 本地就绪，可以 push");
    console.log("push / tag / release 完成后、publish 之前，跑 release-verify.ts --pre-publish 再确认一次");
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main();
}

export { checks, parsePackageSize };
