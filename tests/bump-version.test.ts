import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
    detectEol,
    main,
    planBump,
    replacePeVersion,
    replacePkgVersion,
} from "../scripts/bump-version";

const REPO = resolve(import.meta.dir, "..");

/**
 * 版本号升级器的断言。
 *
 * 旧版 `.ps1` 用 `-replace`（正则引擎）+ `Set-Content`（按 CRLF 写盘）。
 * 本仓 `.gitattributes` 固化 LF，于是「只改了一个版本号」的操作可能顺带
 * 改掉整个文件的字节 —— docs/pitfalls.md 5.6 记过真实的 EOL 污染。
 * 这里断言替换只动版本号那几个字节，其余原样保留。
 */

describe("planBump", () => {
    test("标准 semver", () => {
        expect(planBump("0.3.0")).toEqual({ version: "0.3.0", peVersion: "0.3.0.0" });
    });

    test("prerelease：PE 只取前三段，第四段固定 0", () => {
        // PE 版本资源是四段纯数字，不承载 prerelease 语义
        expect(planBump("1.2.3-beta.1")).toEqual({ version: "1.2.3-beta.1", peVersion: "1.2.3.0" });
        expect(planBump("2.0.0-rc.1")).toEqual({ version: "2.0.0-rc.1", peVersion: "2.0.0.0" });
    });

    test("build metadata 也接受", () => {
        expect(planBump("1.2.3+build.5")?.peVersion).toBe("1.2.3.0");
    });

    test("多位数字", () => {
        expect(planBump("10.20.30")?.peVersion).toBe("10.20.30.0");
    });

    test("非法输入返回 null", () => {
        for (const bad of ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "01.2.3-", " 1.2.3", "1.2.3 "]) {
            expect({ bad, plan: planBump(bad) }).toEqual({ bad, plan: null });
        }
    });
});

describe("detectEol", () => {
    test("含 CRLF 判为 CRLF", () => {
        expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    });

    test("纯 LF", () => {
        expect(detectEol("a\nb\n")).toBe("\n");
    });

    test("无换行的短文本默认 LF", () => {
        expect(detectEol("{ }")).toBe("\n");
    });
});

describe("replacePkgVersion", () => {
    const pkg = `{
    "name": "x",
    "version": "0.2.0",
    "engines": { "bun": ">=1.4.3" }
}
`;

    test("只改 version 字段", () => {
        const out = replacePkgVersion(pkg, "0.3.0");
        expect(out).not.toBeNull();
        expect(out).toContain(`"version": "0.3.0"`);
        expect(out).toContain(`"name": "x"`);
        // 其余字节逐个保留
        expect(out!.replace("0.3.0", "0.2.0")).toBe(pkg);
    });

    test("不误伤形似的其它键", () => {
        // 全局替换会连带改到 engines 或依赖版本；这里必须只命中顶层 version
        const tricky = `{
    "version": "0.2.0",
    "engines": { "bun": "0.2.0" }
}
`;
        const out = replacePkgVersion(tricky, "0.9.9");
        expect(out).not.toBeNull();
        expect(out).toContain(`"version": "0.9.9"`);
        expect(out).toContain(`"bun": "0.2.0"`);
    });

    test("定位不到返回 null，不静默返回原文", () => {
        expect(replacePkgVersion(`{ "name": "x" }`, "1.0.0")).toBeNull();
    });

    test("保留原 EOL", () => {
        const crlf = `{\r\n    "version": "0.2.0"\r\n}\r\n`;
        const out = replacePkgVersion(crlf, "0.3.0");
        expect(out).not.toBeNull();
        expect(detectEol(out!)).toBe("\r\n");
        expect(out).toContain(`"version": "0.3.0"`);
    });
});

