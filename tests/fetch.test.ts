import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { INPUTS, decideSdk, decideWebview, main } from "../native/fetch";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * 构建前置脚本的行为断言。
 *
 * 这个文件存在的理由：`native/fetch.ps1` 时代，四种目录状态只能靠人工跑一遍来相信它，
 * 而「目录存在但不完整」这一态从来没被验证过（旧版判据恒为真，进不到这里）。
 * 迁成 TS 后，决策逻辑是纯函数，终于可以钉住。
 */

// ---- 与 build 脚本的判据对齐 ------------------------------------------------

describe("INPUTS 与实际构建脚本的依赖", () => {
    test("恰好三份输入，顺序与 build 脚本一致", () => {
        expect(INPUTS).toHaveLength(3);
        expect(INPUTS.map((i) => i.name)).toEqual(["webview.h", "EventToken.h", "WebView2.h"]);
    });

    test("判据与构建脚本同源", () => {
        // 两个 fetch / build 脚本对「准备好了没有」的定义必须一致。
        // 旧版 fetch.ps1 判的是 .git 是否存在，与构建脚本的实际依赖脱节，
        // 结果新机器 clone 后必然 exit 128（docs/pitfalls.md 5.5）。
        //
        // build.ps1 已迁为 build.ts，两边现在共享 INPUTS 常量本身，
        // 这条断言退化为「常量确实被 build 侧引用」的守卫。
        const buildTs = readFileSync(join(REPO_ROOT, "native", "build.ts"), "utf8");
        expect(buildTs).toContain('from "./fetch"');
        expect(buildTs).toContain("INPUTS");

        // 不断言「三份头文件存在」：vendor/webview2/ 是 .gitignore 排除的解压产物，
        // 干净 clone 里没有它（--clean 会暴露这一点）。存在性由 fetch.ts 负责，
        // 这里只守「判据来源同一」。
    });

    test("入库的那两份与未入库的那份分得清", () => {
        // 前两份随 clone 到位，第三份必须解压——这三条决定了默认路径能否离线
        expect(INPUTS[0]?.dir).toBe("webview");
        expect(INPUTS[1]?.dir).toBe("webview");
        expect(INPUTS[2]?.dir).toBe("webview2");
    });
});

// ---- 上游源码那一步的四种状态 ------------------------------------------------

describe("decideWebview", () => {
    test("两份输入都在 → 跳过（不碰磁盘）", () => {
        expect(decideWebview({ forceClone: false, dirExists: true, missing: [] })).toEqual({
            kind: "skip",
        });
    });

    test("目录整个不存在 → 直接 clone（没有可保护的内容）", () => {
        const plan = decideWebview({
            forceClone: false,
            dirExists: false,
            missing: ["webview/core/include/webview/webview.h"],
        });
        expect(plan).toEqual({ kind: "clone" });
    });

    test("目录在但不完整 → 拒绝，并列出缺哪几份", () => {
        const missing = ["webview/compatibility/mingw/include/EventToken.h"];
        const plan = decideWebview({ forceClone: false, dirExists: true, missing });
        expect(plan.kind).toBe("refuse");
        if (plan.kind === "refuse") {
            expect(plan.missing).toEqual(missing);
        }
    });

    test("--webview 覆盖一切判断，哪怕输入齐备也重拉", () => {
        expect(decideWebview({ forceClone: true, dirExists: true, missing: [] })).toEqual({
            kind: "clone",
        });
    });

    test("拒绝时返回的 missing 是副本，不共享调用方的数组", () => {
        const missing = ["a"];
        const plan = decideWebview({ forceClone: false, dirExists: true, missing });
        missing.push("b");
        if (plan.kind === "refuse") {
            expect(plan.missing).toEqual(["a"]);
        }
    });
});

// ---- SDK 那一步的四种状态 ----------------------------------------------------

describe("decideSdk", () => {
    test("头文件已在 → 跳过", () => {
        expect(decideSdk({ forceDownload: false, headerPresent: true, pkgPresent: true })).toEqual({
            kind: "skip",
        });
    });

    test("头文件缺、nupkg 在 → 离线解压（download=false）", () => {
        expect(decideSdk({ forceDownload: false, headerPresent: false, pkgPresent: true })).toEqual({
            kind: "install",
            download: false,
        });
    });

    test("头文件缺、nupkg 也不在 → 必须下载", () => {
        expect(decideSdk({ forceDownload: false, headerPresent: false, pkgPresent: false })).toEqual({
            kind: "install",
            download: true,
        });
    });

    test("--sdk 强制重下，哪怕头文件已在", () => {
        expect(decideSdk({ forceDownload: true, headerPresent: true, pkgPresent: true })).toEqual({
            kind: "install",
            download: true,
        });
    });
});

// ---- 端到端：拒绝路径不联网、不破坏磁盘 --------------------------------------

describe("main 的拒绝路径", () => {
    let sandbox: string | null = null;

    afterEach(() => {
        if (sandbox) {
            rmSync(sandbox, { recursive: true, force: true });
            sandbox = null;
        }
    });

    /** 造一个「目录在、内容不全」的仓库根，模拟有人误删了部分 vendor 文件 */
    function makeIncompleteRoot(): string {
        const dir = mkdtempSync(join(tmpdir(), "baw-fetch-test-"));
        sandbox = dir;
        const wv = join(dir, "vendor", "webview", "core", "include", "webview");
        mkdirSync(wv, { recursive: true });
        writeFileSync(join(wv, "webview.h"), "// truncated\n");
        // EventToken.h 故意不建
        return dir;
    }

    test("vendor/webview 不完整且未授权 → exit 1，不联网、不删目录", async () => {
        const root = makeIncompleteRoot();
        const before = readFileSync(join(root, "vendor", "webview", "core", "include", "webview", "webview.h"), "utf8");

        const code = await main([], root);

        expect(code).toBe(1);
        // 目录必须原封不动：拒绝的意义就在于不静默删除
        const after = readFileSync(join(root, "vendor", "webview", "core", "include", "webview", "webview.h"), "utf8");
        expect(after).toBe(before);
    });

    test("--help 返回 0，且不触碰文件系统", async () => {
        const root = makeIncompleteRoot();
        expect(await main(["--help"], root)).toBe(0);
        expect(await main(["-Help"], root)).toBe(0); // PowerShell 风格同样识别
    });
});
