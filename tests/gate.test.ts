import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    LABELS,
    type GateDeps,
    type GateIO,
    type GateOptions,
    type RunResult,
    type Stage,
    type StageResult,
    checkedFileCount,
    failedCases,
    foldedLineCount,
    formatStage,
    main,
    normalizeArg,
    parseGateArgs,
    fmtVerdict,
    parseFmtFileCount,
    parsePackSummary,
    parseTestCounts,
    parseTestFileCount,
    planStages,
    runGate,
    splitLines,
    summarize,
} from "../scripts/gate";

/**
 * 门禁自身的判定逻辑。
 *
 * 这个文件存在的理由：`gate.ts` 是所有质量保证的入口，它一旦悄悄变成「永远返回
 * true」，所有下游保障同时失效。上一轮用三种注入故障证明过它能红，但那是手工跑
 * 一遍、结论写进 ADR——没有固化成用例。现在固化。
 *
 * 覆盖范围：
 *   - 纯函数：参数归一化、摘要解析、阶段编排、汇总格式
 *   - 控制流：任一阶段失败立即短路（通过注入假 runner，不启动任何子进程）
 */

// ---- 参数归一化 --------------------------------------------------------------

describe("normalizeArg", () => {
    test("PowerShell 风格的 PascalCase → kebab", () => {
        expect(normalizeArg("-SkipPack")).toBe("--skip-pack");
        expect(normalizeArg("-Clean")).toBe("--clean");
        expect(normalizeArg("-KeepClone")).toBe("--keep-clone");
        expect(normalizeArg("-SkipTest")).toBe("--skip-test");
    });

    test("已经是 kebab 的保持原样（单/双横线都归一为双横线）", () => {
        expect(normalizeArg("--skip-pack")).toBe("--skip-pack");
        expect(normalizeArg("-skip-pack")).toBe("--skip-pack");
    });

    test("camelCase 也能拆开", () => {
        expect(normalizeArg("-skipPack")).toBe("--skip-pack");
    });

    test("非参数原样返回", () => {
        expect(normalizeArg("clean")).toBe("clean");
        expect(normalizeArg("--")).toBe("--");
        expect(normalizeArg("../some/path")).toBe("../some/path");
        expect(normalizeArg("--a=1")).toBe("--a=1");
    });
});

describe("parseGateArgs", () => {
    test("默认全部关闭", () => {
        expect(parseGateArgs([])).toEqual({
            clean: false,
            keepClone: false,
            skipTest: false,
            skipFmt: false,
            skipPack: false,
            verbose: false,
            help: false,
        });
    });

    test("两种风格得到同一个结果", () => {
        const kebab = parseGateArgs(["--clean", "--skip-pack"]);
        const pascal = parseGateArgs(["-Clean", "-SkipPack"]);
        expect(pascal).toEqual(kebab);
        expect(kebab.clean).toBe(true);
        expect(kebab.skipPack).toBe(true);
    });

    test("--skip-fmt 与 -SkipFmt 都识别", () => {
        expect(parseGateArgs(["--skip-fmt"]).skipFmt).toBe(true);
        expect(parseGateArgs(["-SkipFmt"]).skipFmt).toBe(true);
        // 与 skipPack 互不牵连
        expect(parseGateArgs(["--skip-fmt"]).skipPack).toBe(false);
    });

    test("--help 与 -Help 都识别", () => {
        expect(parseGateArgs(["--help"]).help).toBe(true);
        expect(parseGateArgs(["-Help"]).help).toBe(true);
    });

    test("未知参数直接抛错，不静默忽略", () => {
        // 静默忽略意味着「打错一个字母，门禁就在你没预期的地方跑」——必须炸
        expect(() => parseGateArgs(["--skip-pak"])).toThrow();
    });
});

// ---- 摘要解析 ---------------------------------------------------------------

