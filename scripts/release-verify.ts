#!/usr/bin/env bun
/**
 * release-verify.ts — 跨载体的原子性核验
 *
 * ## 为什么它和 `release-sentinel.ts` 是两个脚本
 *
 * 哨兵管**本地**：六个载体是不是说同一件事。它跑在 `push` 之前，那时远端还没有
 * 任何东西可查。本脚本管**跨载体**：git 提交、GitHub tag+release、npm tarball
 * 三者是不是指向同一个源。这需要网络，也只能在远端已有东西之后跑。
 *
 * ## 为什么必须跑两次
 *
 * 一次发版写三个载体，成本完全不同：
 *
 * | 步骤 | 可逆性 | 半失败时的状态 |
 * | --- | --- | --- |
 * | `git push` | 可回退（force push） | 远端有提交、无 tag |
 * | `git push origin <tag>` | 可回退（删 tag） | 有 tag、无 release |
 * | `gh release create` | 可回退（删 release） | GitHub 完整、npm 无版本 |
 * | `bun publish` | **不可回退**（版本号永久占用） | npm 有版本、GitHub 可能缺记录 |
 *
 * 前三步半失败都能无损修好；第四步不能。所以核验必须在第四步**两侧**各跑一次：
 *
 * - `--pre-publish`：此时 GitHub 侧应当已完整落地、npm 侧应当完全没有。全绿才
 *   授权 `bun publish`——这条闸门就是「不可逆操作必须由可逆步骤的完成来授权」。
 * - 无参数：此时 npm 侧应当已落地，且**字节必须与 tag 的树一致**。
 *
 * ## 核心判据只有一条
 *
 * `tag → git archive → bun pm pack → sha1` 与 npm 上下载到的 tarball 字节比对。
 * 这一条成立，则包内每一份 README、DLL、CHANGELOG 全都一致——**不需要任何语义
 * 检查**。这是本仓库把「原子性」变成可判定命题的方式：不逐项核对内容，只核对
 * 字节是不是同一份。
 *
 * 该判据成立的前提是 `bun pm pack` 确定性打包（同一棵树得到同一份字节），已实测
 * 成立：从 `v0.7.0` 的树重新打包，得到的 sha1 与 npm 上已发布的完全相同。
 *
 * ## 用法
 *
 * ```powershell
 * bun run scripts/release-verify.ts --pre-publish        # publish 之前：GitHub 已落地、npm 未占用
 * bun run scripts/release-verify.ts                     # publish 之后：npm 字节 == tag 树字节
 * bun run scripts/release-verify.ts --version 0.7.0     # 复核历史版本（默认取 package.json）
 * ```
 *
 * ## 退出码
 *
 * 0 = 通过；1 = 有阻塞项；2 = 环境问题（git / gh / registry / 打包失败）
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createRunner, type Check } from "./lib/check-runner";
import { isEntrypoint } from "./lib/entrypoint";

const ROOT = resolve(import.meta.dir, "..");
const REGISTRY = "https://registry.npmjs.org";

// ---- 参数 -------------------------------------------------------------------

function flagValue(name: string): string | null {
    const i = process.argv.indexOf(name);
    return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const PKG = (await Bun.file(join(ROOT, "package.json")).json()) as { name: string; version: string };
const PKG_NAME = PKG.name;
const VERSION = flagValue("--version") ?? PKG.version;
const TAG = `v${VERSION}`;
const PRE_PUBLISH = process.argv.includes("--pre-publish");

// ---- 外部命令封装 -------------------------------------------------------------

function git(args: string[]): { code: number; out: string; err: string } {
    const r = Bun.spawnSync(["git.exe", "-C", ROOT, ...args]);
    return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/**
 * 从 `origin` 的 URL 推断 `owner/repo`。
 *
 * 不硬编码：仓库改名或换托管时，硬编码的那个字符串会静默指向旧位置，而
 * `gh release view` 在别处查到的东西看起来完全正常。
 */
function ownerRepo(): string | null {
    const r = git(["remote", "get-url", "origin"]);
    if (r.code !== 0) return null;
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(r.out)?.[1] ?? null;
}

