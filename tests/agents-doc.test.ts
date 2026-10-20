import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const AGENTS_PATH = join(ROOT, "AGENTS.md");

/**
 * `AGENTS.md` 的一致性护栏。
 *
 * 这个文件存在的理由：仓库有 243 个测试守着代码，却没有一条守着 agent 进来看的
 * 第一份文件。它可以任意漂移，门禁照绿不误 —— 2026-10-20 实测就漂了三处：
 * 目录树里写着已删除的 `build.ps1`、tests 清单只列了 11 个（实际 18 个）、
 * `scripts/lib/entrypoint.ts` 完全未提及。
 *
 * 判据刻意保守：只断言**能唯一确定**的事实。理由见文件末尾的说明。
 *
 * **`AGENTS.md` 不进版本控制**（`.gitignore` 第 23 行 `/AGENTS.md`），
 * 因此 `--clean` 的干净副本里没有这个文件。本文件在那种情况下整体跳过——
 * 它守的是本地知识载体，载体不存在时没有可守的对象。这条由 `--clean` 实测发现：
 * 初版直接 `readFileSync`，干净副本里 ENOENT 让整个门禁红。
 */

const HAS_AGENTS = existsSync(AGENTS_PATH);
const AGENTS = HAS_AGENTS ? readFileSync(AGENTS_PATH, "utf8") : "";

/** 载体存在时才跑断言；不存在时用一条 skip 记录原因，而不是静默通过 */
const guard = HAS_AGENTS ? describe : describe.skip;

if (!HAS_AGENTS) {
    describe("AGENTS.md 一致性护栏", () => {
        test("载体不存在，跳过（本地知识载体不进版本控制）", () => {
            expect(HAS_AGENTS).toBe(false);
        });
    });
}

// ---- 1. §3 目录树里的文件名必须真实存在 ----

/**
 * 抽取 §3 代码块里「缩进 + 文件名 + 两空格以上 + 描述」的行。
 *
 * 为什么限定这个形状：目录树是 AGENTS.md 里唯一一处「文件名独占一列」的地方，
 * 因此可以无歧义地判断「这一行声称某个文件在这里」。
 * 正文里散落的 `gate.ts` 之类不断言 —— 见文件末尾的说明。
 */
function directoryTreeEntries(): Array<{ name: string; line: number }> {
    const lines = AGENTS.split(/\r?\n/);
    const out: Array<{ name: string; line: number }> = [];

    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith("```text")) {
            inBlock = true;
            continue;
        }
        if (inBlock && line.startsWith("```")) {
            inBlock = false;
            continue;
        }
        if (!inBlock) continue;

        const m = /^ {2,}([\w.-]+\.(?:ts|ps1|cc|ico|dll|html))\s{2,}\S/.exec(line);
        if (m?.[1]) {
            out.push({ name: m[1], line: i + 1 });
        }
    }
    return out;
}

/** 在整棵仓库里按文件名查找（排除 node_modules / vendor / .git） */
function findFileAnywhere(name: string): string[] {
    const hits: string[] = [];
    const skip = new Set(["node_modules", "vendor", ".git", ".build", "dist"]);
    const walk = (dir: string, depth: number): void => {
        if (depth > 6) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const p = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(p, depth + 1);
            } else if (entry.name === name) {
                hits.push(p.replace(ROOT, "").replace(/\\/g, "/"));
            }
        }
    };
    walk(ROOT, 0);
    return hits;
}

guard("§3 目录结构：声明的文件必须存在", () => {
    const entries = directoryTreeEntries();

    test("目录树能被解析出条目（防止格式改动导致护栏静默失效）", () => {
        // 若正则失效，下面的逐条断言会因为「一个都没检查」而空转通过——
        // 所以先断言「确实抓到了一批」，否则这条护栏等于不存在。
        expect(entries.length).toBeGreaterThan(20);
    });

    test("每个条目在磁盘上都能找到同名文件", () => {
        const missing = entries.filter((e) => findFileAnywhere(e.name).length === 0);
        expect(missing.map((e) => `L${e.line} ${e.name}`)).toEqual([]);
    });
});

