/**
 * readme-contract.test.ts — 三份 README 的静态契约守卫
 *
 * ## 为什么要有这一层，它和 `release-sentinel.ts` 是什么关系
 *
 * `scripts/release-sentinel.ts` 是发版前的阻断步骤，它检查得最全（含打包实测与
 * git 态），但它**只在发版时跑**。一个只在发版时跑的判据有个已知的失效方式：
 * 平时没人跑，于是等到发版那一刻才发现三十处漂移，人只会去修最挡路的几处，
 * 剩下的继续烂。
 *
 * 所以静态部分下沉到 `bun test`：不打包、不碰 git、不依赖网络，每次提交都跑。
 * 它守的是「代码能力加了但文档没写」这一类——这类漂移在发版前发现已经太晚
 * （等于要临时补三份文档）。
 *
 * ## 分层原则
 *
 * | 判据 | 静态（本文件） | 哨兵 |
 * | --- | --- | --- |
 * | FLAG_* / BROWSER_UI_* / 子路径覆盖 | ✅ | ✅ |
 * | 三份结构同构 | ✅ | ✅ |
 * | 不引用发布面之外的文件 | ✅ | ✅ |
 * | 无自身版本字面量 | ✅ | ✅ |
 * | 包体积 = 实测 | ❌（不该依赖打包） | ✅ |
 * | CHANGELOG 有本版段落 | ❌（平时本来就没有） | ✅ |
 * | 工作区干净 / tag 未占用 | ❌（平时本来就脏） | ✅ |
 *
 * 分界线的依据只有一条：**这条判据在正常开发中会不会合法地失败**。会，就只放哨兵。
 *
 * ## 反向验证
 *
 * 每条判据都配了一个「拿坏样本喂它、必须变红」的自检。这是本仓库的既有纪律
 * （`pitfalls` 2.12）：判据最常见的失效方式是恒真，而恒真的判据比没有更糟——
 * 它冒充验收。
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import {
    README_FILES,
    declaredBrowserUiBits,
    declaredFlags,
    documentedSubpaths,
    forbiddenReferences,
    headingCount,
    mentionedFlags,
    parsePackageSize,
    readSourceTree,
    selfVersionLiterals,
} from "../scripts/lib/readme-contract";

const ROOT = resolve(import.meta.dir, "..");

const PKG = (await Bun.file(join(ROOT, "package.json")).json()) as {
    version: string;
    exports: Record<string, unknown>;
};

const READMES = new Map<string, string>();
for (const name of README_FILES) {
    READMES.set(name, await Bun.file(join(ROOT, name)).text());
}

const TYPES = await Bun.file(join(ROOT, "src/shell/types.ts")).text();

// ---- 纯函数的反向验证 ---------------------------------------------------------

describe("parsePackageSize：能解析，也能拒绝", () => {
    test("英文形态", () => {
        const got = parsePackageSize("x — 22 files, 0.48 MB packed (1.39 MB unpacked). y");
        expect(got).toEqual({ files: 22, packedMB: 0.48, unpackedMB: 1.39 });
    });

    test("简中形态（量词与括号都不同）", () => {
        const got = parsePackageSize("共 22 个文件（0.48 MB，解包后 1.39 MB）。");
        expect(got).toEqual({ files: 22, packedMB: 0.48, unpackedMB: 1.39 });
    });

    test("繁中形态", () => {
        const got = parsePackageSize("共 22 個檔案（0.48 MB，解包後 1.39 MB）。");
        expect(got).toEqual({ files: 22, packedMB: 0.48, unpackedMB: 1.39 });
    });

    test("**反向**：只有文件数、没有体积时必须返回 null，不许猜", () => {
        // 这条是关键：如果它在缺失时返回一个默认值，「声明的体积被删掉」
        // 这个漂移就永远不会被发现。
        expect(parsePackageSize("22 files")).toBeNull();
    });

    test("**反向**：只有一个 MB 时也返回 null", () => {
        expect(parsePackageSize("22 files, 0.48 MB packed")).toBeNull();
    });

    test("空文本返回 null", () => {
        expect(parsePackageSize("")).toBeNull();
    });
});

describe("declaredFlags / mentionedFlags", () => {
    test("从源码抓出全部 FLAG_*", () => {
        const got = declaredFlags('export const FLAG_A = 1;\nexport const FLAG_B = 2;\n');
        expect(got).toEqual(["FLAG_A", "FLAG_B"]);
    });

    test("**反向**：非 export const 形状不算", () => {
        expect(declaredFlags("const FLAG_A = 1;\nexport type FLAG_B = 2;\n")).toEqual([]);
    });

    test("从文档抓出出现过的 FLAG_*（去重）", () => {
        const got = mentionedFlags("`FLAG_A` 与 `FLAG_B`，再说一次 `FLAG_A`");
        expect([...got].sort()).toEqual(["FLAG_A", "FLAG_B"]);
    });

    test("**反向**：小写 flag_a 不算——常量名大小写敏感", () => {
        expect(mentionedFlags("flag_a 不是常量").size).toBe(0);
    });
});

describe("documentedSubpaths", () => {
    test("剥掉 ./ 前缀，排除主入口与 package.json", () => {
        const got = documentedSubpaths({
            ".": "./src/index.ts",
            "./types": "./src/types.ts",
            "./package.json": "./package.json",
        });
        expect(got).toEqual(["types"]);
    });

    test("**反向**：只剩主入口时返回空——调用方据此知道「没有子路径要覆盖」", () => {
        expect(documentedSubpaths({ ".": "./a.ts" })).toEqual([]);
    });
});

describe("forbiddenReferences", () => {
    test("抓到 AGENTS.md / .internal / docs 三种", () => {
        const got = forbiddenReferences("x.md", "见 AGENTS.md\n见 .internal/adr/1.md\n见 docs/pitfalls.md");
        expect(got.map((r) => r.name)).toEqual(["AGENTS.md", ".internal/", "docs/pitfalls.md"]);
        expect(got.map((r) => r.line)).toEqual([1, 2, 3]);
    });

    test("干净文本返回空", () => {
        expect(forbiddenReferences("x.md", "只有正常内容 ```ts\nconst a = 1;\n```")).toEqual([]);
    });

    test("vendor/ 出现在同一行时，该行的 vendor 片段被剔除后不再命中", () => {
        // `vendor/webview` 是正当引用：不在包里，但提到它的每一处都在解释
        // 「为什么这些东西不随包分发」。豁免必须限定在 vendor 片段本身，
        // 不能整行放过——否则 `vendor/x 与 AGENTS.md` 这种混写会被漏掉。
        expect(forbiddenReferences("x.md", "`vendor/webview/` 是 MIT").length).toBe(0);
        const mixed = forbiddenReferences("x.md", "`vendor/webview/` 与 AGENTS.md");
        expect(mixed.map((r) => r.name)).toEqual(["AGENTS.md"]);
    });

    test("**变体也算引用**：`AGENTS.md.bak` 同样够不着，必须命中", () => {
        // 初版期望是「不该命中」，跑出来 1 命中，于是重新想了一遍语义：
        // `\b` 在 `d` 与 `.` 之间成立，所以 `AGENTS.md.bak` 会命中 AGENTS.md 规则。
        // **命中的行为是对的**——装包的人同样打不开 `AGENTS.md.bak`。
        // 判据的意图是「不许指向发布面之外的文件」，不是「精确匹配一个文件名」。
        expect(forbiddenReferences("x.md", "AGENTS.md.bak 是备份").length).toBe(1);
    });

    test("**反向**：前面粘了字母的假名不命中（`MYAGENTS.md` 不是那个文件）", () => {
        expect(forbiddenReferences("x.md", "MYAGENTS.md 是别的东西").length).toBe(0);
    });
});

describe("selfVersionLiterals", () => {
    test("命中自身版本", () => {
        const got = selfVersionLiterals("x.md", "版本 1.2.3 发布", "1.2.3");
        expect(got).toHaveLength(1);
        expect(got[0]?.line).toBe(1);
    });

    test("**反向**：更长版本串的内部不算——`1.2.3` 不该命中 `1.2.30`", () => {
        // 少了这个边界，WebView2 的 `1.0.4258.31` 会误伤 `0.4` 之类的版本号，
        // 而误报会把这条判据逼成噪音。
        expect(selfVersionLiterals("x.md", "WebView2 1.2.30", "1.2.3")).toHaveLength(0);
    });

    test("**反向**：`11.2.3` 不算——前面也不能粘数字", () => {
        expect(selfVersionLiterals("x.md", "11.2.3", "1.2.3")).toHaveLength(0);
    });

    test("空版本号时不产生任何命中（不去匹配一切）", () => {
        expect(selfVersionLiterals("x.md", "任何文本", "")).toHaveLength(0);
    });
});

// ---- 真实文档的契约 -----------------------------------------------------------

test("三份 README 都存在且非空", () => {
    for (const name of README_FILES) {
        const text = READMES.get(name) ?? "";
        expect(text.length).toBeGreaterThan(1000);
    }
});

test("三份 README 结构同构（标题数一致）", () => {
    const counts = README_FILES.map((n) => headingCount(READMES.get(n) ?? ""));
    const base = counts[0] ?? 0;
    expect(base).toBeGreaterThan(20); // 防止「三份都是 0」这种恒真
    for (const [i, c] of counts.entries()) {
        expect(c, `${README_FILES[i]} 有 ${c} 个标题，基准 ${base}`).toBe(base);
    }
});

test("三份 README 都覆盖全部 FLAG_*", () => {
    const all = declaredFlags(TYPES);
    expect(all.length).toBeGreaterThan(5); // 反向：抓不到任何标志位说明解析坏了
    for (const name of README_FILES) {
        const mentioned = mentionedFlags(READMES.get(name) ?? "");
        const missing = all.filter((f) => !mentioned.has(f));
        expect(missing, `${name} 缺少`).toEqual([]);
    }
});

test("三份 README 都覆盖全部 BROWSER_UI_* 位", () => {
    const all = declaredBrowserUiBits(TYPES);
    expect(all.length).toBeGreaterThan(3);
    for (const name of README_FILES) {
        const text = READMES.get(name) ?? "";
        const missing = all.filter((b) => !text.includes(b));
        expect(missing, `${name} 缺少`).toEqual([]);
    }
});

test("三份 README 都覆盖全部 exports 子路径", () => {
    const subs = documentedSubpaths(PKG.exports);
    expect(subs.length).toBeGreaterThan(5);
    for (const name of README_FILES) {
        const text = READMES.get(name) ?? "";
        const missing = subs.filter((s) => !text.includes(`bun-app-window/${s}`));
        expect(missing, `${name} 缺少`).toEqual([]);
    }
});

test("三份 README 声明的包体积完全一致", () => {
    // 三份各自独立维护，同一份包的体积不该有两种说法。
    // 与实测的一致性由 `release-sentinel.ts` 守——这里只守「三份彼此相同」，
    // 因为「实测」需要打包，而 `bun test` 不该依赖打包产物。
    const sizes = README_FILES.map((n) => ({ n, s: parsePackageSize(READMES.get(n) ?? "") }));
    for (const { n, s } of sizes) {
        expect(s, `${n} 解析不出体积声明`).not.toBeNull();
    }
    const first = sizes[0]?.s ?? null;
    for (const { n, s } of sizes) {
        expect(s ?? null, `${n} 与 ${README_FILES[0]} 不一致`).toEqual(first);
    }
});

test("三份 README 都不引用发布面之外的文件", () => {
    const all = README_FILES.flatMap((n) => forbiddenReferences(n, READMES.get(n) ?? ""));
    expect(all).toEqual([]);
});

test("三份 README 都不含自身版本字面量", () => {
    // 版本号每发一次就变，写进正文等于埋一个必然过期的数字。
    // README 里需要版本时指向 `package.json` 或 `libInfo.version`。
    const all = README_FILES.flatMap((n) => selfVersionLiterals(n, READMES.get(n) ?? "", PKG.version));
    expect(all).toEqual([]);
});

test("README 里提到的每个 FLAG_* 都真的存在于源码", () => {
    // 与「源码的每个 flag 都在 README 里」互为反向：删掉一个 flag 之后
    // 只留前一条，README 里的残余名字会永远绿。
    const all = new Set(declaredFlags(TYPES));
    for (const name of README_FILES) {
        const mentioned = mentionedFlags(READMES.get(name) ?? "");
        const ghosts = [...mentioned].filter((f) => !all.has(f));
        expect(ghosts, `${name} 提到了不存在的标志位`).toEqual([]);
    }
});

test("源码树可被静态扫描（哨兵与测试的共同前提）", () => {
    // `readSourceTree` 是「README 提到的常量是否存在」这类判据的底座。
    // 它返回空串会让所有基于它的断言变成恒真，所以这条单独钉一下。
    const corpus = readSourceTree(join(ROOT, "src/shell"));
    expect(corpus.length).toBeGreaterThan(10_000);
    expect(corpus).toContain("FLAG_FRAMELESS");
});