describe("replacePeVersion", () => {
    // .ps1 时代（单引号）
    const packPs1 = `$args = @(
    '--windows-version', '0.2.0.0',
    '--other', 'keep-me'
)
`;

    // .ts 时代（双引号，与 native/build-pack.ts 的真实形状一致）
    const packTs = `const argv = [
    "--windows-version", "0.2.0.0",
    "--other", "keep-me",
];
`;

    test("只改 --windows-version 的值（单引号，兼容旧格式）", () => {
        const out = replacePeVersion(packPs1, "0.3.0.0");
        expect(out).not.toBeNull();
        expect(out).toContain(`'--windows-version', '0.3.0.0'`);
        expect(out).toContain(`'--other', 'keep-me'`);
    });

    test("只改 --windows-version 的值（双引号，当前格式）", () => {
        const out = replacePeVersion(packTs, "0.3.0.0");
        expect(out).not.toBeNull();
        expect(out).toContain(`"--windows-version", "0.3.0.0"`);
        expect(out).toContain(`"--other", "keep-me"`);
    });

    test("定位不到返回 null", () => {
        expect(replacePeVersion("$args = @()", "1.0.0.0")).toBeNull();
        expect(replacePeVersion("const argv = [];", "1.0.0.0")).toBeNull();
    });

    test("保留原 EOL", () => {
        const crlf = packTs.replace(/\n/g, "\r\n");
        const out = replacePeVersion(crlf, "0.3.0.0");
        expect(out).not.toBeNull();
        expect(detectEol(out!)).toBe("\r\n");
    });
});

describe("main 的端到端行为", () => {
    let sandbox: string | null = null;

    afterEach(() => {
        if (sandbox) {
            rmSync(sandbox, { recursive: true, force: true });
            sandbox = null;
        }
    });

    /** 造一个最小仓库根：两个目标文件都是 LF */
    function makeRoot(pkgVersion = "0.2.0", peVersion = "0.2.0.0"): string {
        const dir = mkdtempSync(join(tmpdir(), "baw-bump-"));
        sandbox = dir;
        writeFileSync(
            join(dir, "package.json"),
            `{\n    "name": "baw-probe",\n    "version": "${pkgVersion}"\n}\n`,
            "utf8",
        );
        const nativeDir = join(dir, "native");
        mkdirSync(nativeDir, { recursive: true });
        // 夹具用与真实源码相同的形状（TS + 双引号 + 同行）
        writeFileSync(
            join(nativeDir, "build-pack.ts"),
            `const argv = [\n    "--windows-version", "${peVersion}",\n];\n`,
            "utf8",
        );
        return dir;
    }

    test("写入后两处同步，且 EOL 保持 LF", async () => {
        const root = makeRoot();
        expect(await main(["0.3.0"], root)).toBe(0);

        const pkg = readFileSync(join(root, "package.json"), "utf8");
        const pack = readFileSync(join(root, "native", "build-pack.ts"), "utf8");
        expect(pkg).toContain(`"version": "0.3.0"`);
        expect(pack).toContain(`"--windows-version", "0.3.0.0"`);
        expect(detectEol(pkg)).toBe("\n");
        expect(detectEol(pack)).toBe("\n");
    });

    test("--dry-run 不落盘", async () => {
        const root = makeRoot();
        const before = readFileSync(join(root, "package.json"), "utf8");
        expect(await main(["0.3.0", "--dry-run"], root)).toBe(0);
        expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    });

    test("已是目标版本 → 无改动，退出 0", async () => {
        const root = makeRoot("0.3.0", "0.3.0.0");
        const before = readFileSync(join(root, "package.json"), "utf8");
        expect(await main(["0.3.0"], root)).toBe(0);
        expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    });

    test("非法版本号 → 退出 2，不落盘", async () => {
        const root = makeRoot();
        const before = readFileSync(join(root, "package.json"), "utf8");
        expect(await main(["not-a-version"], root)).toBe(2);
        expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    });

    test("缺参数 → 退出 2", async () => {
        expect(await main([], makeRoot())).toBe(2);
    });

    test("目标文件缺失 → 退出 2", async () => {
        const dir = mkdtempSync(join(tmpdir(), "baw-bump-empty-"));
        sandbox = dir;
        expect(await main(["0.3.0"], dir)).toBe(2);
    });

    test("--help 返回 0", async () => {
        expect(await main(["--help"], REPO)).toBe(0);
        expect(await main(["-Help"], REPO)).toBe(0);
    });
});

describe("仓库当前版本一致", () => {
    test("bump 的 plan 与真实 package.json 的版本相符", async () => {
        const pkg = (await Bun.file(join(REPO, "package.json")).json()) as { version: string };
        const plan = planBump(pkg.version);
        expect(plan).not.toBeNull();
        // 用真实文件跑一次幂等 bump：两处已一致时应当无改动
        expect(await main([pkg.version, "--dry-run"], REPO)).toBe(0);
    });
});