describe("checkedFileCount", () => {
    test("成功措辞（写在 stderr）", () => {
        const res: RunResult = { code: 0, out: "", err: "✓ No type errors in 27 files [61ms]\n" };
        expect(checkedFileCount(res)).toBe(27);
    });

    test("失败措辞", () => {
        const res: RunResult = { code: 1, out: "error TS2322 …\n", err: "Found 1 error in 1 file, checked 27 files" };
        expect(checkedFileCount(res)).toBe(27);
    });

    test("两种措辞都取不到时返回 0 —— 这是判失败的前提", () => {
        expect(checkedFileCount({ code: 0, out: "", err: "" })).toBe(0);
        expect(checkedFileCount({ code: 0, out: "something else", err: "" })).toBe(0);
    });

    test("单数 file 也能解析", () => {
        expect(checkedFileCount({ code: 0, out: "", err: "✓ No type errors in 1 file" })).toBe(1);
    });
});

describe("parseTestCounts", () => {
    test("取到 pass / fail", () => {
        const res: RunResult = { code: 1, out: " 122 pass\n 1 fail\n", err: "" };
        expect(parseTestCounts(res)).toEqual({ pass: 122, fail: 1 });
    });

    test("只有 pass 时 fail 记为 0", () => {
        expect(parseTestCounts({ code: 0, out: " 122 pass\n", err: "" })).toEqual({
            pass: 122,
            fail: 0,
        });
    });

    test("取不到返回 null（不假装 0 通过）", () => {
        expect(parseTestCounts({ code: 0, out: "", err: "" })).toBeNull();
    });
});

describe("parseTestFileCount", () => {
    test("取 Ran … across N files", () => {
        const res: RunResult = {
            code: 0,
            out: "",
            err: "Ran 256 tests across 19 files. [473.00ms]",
        };
        expect(parseTestFileCount(res)).toBe(19);
    });

    test("单数 file 也能解析", () => {
        expect(parseTestFileCount({ code: 0, out: "", err: "Ran 1 test across 1 file." })).toBe(1);
    });

    test("取不到返回 0（摘要里就不显示这一段，不编造）", () => {
        expect(parseTestFileCount({ code: 0, out: "", err: "" })).toBe(0);
        expect(parseTestFileCount({ code: 1, out: "boom", err: "" })).toBe(0);
    });
});

describe("parseFmtFileCount", () => {
    test("成功措辞：All N files are formatted", () => {
        const res: RunResult = { code: 0, out: "", err: "All 92 files are formatted." };
        expect(parseFmtFileCount(res)).toBe(92);
    });

    test("失败措辞：N files need formatting", () => {
        const res: RunResult = { code: 1, out: "", err: "1 file needs formatting. Run bun fmt to fix it." };
        expect(parseFmtFileCount(res)).toBe(1);
        expect(parseFmtFileCount({ code: 1, out: "", err: "100 files need formatting." })).toBe(100);
    });

    test("单数 is / file 也认", () => {
        expect(parseFmtFileCount({ code: 0, out: "", err: "All 1 file is formatted." })).toBe(1);
    });

    test("**反向**：两种措辞都取不到时返回 0 —— 门禁据此判失败", () => {
        // 这是「.prettierignore 写歪成 * 之后命令照样 exit 0」的那条防线：
        // 取到 0 就不能当通过，否则判据等于没看任何文件。
        expect(parseFmtFileCount({ code: 0, out: "", err: "" })).toBe(0);
        expect(parseFmtFileCount({ code: 0, out: "no files matched", err: "" })).toBe(0);
    });
});

describe("fmtVerdict", () => {
    test("退出码 0 且确认了文件数 → 通过", () => {
        const v = fmtVerdict({ code: 0, out: "", err: "All 92 files are formatted." });
        expect(v.ok).toBe(true);
        expect(v.detail).toBe("92 files");
    });

    test("退出码非 0 → 失败，并报出待格式化数量", () => {
        const v = fmtVerdict({ code: 1, out: "", err: "3 files need formatting." });
        expect(v.ok).toBe(false);
        expect(v.detail).toContain("3");
    });

    test("**反向**：退出码 0 但取不到文件数 → 判失败（防满分答卷）", () => {
        // 摘掉这条守卫时，测试全绿——本轮反向验证实测到的缺口，故抽成纯函数来守。
        const v = fmtVerdict({ code: 0, out: "", err: "" });
        expect(v.ok).toBe(false);
        expect(v.detail).toContain("prettierignore");
    });

    test("**反向**：文件数为 0 也不能通过，即使措辞是 All 0 files", () => {
        const v = fmtVerdict({ code: 0, out: "", err: "All 0 files are formatted." });
        expect(v.ok).toBe(false);
    });
});

