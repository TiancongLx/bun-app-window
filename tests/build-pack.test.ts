import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
    ASSET_PREFIXES,
    REPO_ROOT,
    WINDOWS_METADATA,
    formatMiB,
    inspectArtifact,
    main,
    packArgs,
} from "../native/build-pack";

/**
 * `native/build-pack.ts` 的判据。
 *
 * 核心策略：参数表是纯函数，直接断言「传了什么给 bun build」，不跑 90 MB 的编译。
 * 真编译由 `.ps1` 时代起就一直是手工验证的（需要桌面会话验证 GUI 行为），
 * 这里不假装覆盖它。
 */

const ROOT = "C:/repo";

const BASE = {
    root: ROOT,
    keepConsole: false,
    iconPath: `${ROOT}/assets/app.ico`,
    outfile: `${ROOT}/dist/bun-app-window.exe`,
};

// ---- 参数表 -----------------------------------------------------------------

describe("packArgs", () => {
    test("默认带 --windows-hide-console", () => {
        const { argv } = packArgs(BASE);
        expect(argv).toContain("--windows-hide-console");
    });

    test("--keep-console 时去掉 hide-console", () => {
        const { argv } = packArgs({ ...BASE, keepConsole: true });
        expect(argv).not.toContain("--windows-hide-console");
    });

    test("版本号以字面量形式出现，且与 --windows-version 相邻", () => {
        const { argv } = packArgs(BASE);
        const i = argv.indexOf("--windows-version");
        expect(i).toBeGreaterThan(-1);
        // 紧邻的下一个元素必须是四段版本号。bump-version.ts 依赖这个形状。
        expect(argv[i + 1]).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    test("图标存在时传 --windows-icon 且不告警", () => {
        const plan = packArgs(BASE);
        expect(plan.argv).toContain("--windows-icon");
        expect(plan.argv).toContain(BASE.iconPath);
        expect(plan.warning).toBeNull();
    });

    test("图标缺失时不传 --windows-icon，但给出告警", () => {
        const plan = packArgs({ ...BASE, iconPath: undefined });
        expect(plan.argv).not.toContain("--windows-icon");
        expect(plan.warning).not.toBeNull();
        expect(plan.warning).toContain("icon");
    });

    test("windows 元数据三项齐全", () => {
        const { argv } = packArgs(BASE);
        for (const key of ["--windows-title", "--windows-description", "--windows-publisher"]) {
            expect(argv).toContain(key);
        }
        expect(argv).toContain(WINDOWS_METADATA.title);
        expect(argv).toContain(WINDOWS_METADATA.description);
        expect(argv).toContain(WINDOWS_METADATA.publisher);
    });

    test("--outfile 紧跟在入口之后，且只有一组", () => {
        const { argv } = packArgs(BASE);
        const outIndices = argv.flatMap((a, i) => (a === "--outfile" ? [i] : []));
        expect(outIndices).toHaveLength(1);
        const at = outIndices[0]!;
        // --outfile 前一个元素是入口（host.ts）
        expect(argv[at - 1]?.endsWith("host.ts")).toBe(true);
        expect(argv[at + 1]).toBe(BASE.outfile);
        // 入口在 --outfile 之前：反过来 bun 会把输出路径当第二个入口
        const entryAt = argv.findIndex((a) => a.endsWith("host.ts"));
        expect(entryAt).toBeLessThan(at);
    });

    test("第一个元素是 build，不是 --compile", () => {
        const { argv } = packArgs(BASE);
        expect(argv[0]).toBe("build");
        expect(argv).toContain("--compile");
        expect(argv).toContain("--minify");
    });

    test("每个元素都是非空字符串", () => {
        for (const a of packArgs(BASE).argv) {
            expect(typeof a).toBe("string");
            expect(a.length).toBeGreaterThan(0);
        }
    });

    test("outfile 原样回传，便于调用方读产物", () => {
        expect(packArgs(BASE).outfile).toBe(BASE.outfile);
    });
});

// ---- 报告 -------------------------------------------------------------------

describe("inspectArtifact", () => {
    test("非 PE 输入：subsystem 为 null、无签名、无资源", () => {
        const report = inspectArtifact(new Uint8Array(256));
        expect(report.subsystem).toBeNull();
        expect(report.signed).toBe(false);
        expect(report.certBytes).toBe(0);
        expect(report.assets).toEqual([]);
        expect(report.size).toBe(256);
    });

    test("size 取实际字节数，不是文件系统报的大小", () => {
        expect(inspectArtifact(new Uint8Array(1234)).size).toBe(1234);
    });
});

describe("formatMiB", () => {
    test("保留一位小数", () => {
        expect(formatMiB(0)).toBe("0.0 MiB");
        expect(formatMiB(1024 * 1024)).toBe("1.0 MiB");
        expect(formatMiB(92.6 * 1024 * 1024)).toBe("92.6 MiB");
    });
});

describe("ASSET_PREFIXES", () => {
    test("覆盖 DLL 与 HTML 两类内嵌资源", () => {
        expect([...ASSET_PREFIXES]).toEqual(["libshell-", "index-"]);
    });
});

// ---- REPO_ROOT：入口路径推导 -----------------------------------------------

describe("REPO_ROOT", () => {
    /**
     * 这一组是被真事咬出来的。
     *
     * 初版入口守卫写成 `resolve(dirname(import.meta.dir), "..")`，多退了一层，
     * 于是 `bun run build:exe` 把入口解析成 `_Repositories/src/host.ts` ——
     * 而当时门禁**全绿**，因为 `main()` 的所有测试都把 root 当参数传进来，
     * 没有一条测过「入口自己算出来的 root 对不对」。
     *
     * 判据：root 必须指向「有 package.json 也有 native/」的那一层。
     */
    test("指向仓库根（含 package.json 与 native/）", () => {
        expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
        expect(existsSync(join(REPO_ROOT, "native", "build-pack.ts"))).toBe(true);
        expect(existsSync(join(REPO_ROOT, "src", "host.ts"))).toBe(true);
    });

    test("不是上一层（防止多退一个 ..）", () => {
        // 若 ROOT 错了，它会指向 _Repositories 之类：那里没有 package.json
        expect(existsSync(join(REPO_ROOT, "..", "package.json"))).toBe(false);
    });

    test("用 REPO_ROOT 拼出的入口路径真实存在", () => {
        const entry = join(REPO_ROOT, "src", "host.ts");
        expect(existsSync(entry)).toBe(true);
    });
});

// ---- 入口 -------------------------------------------------------------------

describe("main 的参数处理", () => {
    const okDeps = {
        build: async () => ({ code: 0, out: "", err: "" }),
        now: () => 0,
    };

    test("--help 返回 0，不触发构建", async () => {
        let called = false;
        const deps = {
            ...okDeps,
            build: async () => {
                called = true;
                return { code: 0, out: "", err: "" };
            },
        };
        expect(await main(["--help"], ROOT, deps)).toBe(0);
        expect(called).toBe(false);
    });

    test("未知参数返回 2，不触发构建", async () => {
        let called = false;
        const deps = {
            ...okDeps,
            build: async () => {
                called = true;
                return { code: 0, out: "", err: "" };
            },
        };
        expect(await main(["--skip-icon"], ROOT, deps)).toBe(2);
        expect(called).toBe(false);
    });

    test("构建失败返回 1", async () => {
        const deps = { build: async () => ({ code: 1, out: "", err: "boom" }), now: () => 0 };
        expect(await main([], ROOT, deps)).toBe(1);
    });

    test("构建成功但产物读不到 → 返回 1，不粉饰", async () => {
        // ROOT 是不存在的路径，产物自然读不到。构建器谎报成功时必须有判据。
        const deps = { build: async () => ({ code: 0, out: "", err: "" }), now: () => 0 };
        expect(await main([], ROOT, deps)).toBe(1);
    });

    test("-KeepConsole 这类 PowerShell 风格写法也认", async () => {
        let seen: readonly string[] = [];
        const deps = {
            build: async (argv: readonly string[]) => {
                seen = argv;
                return { code: 0, out: "", err: "" };
            },
            now: () => 0,
        };
        await main(["-KeepConsole"], ROOT, deps);
        expect(seen).not.toContain("--windows-hide-console");
    });
});