type GhRelease = { tagName?: string; isDraft?: boolean; isPrerelease?: boolean };

function ghRelease(tag: string): { ok: true; rel: GhRelease } | { ok: false; error: string } {
    const repo = ownerRepo();
    const args = ["gh.exe", "release", "view", tag, "--json", "tagName,isDraft,isPrerelease"];
    if (repo !== null) args.push("--repo", repo);
    const r = Bun.spawnSync(args, { cwd: ROOT });
    if (r.exitCode !== 0) {
        return { ok: false, error: r.stderr.toString().trim() || `gh 退出码 ${r.exitCode}` };
    }
    try {
        return { ok: true, rel: JSON.parse(r.stdout.toString()) as GhRelease };
    } catch {
        return { ok: false, error: `gh 输出不是 JSON：${r.stdout.toString().slice(0, 160)}` };
    }
}

// ---- 从 tag 复现字节 ----------------------------------------------------------

type PackedTree = { sha1: string; bytes: number; files: number };

/**
 * `git archive <tag>` → 解树 → `bun pm pack` → sha1。
 *
 * 刻意**不看工作区**：核验的是「这个 tag 的树打出来的字节」，与本地此刻改了什么
 * 无关。发版后继续开发是常态，若判据依赖工作区干净，这条核验就只能发版当天用一次。
 */
async function packFromTag(tag: string): Promise<{ ok: true; tree: PackedTree } | { ok: false; error: string }> {
    const work = join(tmpdir(), `baw-verify-${Date.now()}`);
    const src = join(work, "src");
    const out = join(work, "out");
    try {
        const mk = Bun.spawnSync(["mkdir.exe", "-p", src, out]);
        if (mk.exitCode !== 0) return { ok: false, error: `mkdir 失败：${mk.stderr.toString()}` };

        const tarPath = join(work, "tree.tar");
        const ar = Bun.spawnSync(["git.exe", "-C", ROOT, "archive", "--format=tar", "-o", tarPath, tag]);
        if (ar.exitCode !== 0) return { ok: false, error: `git archive ${tag} 失败：${ar.stderr.toString()}` };

        const ex = Bun.spawnSync(["tar.exe", "-xf", tarPath, "-C", src]);
        if (ex.exitCode !== 0) return { ok: false, error: `解树失败：${ex.stderr.toString()}` };

        const pk = Bun.spawnSync(["bun.exe", "pm", "pack", "--destination", out], { cwd: src });
        const pkOut = pk.stdout.toString() + pk.stderr.toString();
        if (pk.exitCode !== 0) return { ok: false, error: `bun pm pack 失败：${pkOut}` };

        const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
        if (!tgz) return { ok: false, error: `没产出 tgz：${pkOut}` };

        const bytes = readFileSync(join(out, tgz));
        return {
            ok: true,
            tree: {
                sha1: createHash("sha1").update(bytes).digest("hex"),
                bytes: bytes.length,
                files: Number(/Total files:\s*(\d+)/.exec(pkOut)?.[1] ?? 0),
            },
        };
    } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
    }
}

// ---- registry ---------------------------------------------------------------

type NpmDist = { shasum?: string; integrity?: string; tarball?: string };
type NpmMeta = {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, { dist?: NpmDist }>;
};

async function npmMeta(): Promise<{ ok: true; meta: NpmMeta } | { ok: false; error: string }> {
    try {
        const r = await fetch(`${REGISTRY}/${PKG_NAME}`);
        if (!r.ok) return { ok: false, error: `registry ${r.status}` };
        return { ok: true, meta: (await r.json()) as NpmMeta };
    } catch (err) {
        return { ok: false, error: `请求失败：${err instanceof Error ? err.message : String(err)}` };
    }
}

/** 下载只做一次：`npm-bytes` 与 `npm-metadata` 判的是同一份字节。 */
let tarballCache: { ok: true; buf: Buffer } | { ok: false; error: string } | undefined;

async function downloadTarball(url: string): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
    if (tarballCache !== undefined) return tarballCache;
    try {
        const r = await fetch(url);
        if (!r.ok) return (tarballCache = { ok: false, error: `下载 tarball ${r.status}` });
        return (tarballCache = { ok: true, buf: Buffer.from(await r.arrayBuffer()) });
    } catch (err) {
        return (tarballCache = { ok: false, error: `下载失败：${err instanceof Error ? err.message : String(err)}` });
    }
}