// ---- 折叠与聚焦 -------------------------------------------------------------

describe("splitLines", () => {
    test("空串得到空数组", () => {
        expect(splitLines("")).toEqual([]);
    });

    test("丢掉末尾空行，保留内部空行", () => {
        expect(splitLines("a\nb\n\n")).toEqual(["a", "b"]);
        expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    });

    test("CRLF 与孤立 CR 都按换行处理", () => {
        expect(splitLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    });
});

describe("failedCases", () => {
    test("从 stderr 摘出 (fail) 行", () => {
        const raw = { out: "", err: "(pass) a\n(fail) 目标用例 [0.1ms]\n" };
        expect(failedCases(raw)).toEqual(["目标用例 [0.1ms]"]);
    });

    test("剥掉 ANSI 色码 —— 否则 startsWith 永远不命中", () => {
        const raw = { out: "", err: "\u001b[31;1m(fail) 断言失败 [0.03ms]\u001b[0m\n" };
        expect(failedCases(raw)).toEqual(["断言失败 [0.03ms]"]);
    });

    test("stdout 与 stderr 两路都看", () => {
        const raw = { out: "(fail) stdout 里的\n", err: "(fail) stderr 里的\n" };
        expect(failedCases(raw)).toEqual(["stdout 里的", "stderr 里的"]);
    });

    test("同一行重复出现只报一次（Bun 末尾会再列一遍失败清单）", () => {
        const err = "(fail) x [0.1ms]\n…\n2 tests failed:\n(fail) x [0.1ms]\n";
        expect(failedCases({ out: "", err })).toEqual(["x [0.1ms]"]);
    });

    test("没有 (fail) 时返回空数组，不返回 [undefined]", () => {
        expect(failedCases({ out: "(pass) a\n", err: "" })).toEqual([]);
    });
});

describe("foldedLineCount", () => {
    function stage(ok: boolean, out: string, err: string): StageResult {
        return { stage: "test", ok, rc: ok ? 0 : 1, ms: 1, detail: "", out, err };
    }

    test("只统计通过的阶段", () => {
        expect(foldedLineCount([stage(true, "a\nb\n", "c\n"), stage(false, "x\ny\n", "")])).toBe(3);
    });

    test("空输出记 0", () => {
        expect(foldedLineCount([stage(true, "", "")])).toBe(0);
    });
});

describe("parsePackSummary", () => {
    test("取最后一行 VERIFY-PACK 结论", () => {
        const out = [
            "  ok   tarball 非空   19 个文件",
            "VERIFY-PACK FAILED (2/7)",
            "verify-pack: something went wrong",
            "",
        ].join("\n");
        expect(parsePackSummary({ code: 1, out, err: "" })).toBe("verify-pack: something went wrong");
    });

    test("没有结论行时返回空串", () => {
        expect(parsePackSummary({ code: 0, out: "random output", err: "" })).toBe("");
    });
});

// ---- 阶段编排 ---------------------------------------------------------------

describe("planStages", () => {
    const base: GateOptions = {
        clean: false,
        keepClone: false,
        skipTest: false,
        skipFmt: false,
        skipPack: false,
        verbose: false,
    };

    test("默认四个阶段，顺序固定：check → test → fmt → pack", () => {
        expect(planStages(base)).toEqual(["check", "test", "fmt", "pack"]);
    });

    test("--skip-test 连带跳过 pack（行为层的两段一起走），但保留 fmt", () => {
        expect(planStages({ ...base, skipTest: true })).toEqual(["check", "fmt"]);
    });

    test("--skip-fmt 只砍掉 fmt，其余不动", () => {
        expect(planStages({ ...base, skipFmt: true })).toEqual(["check", "test", "pack"]);
    });

    test("--skip-pack 只砍掉最后一段", () => {
        expect(planStages({ ...base, skipPack: true })).toEqual(["check", "test", "fmt"]);
    });

    test("--skip-test 与 --skip-fmt 同时给，只剩 check 与 pack 之间的那层不存在的段", () => {
        expect(planStages({ ...base, skipTest: true, skipFmt: true })).toEqual(["check"]);
    });

    test("--clean 不影响阶段组成（它改的是运行位置）", () => {
        expect(planStages({ ...base, clean: true })).toEqual(["check", "test", "fmt", "pack"]);
    });
});

// ---- 输出格式 ---------------------------------------------------------------

describe("formatStage / summarize", () => {
    const okStage: StageResult = {
        stage: "check",
        ok: true,
        rc: 0,
        ms: 90,
        detail: "27 files",
        out: "",
        err: "",
    };
    const badStage: StageResult = {
        stage: "test",
        ok: false,
        rc: 1,
        ms: 430,
        detail: "1 fail",
        out: "",
        err: "",
    };

    test("通过行带耗时与细节", () => {
        expect(formatStage(okStage)).toBe("bun check ok (0.1s) — 27 files");
    });

    test("失败行带 rc", () => {
        expect(formatStage(badStage)).toBe("bun test FAILED (rc=1, 0.4s) — 1 fail");
    });

    test("每个阶段都有标签，不会打出 undefined", () => {
        for (const stage of Object.keys(LABELS) as Stage[]) {
            expect(formatStage({ stage, ok: true, rc: 0, ms: 0, detail: "", out: "", err: "" })).toContain(
                LABELS[stage],
            );
        }
    });

    test("汇总含每个阶段一行 + total", () => {
        const lines = summarize([okStage, badStage]);
        expect(lines[0]).toBe("");
        expect(lines[1]).toBe("--- summary ---");
        expect(lines[2]).toContain("bun check");
        expect(lines[3]).toContain("bun test");
        expect(lines[3]).toContain("FAIL");
        expect(lines[4]).toBe("  total 0.52s");
    });
});

// ---- 控制流：短路 -----------------------------------------------------------

/** 记录调用顺序的假 IO */
function fakeIO(): { io: GateIO; lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        io: {
            step: (t) => lines.push(`STEP ${t}`),
            log: (l) => lines.push(l),
            warn: (l) => lines.push(`WARN ${l}`),
        },
    };
}

