import { describe, expect, test } from "bun:test";

import { checkPayload, PUBLISH_ALLOW, PUBLISH_REQUIRED } from "../scripts/verify-pack";

/**
 * 发布面白名单比对。
 *
 * `checkPayload` 守的是「什么东西允许被发出去」，而它自己此前没有任何测试——
 * 判据失效时最坏的结果是 vendor/ 与 native/ 又悄悄进包，而门禁依然全绿。
 */

/** 一份合法的 tarball 清单：`PUBLISH_REQUIRED` 全部在场 */
function validFiles(extra: readonly string[] = []): string[] {
    return [...PUBLISH_REQUIRED, ...extra].sort();
}

function names(checks: readonly { name: string }[]): string[] {
    return checks.map((c) => c.name);
}

function find(checks: readonly { name: string; ok: boolean; detail: string }[], name: string) {
    const hit = checks.find((c) => c.name === name);
    if (!hit) {
        throw new Error(`check not found: ${name}`);
    }
    return hit;
}

const DECLARED = [
    "src/shell",
    "src/ui/titlebar.ts",
    "dist/libshell.dll",
    "README.md",
    "README.zh-CN.md",
    "README.zh-TW.md",
    "CHANGELOG.md",
    "LICENSE",
];

// ---- 白名单与必需清单的一致性 ------------------------------------------------

describe("发布面清单", () => {
    test("必需清单里的每个文件都命中白名单", () => {
        // 不自洽的配置会让门禁自相矛盾：既要求它在，又不许它在
        for (const file of PUBLISH_REQUIRED) {
            const allowed = PUBLISH_ALLOW.some(([pattern]) => pattern.test(file));
            expect({ file, allowed }).toEqual({ file, allowed: true });
        }
    });

    test("白名单默认拒绝：任何未登记的路径都不命中", () => {
        const strangers = [
            "native/shell.cc",
            "vendor/webview/core/src/webview.cc",
            "scripts/gate.ts",
            "tests/fetch.test.ts",
            ".build/libshell.dll",
            "src/host.ts",
            "src/ui/index.html",
            "AGENTS.md",
            "docs/pitfalls.md",
            ".internal/adr/0012.md",
            "some/random/file.txt",
        ];
        for (const file of strangers) {
            const allowed = PUBLISH_ALLOW.some(([pattern]) => pattern.test(file));
            expect({ file, allowed }).toEqual({ file, allowed: false });
        }
    });
});

// ---- 四项判据 ---------------------------------------------------------------

describe("checkPayload", () => {
    test("干净的清单：四项全过", () => {
        const checks = checkPayload(validFiles(), DECLARED);
        expect(names(checks)).toEqual([
            "tarball 非空",
            "必需文件全部在包内",
            "无未登记的发布文件",
            "package.json 的 files 全部落地",
        ]);
        expect(checks.every((c) => c.ok)).toBe(true);
    });

    test("空 tarball → 第一项失败", () => {
        const checks = checkPayload([], DECLARED);
        expect(find(checks, "tarball 非空").ok).toBe(false);
        // 空清单下面三项也必然失败，但第一项是主判据
        expect(find(checks, "必需文件全部在包内").ok).toBe(false);
    });

    test("缺一个必需文件 → 第二项失败，并指出缺哪个", () => {
        const files = validFiles().filter((f) => f !== "dist/libshell.dll");
        const check = find(checkPayload(files, DECLARED), "必需文件全部在包内");
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("dist/libshell.dll");
    });

    test("混入 vendor/ → 第三项失败，并给出「为什么」", () => {
        const files = validFiles(["vendor/webview/core/src/webview.cc"]);
        const check = find(checkPayload(files, DECLARED), "无未登记的发布文件");
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("vendor/webview/core/src/webview.cc");
        // 只报「unexpected」没有信息量，必须说明它为什么不该在包里
        expect(check.detail).toContain("构建期依赖");
    });

    test("混入 native/ → 第三项失败并且提示可辨", () => {
        const check = find(checkPayload(validFiles(["native/shell.cc"]), DECLARED), "无未登记的发布文件");
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("原生层源码");
    });

    test("混入未登记的陌生文件 → 提示「需先登记」", () => {
        const check = find(checkPayload(validFiles(["mystery.bin"]), DECLARED), "无未登记的发布文件");
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("需先在 ALLOW 表登记");
    });

    test("多个违规文件全部列出，不是只报第一个", () => {
        const check = find(
            checkPayload(validFiles(["native/shell.cc", "tests/x.test.ts"]), DECLARED),
            "无未登记的发布文件",
        );
        expect(check.detail).toContain("native/shell.cc");
        expect(check.detail).toContain("tests/x.test.ts");
    });

    test("files 里写了却没打进包 → 第四项失败（清单在说谎）", () => {
        const declared = [...DECLARED, "nonexistent/thing"];
        const check = find(checkPayload(validFiles(), declared), "package.json 的 files 全部落地");
        expect(check.ok).toBe(false);
        expect(check.detail).toContain("nonexistent/thing");
    });

    test("目录型条目：只要包内有该前缀下的文件就算落地", () => {
        // package.json 里写的是 `src/shell`（目录），tarball 里必须是具体文件
        const check = find(checkPayload(validFiles(), DECLARED), "package.json 的 files 全部落地");
        expect(check.ok).toBe(true);
    });

    test("通配符条目不参与落地判定", () => {
        const declared = [...DECLARED, "*.md"];
        const check = find(checkPayload(validFiles(), declared), "package.json 的 files 全部落地");
        expect(check.ok).toBe(true);
    });
});

// ---- 与真实 package.json 的一致性 -------------------------------------------

describe("仓库当前的发布面", () => {
    test("真实 files 清单能通过全部四项判据", async () => {
        // 用 tarball 的真实形状（REQUIRED 全集）配真实 package.json 的 files，
        // 任何一边漂移这条就会红
        const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
            files?: string[];
        };
        const checks = checkPayload(validFiles(), pkg.files ?? []);
        const failed = checks.filter((c) => !c.ok);
        expect(failed).toEqual([]);
    });
});
