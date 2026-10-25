#!/usr/bin/env bun
/**
 * release-sentinel.ts — 发版原子性哨兵
 *
 * ## 它要解决的问题
 *
 * 一次发版要往**六个载体**写同一件事：`package.json` 的 version、`build-pack.ts` 的
 * PE 版本、`CHANGELOG.md` 的版本段落、三份 README 的包体积。六处任何一处漏改，
 * 都不会有编译错误、不会有测试失败——只会得到一个「半发布」状态。而半发布只在
 * 被人打开 npm 页面或解压 tarball 时才被发现，那时版本号已经永久占用。
 *
 * 所以这个脚本的存在意义只有一条：**在 `git push` / `bun publish` 之前，把「六个载体
 * 是否说同一件事」变成一个可判定的命题**。任一处不一致就红，并直接指出该改哪里。
 *
 * ## 与 `tests/version.test.ts` 的分工
 *
 * 那个文件守 package.json ↔ build-pack.ts 两处，每次 `bun test` 都跑。本脚本是它的
 * 超集，但**不重复实现**那两条判据的语义：它额外引入 `version.test.ts` 结构上做不到
 * 的三类检查——
 *
 *   - **实测型**：包体积要打包解包才知道，而 `bun test` 不该依赖打包
 *   - **git 态型**：工作区是否干净、tag 是否已存在，只在发版瞬间有意义
 *   - **CHANGELOG 型**：`version.test.ts` 的注释明确写了「CHANGELOG 不在断言范围」，
 *     理由是「给人读的叙述无法在提交时稳定校验」。本脚本接受这个前提但要补上：
 *     它只在**发版时**跑，那时「CHANGELOG 有没有这一版」就是可判定的事实。
 *
 * ## 为什么不做成第七个门禁阶段
 *
 * `gate.ts` 的每个阶段都要求「失败 = 代码有问题」。本脚本有两条会在日常开发中
 * 合法地失败（工作区脏、CHANGELOG 还没写这一版）——把这种判据塞进每次提交都跑的
 * 门禁，只会育人「看到红就 `--skip`」。它的正确位置是发版流程里的一个**阻断步骤**。
 *
 * ## 退出码
 *
 * 0 = 可以发版；1 = 有阻塞项；2 = 环境问题（打包失败、读不到文件）
 *
 * ## 用法
 *
 * ```powershell
 * bun run scripts/release-sentinel.ts              # 全量检查（含打包实测）
 * bun run scripts/release-sentinel.ts --no-pack    # 跳过实测（快速预检）
 * bun run scripts/release-sentinel.ts --allow-dirty # 允许工作区有未提交改动
 * ```
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isEntrypoint } from "./lib/entrypoint";
import {
    README_FILES,
    forbiddenReferences,
    headingCount,
    mentionedFlags,
    declaredFlags,
    declaredBrowserUiBits,
    documentedSubpaths,
    parsePackageSize,
    selfVersionLiterals,
    type DeclaredPackageSize,
} from "./lib/readme-contract";

const ROOT = resolve(import.meta.dir, "..");

// ---- 判定原语 ---------------------------------------------------------------

type Check = {
    /** 稳定标识，`--only` 与日志按它定位 */
    id: string;
    /** 一句话结论 */
    title: string;
    run: () => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
};

const rows: Array<{ id: string; title: string; ok: boolean; detail: string }> = [];

async function runCheck(check: Check): Promise<boolean> {
    let result: { ok: boolean; detail: string };
    try {
        result = await check.run();
    } catch (err) {
        result = { ok: false, detail: `检查自身抛错：${err instanceof Error ? err.message : String(err)}` };
    }
    rows.push({ id: check.id, ...result, title: check.title });
    const mark = result.ok ? "PASS" : "FAIL";
    console.log(`${mark}  ${check.title.padEnd(38)} ${result.detail}`);
    return result.ok;
}

const read = (rel: string) => Bun.file(join(ROOT, rel)).text();

// ---- 载体读取 ---------------------------------------------------------------

const PKG = (await Bun.file(join(ROOT, "package.json")).json()) as {
    version: string;
    files: string[];
    exports: Record<string, unknown>;
    engines?: { bun?: string };
    devDependencies?: Record<string, string>;
};
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
async function measureTarball(): Promise<
    { ok: true; size: DeclaredPackageSize } | { ok: false; error: string }