function stageOk(stage: Stage, out = "", err = ""): StageResult {
    return { stage, ok: true, rc: 0, ms: 1, detail: "", out, err };
}

function stageFail(stage: Stage, out = "", err = ""): StageResult {
    return { stage, ok: false, rc: 1, ms: 1, detail: "boom", out, err };
}

function fakeDeps(
    overrides: Partial<Record<Stage, StageResult>>,
    packageJsonExists = true,
): { deps: GateDeps; io: GateIO; calls: Stage[]; lines: string[] } {
    const { io, lines } = fakeIO();
    const calls: Stage[] = [];
    const make = (stage: Stage) => async () => {
        calls.push(stage);
        return overrides[stage] ?? stageOk(stage);
    };
    return {
        io,
        lines,
        calls,
        deps: {
            io,
            hasPackageJson: async () => packageJsonExists,
            runner: {
                check: make("check"),
                test: make("test"),
                fmt: make("fmt"),
                pack: make("pack"),
            },
        },
    };
}

const ALL_ON: GateOptions = {
    clean: false,
    keepClone: false,
    skipTest: false,
    skipFmt: false,
    skipPack: false,
    verbose: false,
};

describe("runGate 的短路", () => {
    test("全绿时四个阶段都跑到，返回 true", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", ALL_ON, deps)).toBe(true);
        expect(calls).toEqual(["check", "test", "fmt", "pack"]);
    });

    test("check 失败 → 后面三个阶段一个都不跑", async () => {
        const { deps, calls } = fakeDeps({ check: stageFail("check") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check"]);
    });

    test("test 失败 → fmt 与 pack 都不跑", async () => {
        const { deps, calls } = fakeDeps({ test: stageFail("test") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "test"]);
    });

    test("fmt 失败 → pack 不跑", async () => {
        const { deps, calls } = fakeDeps({ fmt: stageFail("fmt") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "test", "fmt"]);
    });

    test("pack 失败 → 返回 false", async () => {
        const { deps, calls } = fakeDeps({ pack: stageFail("pack") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "test", "fmt", "pack"]);
    });

    test("--skip-pack 时 pack 根本不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipPack: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "test", "fmt"]);
    });

    test("--skip-fmt 时 fmt 根本不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipFmt: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "test", "pack"]);
    });

    test("--skip-test 时 test 与 pack 都不被调用，fmt 仍然跑", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipTest: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "fmt"]);
    });

    test("不是包根目录时直接判失败，一个阶段都不跑", async () => {
        const { deps, calls } = fakeDeps({}, false);
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("被跳过的阶段必须在日志里留痕", async () => {
        const { deps, lines } = fakeDeps({});
        await runGate("/x", { ...ALL_ON, skipPack: true }, deps);
        expect(lines.some((l) => l.includes("--skip-pack"))).toBe(true);
    });

    test("--skip-fmt 也要留痕，三个跳过各自独立一行", async () => {
        const { deps, lines } = fakeDeps({});
        await runGate("/x", { ...ALL_ON, skipFmt: true, skipPack: true }, deps);
        expect(lines.some((l) => l.includes("--skip-fmt"))).toBe(true);
        expect(lines.some((l) => l.includes("--skip-pack"))).toBe(true);
    });
});