const sha1Of = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");
const sha512Of = (buf: Buffer) => "sha512-" + createHash("sha512").update(buf).digest("base64");

// ---- 检查清单 ---------------------------------------------------------------

const runner = createRunner();
const checks: Check[] = [];

/**
 * 共用判据：GitHub Release 已落地。
 *
 * 两阶段都要——`--pre-publish` 时它是「可以授权 publish」的前提，之后它是
 * 「当初那条授权是真的」的证据。
 */
checks.push({
    id: "release-live",
    title: "GitHub Release 已发布",
    run: () => {
        const r = ghRelease(TAG);
        if (!r.ok) return { ok: false, detail: r.error };
        const { tagName, isDraft, isPrerelease } = r.rel;
        const bad: string[] = [];
        if (tagName !== TAG) bad.push(`tagName=${tagName}（期望 ${TAG}）`);
        if (isDraft) bad.push("仍是草稿");
        if (bad.length > 0) return { ok: false, detail: bad.join(" · ") };
        return { ok: true, detail: `${TAG} 已发布${isPrerelease ? "（预发布）" : ""}` };
    },
});

if (PRE_PUBLISH) {
    checks.push({
        id: "head-is-remote",
        title: "HEAD 已推送到 origin/main",
        run: () => {
            const head = git(["rev-parse", "HEAD"]);
            // 不 fetch：push 会在本地更新 remote-tracking ref，而这条判据紧跟 push 之后跑
            const remote = git(["rev-parse", "origin/main"]);
            if (head.code !== 0 || remote.code !== 0) return { ok: false, detail: "读不到 HEAD 或 origin/main" };
            const ok = head.out === remote.out;
            return {
                ok,
                detail: ok
                    ? head.out.slice(0, 7)
                    : `HEAD ${head.out.slice(0, 7)} ≠ origin/main ${remote.out.slice(0, 7)} —— 先 push`,
            };
        },
    });

    checks.push({
        id: "tag-annotated",
        title: "发版 tag 存在且是附注标签",
        run: () => {
            const t = git(["cat-file", "-t", TAG]);
            if (t.code !== 0) return { ok: false, detail: `${TAG} 不存在 —— 先 git tag -a` };
            if (t.out !== "tag") {
                return { ok: false, detail: `${TAG} 是轻量标签（对象类型 ${t.out}）—— 发版必须用附注标签` };
            }
            return { ok: true, detail: `${TAG} 是附注标签` };
        },
    });

    checks.push({
        id: "tag-is-head",
        title: "tag 指向当前 HEAD",
        run: () => {
            const target = git(["rev-parse", `${TAG}^{commit}`]);
            const head = git(["rev-parse", "HEAD"]);
            if (target.code !== 0 || head.code !== 0) return { ok: false, detail: `读不到 ${TAG} 或 HEAD` };
            const ok = target.out === head.out;
            return {
                ok,
                detail: ok
                    ? `${target.out.slice(0, 7)} 与 HEAD 一致`
                    : `tag ${target.out.slice(0, 7)} ≠ HEAD ${head.out.slice(0, 7)} —— 打在了别的提交上`,
            };
        },
    });

    checks.push({
        id: "npm-unoccupied",
        title: "npm 上本版本号尚未占用",
        run: async () => {
            try {
                const r = await fetch(`${REGISTRY}/${PKG_NAME}/${VERSION}`);
                if (r.status === 404) return { ok: true, detail: `${VERSION} 未占用` };
                if (r.ok) return { ok: false, detail: `${VERSION} 已存在于 registry —— 版本号不可复用，换一版` };
                return { ok: false, detail: `registry 返回 ${r.status}，无法判定` };
            } catch (err) {
                return { ok: false, detail: `请求失败：${err instanceof Error ? err.message : String(err)}` };
            }
        },
    });
} else {
    checks.push({
        id: "tag-on-main",
        title: "tag 在 origin/main 上可达",
        run: () => {
            const r = git(["merge-base", "--is-ancestor", TAG, "origin/main"]);
            if (r.code === 0) return { ok: true, detail: `${TAG} 是 origin/main 的祖先` };
            if (r.code === 1) return { ok: false, detail: `${TAG} 不在 origin/main 上 —— 发版提交没推上去` };
            return { ok: false, detail: `git merge-base 失败：${r.err}` };
        },
    });

    checks.push({
        id: "npm-latest",
        title: "npm dist-tags.latest 指向本版",
        run: async () => {
            const r = await npmMeta();
            if (!r.ok) return { ok: false, detail: r.error };
            const latest = r.meta["dist-tags"]?.latest ?? "(无)";
            const ok = latest === VERSION;
            return {
                ok,
                detail: ok ? `latest = ${VERSION}` : `latest = ${latest}，期望 ${VERSION}（registry 可见性有数分钟延迟）`,
            };
        },
    });

    checks.push({
        id: "npm-bytes",
        title: "npm 字节 == tag 树的打包字节",
        run: async () => {
            const meta = await npmMeta();
            if (!meta.ok) return { ok: false, detail: meta.error };
            const dist = meta.meta.versions?.[VERSION]?.dist;
            if (!dist?.tarball) return { ok: false, detail: `registry 上没有 ${VERSION} 的 tarball` };

            const local = await packFromTag(TAG);
            if (!local.ok) return { ok: false, detail: local.error };

            const dl = await downloadTarball(dist.tarball);
            if (!dl.ok) return { ok: false, detail: dl.error };

            const remoteSha1 = sha1Of(dl.buf);
            const ok = remoteSha1 === local.tree.sha1;
            return {
                ok,
                detail: ok
                    ? `${remoteSha1.slice(0, 12)}（${local.tree.files} files / ${local.tree.bytes} B）—— 字节完全一致`
                    : `npm ${remoteSha1.slice(0, 12)} ≠ tag 树 ${local.tree.sha1.slice(0, 12)} —— 发布的内容不是这个提交的内容`,
            };
        },
    });

    checks.push({
        id: "npm-metadata",
        title: "registry 元数据与下载字节自洽",
        run: async () => {
            const meta = await npmMeta();
            if (!meta.ok) return { ok: false, detail: meta.error };
            const dist = meta.meta.versions?.[VERSION]?.dist;
            if (!dist?.tarball) return { ok: false, detail: `registry 上没有 ${VERSION} 的 tarball` };

            const dl = await downloadTarball(dist.tarball);
            if (!dl.ok) return { ok: false, detail: dl.error };

            const bad: string[] = [];
            const actualSha1 = sha1Of(dl.buf);
            const actualIntegrity = sha512Of(dl.buf);
            if (dist.shasum !== actualSha1) bad.push(`shasum 记 ${dist.shasum?.slice(0, 12)} 实为 ${actualSha1.slice(0, 12)}`);
            if (dist.integrity !== actualIntegrity) bad.push("integrity 与字节不符");
            return {
                ok: bad.length === 0,
                detail: bad.length === 0 ? `shasum 与 integrity 都对得上` : bad.join(" · "),
            };
        },
    });
}

// ---- 主流程 -----------------------------------------------------------------

async function main(): Promise<number> {
    const stage = PRE_PUBLISH ? "pre-publish（publish 之前的闸门）" : "post-publish（发布后核验）";
    const intent = PRE_PUBLISH ? "GitHub 侧已落地 + npm 未被占用" : "三载体指向同一个源";
    console.log(`release verify — ${PKG_NAME}@${VERSION}  ·  ${stage}`);
    console.log(`判据：${intent}`);
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
        console.log(PRE_PUBLISH ? "VERIFY BLOCKED — 不要 bun publish" : "VERIFY BLOCKED — 发布状态与 tag 不一致");
        return 1;
    }

    console.log("");
    if (PRE_PUBLISH) {
        console.log("VERIFY CLEAR — GitHub 侧已落地、npm 未占用，可以 bun publish");
    } else {
        console.log("VERIFY CLEAR — git / GitHub / npm 三者指向同一个源");
    }
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    process.exitCode = await main();
}

export { checks };