> {
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

const checks: Check[] = [];

checks.push({
    id: "version-semver",
    title: "package.json version 是合法 semver",
    run: () => {
        const ok = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(VERSION);
        return { ok, detail: VERSION };
    },
});

checks.push({
    id: "version-pe",
    title: "PE 版本与 package.json 同源",
    run: async () => {
        const src = await read("native/build-pack.ts");
        let pe: string | null = null;
        for (const raw of src.split(/\r?\n/)) {
            const line = raw.trim();
            // 跳过注释：`build-pack.ts` 的文档注释里提到过这个参数名，
            // 非锚定匹配会先命中注释（`version.test.ts` 记录过这次事故）。
            if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
            const m = /["']--windows-version["']\s*,\s*["']([^"']+)["']/.exec(line);
            if (m?.[1]) {
                pe = m[1];
                break;
            }
        }
        if (pe === null) return { ok: false, detail: "build-pack.ts 里定位不到 --windows-version" };
        const parts = VERSION.split(/[.+-]/);
        const expected = `${parts[0]}.${parts[1]}.${parts[2]}.0`;
        const ok = pe === expected;
        return {
            ok,
            detail: ok ? `${pe} == ${expected}` : `pe=${pe} 期望 ${expected}（跑 bump-version.ts）`,
        };
    },
});

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

// 包体积的三条判据**不放进 checks**：它们共用一次打包实测的读数，由 `main()`
// 统一处理。放进这个数组会让同一份 tarball 被 pack/unpack 三遍。

checks.push({
    id: "readme-structure",
    title: "三份 README 结构同构",
    run: () => {
        const counts = README_FILES.map((n) => ({ n, c: headingCount(READMES.get(n) ?? "") }));
        const base = counts[0]?.c ?? 0;
        const off = counts.filter((x) => x.c !== base);
        return {
            ok: off.length === 0,
            detail:
                off.length === 0
                    ? `三份均为 ${base} 个标题`
                    : `标题数不一致：${counts.map((x) => `${x.n}=${x.c}`).join(" ")}`,
        };
    },
});

checks.push({
    id: "readme-flags",
    title: "README 覆盖全部 FLAG_*",
    run: async () => {
        const types = await read("src/shell/types.ts");
        const all = declaredFlags(types);
        const missing: Record<string, string[]> = {};
        for (const name of README_FILES) {
            const mentioned = mentionedFlags(READMES.get(name) ?? "");
            const absent = all.filter((f) => !mentioned.has(f));
            if (absent.length > 0) missing[name] = absent;
        }
        const keys = Object.keys(missing);
        return {
            ok: keys.length === 0,
            detail:
                keys.length === 0
                    ? `${all.length} 个标志位三份都提到`
                    : keys.map((k) => `${k} 缺 ${missing[k]?.join(",")}`).join(" · "),
        };
    },
});

checks.push({
    id: "readme-browser-ui",
    title: "README 覆盖全部 BROWSER_UI_* 位",
    run: async () => {
        const types = await read("src/shell/types.ts");
        const all = declaredBrowserUiBits(types);
        const missing: string[] = [];
        for (const name of README_FILES) {
            const text = READMES.get(name) ?? "";
            for (const bit of all) if (!text.includes(bit)) missing.push(`${name}:${bit}`);
        }
        return {
            ok: missing.length === 0,
            detail: missing.length === 0 ? `${all.length} 个位三份都提到` : missing.join(" · "),
        };
    },
});

checks.push({
    id: "readme-subpaths",
    title: "README 覆盖全部 exports 子路径",
    run: () => {
        const subs = documentedSubpaths(PKG.exports);
        const missing: string[] = [];
        for (const name of README_FILES) {
            const text = READMES.get(name) ?? "";
            for (const s of subs) if (!text.includes(`bun-app-window/${s}`)) missing.push(`${name}:${s}`);
        }
        return {
            ok: missing.length === 0,
            detail: missing.length === 0 ? `${subs.length} 个子路径三份都提到` : missing.join(" · "),
        };
    },
});

checks.push({
    id: "readme-forbidden-refs",
    title: "README 不引用发布面之外的文件",
    run: () => {
        const all = README_FILES.flatMap((n) => forbiddenReferences(n, READMES.get(n) ?? ""));
        return {
            ok: all.length === 0,
            detail:
                all.length === 0
                    ? "无指向 AGENTS.md / .internal/ / docs/ 的引用"
                    : all.map((r) => `${r.file} L${r.line} → ${r.name}（${r.why}）`).join(" · "),
        };
    },
});

checks.push({
    id: "readme-self-version",
    title: "README 不含自身版本字面量",
    run: () => {
        const all = README_FILES.flatMap((n) => selfVersionLiterals(n, READMES.get(n) ?? "", VERSION));
        return {
            ok: all.length === 0,
            detail:
                all.length === 0
                    ? `没有出现 ${VERSION}`
                    : all.map((r) => `${r.file} L${r.line}`).join(" · ") + ` 出现了 ${VERSION}`,
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
        const dirty = st.stdout
            .toString()
            .split(/\r?\n/)
            .filter(Boolean);
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

// ---- 主流程 -----------------------------------------------------------------

async function main(): Promise<number> {
    console.log(`release sentinel — 目标版本 ${VERSION}`);
    console.log("");

    // 打包实测只做**一次**：三份 README 的体积判据共用同一个读数。
    // 每份各测一遍会让同一份 tarball 被 pack/unpack 三遍，而这个读数与哪份文档
    // 无关——它描述的是包本身。
    let measured: Awaited<ReturnType<typeof measureTarball>> | null = null;
    if (!opts.noPack) {
        measured = await measureTarball();
    }

    let failed = 0;
    for (const check of checks) {
        const ok = await runCheck(check);
        if (!ok) failed += 1;
    }

    for (const name of README_FILES) {
        const declared = parsePackageSize(READMES.get(name) ?? "");
        const title = `${name} 包体积与实测一致`;

        if (declared === null) {
            rows.push({ id: `readme-size-${name}`, title, ok: false, detail: "找不到体积声明——被删掉也算漂移" });
            console.log(`FAIL  ${title.padEnd(38)} 找不到体积声明——被删掉也算漂移`);
            failed += 1;
            continue;
        }
        if (measured === null) {
            const detail = `声明 ${declared.files}/${declared.packedMB}/${declared.unpackedMB}（--no-pack 未实测）`;
            rows.push({ id: `readme-size-${name}`, title, ok: true, detail });
            console.log(`PASS  ${title.padEnd(38)} ${detail}`);
            continue;
        }
        if (!measured.ok) {
            rows.push({ id: `readme-size-${name}`, title, ok: false, detail: measured.error });
            console.log(`FAIL  ${title.padEnd(38)} ${measured.error}`);
            failed += 1;
            continue;
        }

        const m = measured.size;
        const ok =
            declared.files === m.files &&
            declared.packedMB === m.packedMB &&
            declared.unpackedMB === m.unpackedMB;
        const detail = ok
            ? `${m.files} files / ${m.packedMB} MB packed / ${m.unpackedMB} MB unpacked`
            : `声明 ${declared.files} files / ${declared.packedMB} MB / ${declared.unpackedMB} MB ` +
              `≠ 实测 ${m.files} files / ${m.packedMB} MB / ${m.unpackedMB} MB`;
        rows.push({ id: `readme-size-${name}`, title, ok, detail });
        console.log(`${ok ? "PASS" : "FAIL"}  ${title.padEnd(38)} ${detail}`);
        if (!ok) failed += 1;
    }

    console.log("");
    console.log(`--- ${rows.length - failed} PASS / ${failed} FAIL（共 ${rows.length} 项）---`);

    if (failed > 0) {
        console.log("");
        console.log("阻塞项：");
        for (const r of rows.filter((x) => !x.ok)) console.log(`  - ${r.title}：${r.detail}`);
        console.log("");
        console.log("SENTINEL BLOCKED — 不要 push / publish");
        return 1;
    }

    console.log("");
    console.log("SENTINEL CLEAR — 可以继续发版");
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main();
}

export { checks, parsePackageSize };