// ---- 输出折叠与失败聚焦 -----------------------------------------------------

describe("runGate 的输出策略", () => {
    test("通过时不上报阶段的原始输出，只留结论行", async () => {
        const { deps, lines } = fakeDeps({
            test: stageOk("test", "", "(pass) 一\n(pass) 二\n"),
        });
        expect(await runGate("/x", ALL_ON, deps)).toBe(true);
        expect(lines.some((l) => l.includes("(pass)"))).toBe(false);
    });

    test("折叠的行数必须报出来 —— 静默吞输出等于隐瞒", async () => {
        const { deps, lines } = fakeDeps({
            test: stageOk("test", "", "(pass) 一\n(pass) 二\n"),
        });
        await runGate("/x", ALL_ON, deps);
        expect(lines).toContain("[output folded: 2 lines — rerun with --verbose to replay]");
    });

    test("--verbose 时通过阶段也完整回放", async () => {
        const { deps, lines } = fakeDeps({
            test: stageOk("test", "stdout 行\n", "(pass) x\n"),
        });
        await runGate("/x", { ...ALL_ON, verbose: true }, deps);
        expect(lines).toContain("stdout 行");
        expect(lines).toContain("WARN (pass) x");
    });

    test("失败时完整回放该阶段的原始输出", async () => {
        const { deps, lines } = fakeDeps({
            test: stageFail("test", "", "(pass) 一\n(fail) 目标\n"),
        });
        await runGate("/x", ALL_ON, deps);
        expect(lines).toContain("WARN (pass) 一");
        expect(lines).toContain("WARN (fail) 目标");
    });

    test("失败时先给 (fail) 聚焦段，再给完整回放", async () => {
        const { deps, lines } = fakeDeps({
            test: stageFail("test", "", "(pass) 一\n(fail) 目标用例 [0.1ms]\n"),
        });
        await runGate("/x", ALL_ON, deps);
        const focus = lines.findIndex((l) => l.includes("--- failed cases (1) ---"));
        const dump = lines.findIndex((l) => l.includes("--- bun test output ---"));
        expect(focus).toBeGreaterThan(-1);
        expect(dump).toBeGreaterThan(focus);
        expect(lines).toContain("  目标用例 [0.1ms]");
    });

    test("失败阶段的输出不计入「被折叠」", async () => {
        const { deps, lines } = fakeDeps({
            check: stageOk("check", "", "✓ No type errors in 38 files\n"),
            test: stageFail("test", "", "(fail) x\n"),
        });
        await runGate("/x", ALL_ON, deps);
        // 只有 check 那 1 行被折叠；阈值 > 1 所以不提示
        expect(lines.some((l) => l.includes("output folded"))).toBe(false);
    });

    test("失败时仍给出 summary，且已跑完的阶段保留结论行", async () => {
        const { deps, lines } = fakeDeps({ test: stageFail("test") });
        await runGate("/x", ALL_ON, deps);
        expect(lines).toContain("--- summary ---");
        expect(lines.some((l) => l.startsWith("  ok   bun check"))).toBe(true);
        expect(lines.some((l) => l.startsWith("  FAIL bun test"))).toBe(true);
    });
});