// ---- 2. tests 清单必须与磁盘一致 ----

/** §3 里 tests/ 段落列出的测试文件名 */
function declaredTestFiles(): string[] {
    const lines = AGENTS.split(/\r?\n/);
    const out: string[] = [];
    let inTests = false;
    for (const line of lines) {
        if (/^tests\//.test(line)) {
            inTests = true;
            continue;
        }
        if (inTests && /^\S/.test(line) && !line.startsWith("tests/")) {
            // 离开 tests 段落
            if (!/^ {2,}/.test(line)) break;
        }
        if (!inTests) continue;
        const m = /^ {2,}([\w.-]+\.test\.ts)\s{2,}\S/.exec(line);
        if (m?.[1]) out.push(m[1]);
    }
    return out;
}

guard("§3 tests 清单：与磁盘一致", () => {
    const declared = declaredTestFiles();
    const actual = readdirSync(join(ROOT, "tests"))
        .filter((n) => n.endsWith(".test.ts"))
        .sort();

    test("清单能被解析（同上，防止空转）", () => {
        expect(declared.length).toBeGreaterThan(5);
    });

    test("磁盘上的测试文件都被列出", () => {
        const missing = actual.filter((f) => !declared.includes(f));
        expect(missing).toEqual([]);
    });

    test("列出的测试文件都真实存在", () => {
        const phantom = declared.filter((f) => !actual.includes(f));
        expect(phantom).toEqual([]);
    });
});

// ---- 3. ADR 索引必须与 .internal/adr/ 一致 ----

guard("ADR 索引一致性", () => {
    const indexPath = join(ROOT, ".internal", "adr");

    /** 索引表里的编号 */
    function indexedIds(): string[] {
        return [...AGENTS.matchAll(/^\| (\d{4}) \|/gm)].map((m) => m[1]!);
    }

    /** 磁盘上的编号 */
    function onDiskIds(): string[] {
        // .internal/adr 不纳入版本控制，干净副本里不存在。
        // 那种情况下没有可比对的基准，跳过而不是失败——否则 --clean 必红。
        if (!existsSync(indexPath)) return [];
        return readdirSync(indexPath)
            .filter((n) => /^\d{4}.*\.md$/.test(n))
            .map((n) => n.slice(0, 4))
            .sort();
    }

    test("索引编号无重复", () => {
        const ids = indexedIds();
        expect(ids.length).toBe(new Set(ids).size);
    });

    test("索引与磁盘双向一致（目录不存在时跳过）", () => {
        const disk = onDiskIds();
        if (disk.length === 0) {
            // .internal/adr 是本地目录，干净 clone 里没有。此处不算失败。
            expect(disk).toEqual([]);
            return;
        }
        const idx = [...indexedIds()].sort();
        expect({ onlyIndex: idx.filter((i) => !disk.includes(i)) }).toEqual({ onlyIndex: [] });
        expect({ onlyDisk: disk.filter((i) => !idx.includes(i)) }).toEqual({ onlyDisk: [] });
    });
});

// ---- 4. 文档里提到的 npm 命令必须真实存在 ----

