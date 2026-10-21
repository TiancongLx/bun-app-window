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

        // 描述分隔符是「一个以上空格」，不是「两个以上」。
        //
        // 目录树按最长的名字对齐，`probe-child-windows.ts` 后面只有 1 个空格；
        // 写成 `\s{2,}` 会让它永远解析不出来，于是正向的「声明的文件必须存在」
        // 从未检查过它。是反向断言（磁盘 → 目录树）把这个盲点暴露出来的。
        const m = /^ {2,}([\w.-]+\.(?:ts|ps1|cc|ico|dll|html))\s+\S/.exec(line);
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

guard("§3 目录结构：磁盘上的脚本必须被声明", () => {
    /**
     * 反向断言。正向的「声明的文件必须存在」抓不到「新增文件忘了登记」——
     * `native/model-image.ts` 就漏在目录树外整整一轮，而这段时间门禁一直是绿的。
     * 目录树是 agent 的第一份地图，漏登的文件等于不存在。
     */
    test("native/ 下的每个 .ts 都在目录树里登记过", () => {
        const declared = new Set(directoryTreeEntries().map((e) => e.name));
        const onDisk = readdirSync(join(ROOT, "native"))
            .filter((n) => n.endsWith(".ts"))
            .sort();
        // 防止空转：一个都没读到就等于没检查
        expect(onDisk.length).toBeGreaterThan(5);
        expect(onDisk.filter((n) => !declared.has(n))).toEqual([]);
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
        // 同 `directoryTreeEntries`：分隔符是「一个以上空格」。
        // 它现在没漏解析纯属运气——最长的测试名后面恰好还剩 2 个空格。
        const m = /^ {2,}([\w.-]+\.test\.ts)\s+\S/.exec(line);
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

// ---- 4b. 文档里作为路径引用的脚本必须真实存在 ----

guard("文档里的脚本路径引用", () => {
    /**
     * 允许提到「已经不存在的文件」——迁移与删除的记录必须留在文档里。
     * 但每一条都要显式登记，否则新增的幽灵引用会静默通过。
     * 取向与 `verify-pack.ts` 的 `ALLOW` 一致：**加一条必须是一次显式决定**。
     */
    const DELETED = new Map<string, string>([
        ["scripts/capture-window.ps1", "2026-10-20 删除（两个替代品制造歧义）"],
        ["scripts/capture.ps1", "同上（CopyFromScreen，受前台遮挡影响）"],
        ["tools/capture-window.ts", "截图层迁至 agent-eyes（2026-10-21）；pitfalls 里的实测数字仍引自它"],
        ["native/build-pack.ps1", "迁为 native/build-pack.ts（ADR 0014）"],
        ["native/build.ps1", "迁为 native/build.ts"],
        ["native/fetch.ps1", "迁为 native/fetch.ts"],
        ["scripts/gate.ps1", "迁为 scripts/gate.ts（ADR 0012）"],
        ["scripts/install-hooks.ps1", "迁为 scripts/install-hooks.ts"],
        ["_Repositories/src/host.ts", "反例：build-pack 曾经多退一层的错误路径"],
        ["src/cli/console-attach.ts", "外部参考项目的路径（it-is-go-time），不在本仓"],
        ["src/gui/page-script.test.ts", "src/gui/ 整体移除（UI 层改为 src/ui/index.html 静态文件）"],
    ]);

    /** 反引号里带目录的脚本路径；裸文件名无法唯一定位，不参与判定 */
    function referencedScripts(text: string): string[] {
        const paths = new Set<string>();
        for (const m of text.matchAll(/`([\w./-]+\/[\w.-]+\.(?:ts|ps1))`/g)) {
            paths.add(m[1]!);
        }
        return [...paths].sort();
    }

    test("每个被引用的脚本路径要么存在，要么在删除白名单里", async () => {
        const ghosts: string[] = [];
        for (const doc of ["AGENTS.md", "docs/pitfalls.md"]) {
            const file = Bun.file(join(ROOT, doc));
            if (!(await file.exists())) continue;
            for (const p of referencedScripts(await file.text())) {
                if (existsSync(join(ROOT, p))) continue;
                if (DELETED.has(p)) continue;
                ghosts.push(`${doc}: ${p}`);
            }
        }
        expect(ghosts).toEqual([]);
    });

    test("白名单自身不腐化：登记过的文件不许重新出现", () => {
        // 文件已经回来了却还挂在「已删除」名单上，说明这份名单没人看了
        const stale = [...DELETED.keys()].filter((p) => existsSync(join(ROOT, p)));
        expect(stale).toEqual([]);
    });
});

// ---- 5. §5 硬性约束的编号连续 ----

guard("§5 硬性约束", () => {
    test("编号从 1 开始连续无跳号", () => {
        // 只取 §5 章节内的编号。
        //
        // 初版是全局 `^(\d+)\. ` 匹配，当时恰好只有 §5 用行首有序列表，所以能过。
        // 2026-10-20 加入 §0 的三条教训后立刻变红——这不是文档的错，是护栏的范围
        // 写宽了：它想守的是「§5 的编号连续」，不是「全文只有一个有序列表」。
        // 一条经常误报的断言会被绕过，因此这里显式限定范围。
        const from = AGENTS.indexOf("## 5. 核心硬性约束");
        const to = AGENTS.indexOf("## 6. 命名与路径约定");
        expect(from).toBeGreaterThan(-1);
        expect(to).toBeGreaterThan(from);

        const section = AGENTS.slice(from, to);
        const numbered = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
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
        const seq: Array<{ n: number; label: string; line: number }> = [];
        lines.forEach((line, i) => {
            const m = /^### (\d+)\.(\d+)/.exec(line);
            if (!m?.[1] || !m[2]) return;
            // `Number("3.10")` 是 3.1，会小于 3.9 —— 初版就是这么写的，
            // 直到第一次出现两位数小版本号（3.10）才被这条护栏自己抓到。
            // 改成整数编码：major * 1000 + minor。
            seq.push({
                n: Number(m[1]) * 1000 + Number(m[2]),
                label: `${m[1]}.${m[2]}`,
                line: i + 1,
            });
        });
        expect(seq.length).toBeGreaterThan(10);

        const outOfOrder: string[] = [];
        for (let k = 1; k < seq.length; k++) {
            const prev = seq[k - 1];
            const cur = seq[k];
            if (prev && cur && cur.n < prev.n) {
                outOfOrder.push(
                    `L${cur.line} 编号 ${cur.label} 出现在 L${prev.line} 的 ${prev.label} 之后`,
                );
            }
        }
        expect(outOfOrder).toEqual([]);
    });
});

// ---- 7. 不写无法静态验证的统计数字 ----

/**
 * 这条记录的是一次真实漂移：§4 曾写「执行 tests/ 下共 15 个文件、182 个测试用例」，
 * 实际早已是 19 个文件、276 个用例 —— 而护栏当时只守「tests 清单里的文件名」，
 * 没守「用例数」。
 *
 * 用例数只有跑完测试才知道，静态断言做不到；所以正确的做法不是「断言它准确」，
 * 而是「根本不该写进来」。权威来源是 gate 摘要里的 `276 pass / 0 fail / 19 files`。
 */
guard("文档里的统计数字", () => {
    test("不得硬编码测试用例数（无法静态验证，必然漂移）", () => {
        const offenders = [...AGENTS.matchAll(/\d+\s*个测试用例/g)].map((m) => m[0]);
        expect(offenders).toEqual([]);
    });

    test("不得硬编码测试文件数（文件数由 §3 的 tests 清单体现）", () => {
        const offenders = [...AGENTS.matchAll(/\d+\s*个测试文件/g)].map((m) => m[0]);
        expect(offenders).toEqual([]);
    });

    test("gate 的 --verbose 必须在文档里有说明（新开关不能只活在代码里）", () => {
        expect(AGENTS).toContain("--verbose");
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
 * 因此本文件只守「形状唯一」的引用：目录树条目（**双向**：声明了的必须存在，
 * 存在的必须声明）、tests 清单、ADR 编号、npm 命令、`.ts` 入口路径，
 * 以及反引号里**带目录**的脚本路径（`tools/capture-window.ts` 这种；裸文件名不参与）。
 * 这几类都能唯一定位到一个文件或一条命令。
 *
 * 最后一类带一张「已删除」白名单（见上）。迁移会在文档里留下合法的历史引用：
 * 一律禁止会让历史记录无处安放，一律放行则幽灵引用会静默堆积。
 * 白名单把这个判断显式化——**加一条必须是一次决定**。
 */
describe("判据边界（元测试）", () => {
    test("护栏只断言可唯一定位的引用——这条记录设计意图", () => {
        expect(true).toBe(true);
    });
});