// ---- 入口 -------------------------------------------------------------------

describe("main 的帮助路径", () => {
    test("--help 返回 0，且不触碰任何阶段", async () => {
        expect(await main(["--help"], "/nonexistent")).toBe(0);
        expect(await main(["-Help"], "/nonexistent")).toBe(0);
    });
});

// ---- 仓库里没有 .ps1 ---------------------------------------------------------

const REPO = resolve(import.meta.dir, "..");
const SKIPPED_DIRS = new Set(["node_modules", "vendor", ".git", ".build", "dist"]);

function findPs1(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIPPED_DIRS.has(entry.name)) continue;
            findPs1(join(dir, entry.name), found);
        } else if (entry.name.toLowerCase().endsWith(".ps1")) {
            found.push(join(dir, entry.name));
        }
    }
    return found;
}

describe("仓库里没有 .ps1（第二段退役的前提）", () => {
    /**
     * 2026-10-21 两个签名脚本退役后，`.ps1` 语法校验从门禁里删掉了。
     * 删它的前提是「仓库里真的没有 `.ps1`」——而那段代码一删，就没有任何东西
     * 再检查这个前提了：新增一个 `.ps1` 会静静地无人校验，表现和「已经全部
     * 迁完」一模一样。
     *
     * 这条断言守的就是那个前提，写法与 `build.test.ts` 里「build.ps1 已不存在」
     * 同源。它变红时要做的决定是二选一：恢复语法校验阶段，或把那个文件改成
     * `.ts`。删掉这条断言不是选项——那等于把「没有 .ps1」从事实降级成记忆。
     */
    test("全仓 .ps1 数量为 0", () => {
        const relative = findPs1(REPO).map((p) => p.slice(REPO.length + 1).replaceAll("\\", "/"));
        expect(relative).toEqual([]);
    });
});

// ---- fmt 阶段必须带 --no-script ----------------------------------------------

describe("fmt 阶段的命令行形状（元测试）", () => {
    /**
     * 这条守的是一个**只在将来才会暴露**的失效。
     *
     * `bun fmt --check` 在 `package.json` 里存在 `fmt` script 时，会把整条命令
     * 转交给那个 script 并原样返回它的退出码——实测：script 只 `console.log` 一行，
     * `bun fmt --check` 就 exit 0 并输出那行字，一个文件都没检查。
     * 也就是说判据会静默退化成「那个 script 成功了吗」。
     *
     * 本仓当前没有 `fmt` script，所以现在去掉 `--no-script` 也照样是绿的。
     * 这正是必须用静态断言钉住它的理由：判据的失效点不在今天，
     * 在「某天有人加了一个 fmt script」的那一刻，而那时不会有任何东西变红。
     */
    test("runFmt 的 argv 含 --check 与 --no-script", async () => {
        const src = await Bun.file(join(REPO, "scripts", "gate.ts")).text();

        // 定位 runFmt 函数体：从 `async function runFmt` 到下一个顶层 async function
        const start = src.indexOf("async function runFmt");
        expect(start).toBeGreaterThan(-1);
        const rest = src.slice(start);
        const end = rest.indexOf("async function runPack");
        expect(end).toBeGreaterThan(-1);
        const body = rest.slice(0, end);

        expect(body).toContain('"fmt"');
        expect(body).toContain('"--check"');
        expect(body).toContain('"--no-script"');
    });

    test("**反向**：该判据能看见真实差异（拿一段去掉 --no-script 的样本自检）", () => {
        // 如果上面的断言对任何字符串都成立，它就等于没写。
        const stripped = 'await spawn([BUN, "fmt", "--check"], cwd);';
        expect(stripped.includes('"--no-script"')).toBe(false);
    });
});