guard("AGENTS.md 提到的 package.json 命令", () => {
    /**
     * 抽取 `bun run <name>` 形式的调用，只保留**不带路径**的那些。
     * 带路径的是 `bun run scripts/gate.ts`，跑的是文件而不是 script，另行处理。
     */
    function referencedScripts(): string[] {
        const names = new Set<string>();
        for (const m of AGENTS.matchAll(/bun run ([a-z][\w:-]*)(?![\w/])/g)) {
            names.add(m[1]!);
        }
        return [...names].sort();
    }

    test("引用的 script 名都存在于 package.json", async () => {
        const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
            scripts?: Record<string, string>;
        };
        const available = Object.keys(pkg.scripts ?? {});
        const referenced = referencedScripts();
        const unknown = referenced.filter((n) => !available.includes(n));
        expect(unknown).toEqual([]);
    });

    test("引用的 .ts 入口文件都存在", () => {
        const paths = new Set<string>();
        for (const m of AGENTS.matchAll(/bun run ((?:\.\/)?[\w./-]+\.ts)/g)) {
            paths.add(m[1]!.replace(/^\.\//, ""));
        }
        const missing = [...paths].filter((p) => !existsSync(join(ROOT, p)));
        expect(missing).toEqual([]);
    });
});

// ---- 5. §5 硬性约束的编号连续 ----

guard("§5 硬性约束", () => {
    test("编号从 1 开始连续无跳号", () => {
        const numbered = [...AGENTS.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
        expect(numbered.length).toBeGreaterThan(10);
        expect(numbered).toEqual(numbered.map((_, i) => i + 1));
    });
});

// ---- 6. pitfalls 的编号与章节归属 ----

/**
 * `docs/pitfalls.md` 的结构护栏。
 *
 * 这条是为了防一类真实发生过的事故：新增 5.9 时误插到「六、基线」之后，
 * 结果 §5 的编号在文件里不是单调的，人读到 5.7 就直接跳到第六章，
 * 5.8 / 5.9 成了挂在文末的孤儿。
 */
describe("pitfalls 编号与章节归属", () => {
    const doc = readFileSync(join(ROOT, "docs", "pitfalls.md"), "utf8");
    const lines = doc.split(/\r?\n/);

    /** 顶层章节「一、二、…」的位置 */
    function chapterStarts(): Array<{ index: number; name: string }> {
        const out: Array<{ index: number; name: string }> = [];
        lines.forEach((l, i) => {
            if (/^## [一二三四五六七八九十]+、/.test(l)) out.push({ index: i, name: l });
        });
        return out;
    }

    test("每一条 `### N.M` 都落在编号为 N 的章节内", () => {
        const chapters = chapterStarts();
        const offenders: string[] = [];

        lines.forEach((line, i) => {
            const m = /^### (\d+)\./.exec(line);
            if (!m) return;
            const num = Number(m[1]);
            // 找到本条之前最近的一级章节
            const owner = [...chapters].reverse().find((c) => c.index < i);
            if (!owner) {
                offenders.push(`L${i + 1} ${line}（无所属章节）`);
                return;
            }
            const ownerNum = "一二三四五六七八九十".indexOf(owner.name.charAt(3)) + 1;
            if (ownerNum !== num) {
                offenders.push(`L${i + 1} ${line}（在「${owner.name.slice(3)}」章节下，但编号是 ${num}）`);
            }
        });

        expect(offenders).toEqual([]);
    });

    test("同一章节内的小节编号单调递增", () => {
        const seq: Array<{ n: number; line: number }> = [];
        lines.forEach((line, i) => {
            const m = /^### (\d+)\.(\d+)/.exec(line);
            if (m) seq.push({ n: Number(`${m[1]}.${m[2]}`), line: i + 1 });
        });
        expect(seq.length).toBeGreaterThan(10);

        const outOfOrder: string[] = [];
        for (let k = 1; k < seq.length; k++) {
            const prev = seq[k - 1];
            const cur = seq[k];
            if (prev && cur && cur.n < prev.n) {
                outOfOrder.push(`L${cur.line} 编号 ${cur.n} 出现在 L${prev.line} 的 ${prev.n} 之后`);
            }
        }
        expect(outOfOrder).toEqual([]);
    });
});

/**
 * 为什么不断言正文里散落的裸文件名（`gate.ts`、`resolve.ts`、`icmp.ts`…）：
 *
 * AGENTS.md 正文有大量 `gate.ts`、`titlebar.ts` 这样的简写，它们可能指
 * `scripts/gate.ts`、`src/shell/titlebar.ts`、`src/ui/titlebar.ts` 中的任何一个，
 * 甚至只是「这个模块」的口语指代。逐条断言存在性会产生大量假阳性，
 * 而假阳性会让护栏本身被绕过 —— 一条经常性误报的断言，等于没有。
 *
 * 因此本文件只守「形状唯一」的引用：目录树条目、tests 清单、ADR 编号、
 * npm 命令、.ts 入口路径。这几类都能唯一定位到一个文件或一条命令。
 */
describe("判据边界（元测试）", () => {
    test("护栏只断言可唯一定位的引用——这条记录设计意图", () => {
        expect(true).toBe(true);
    });
});
