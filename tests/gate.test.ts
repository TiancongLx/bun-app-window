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
        skipPack: false,
        verbose: false,
    };

    test("默认三个阶段，顺序固定", () => {
        expect(planStages(base)).toEqual(["check", "test", "pack"]);
    });

    test("--skip-test 连带跳过 pack（行为层的两段一起走）", () => {
        expect(planStages({ ...base, skipTest: true })).toEqual(["check"]);
    });

    test("--skip-pack 只砍掉最后一段", () => {
        expect(planStages({ ...base, skipPack: true })).toEqual(["check", "test"]);
    });

    test("--clean 不影响阶段组成（它改的是运行位置）", () => {
        expect(planStages({ ...base, clean: true })).toEqual(["check", "test", "pack"]);
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
                pack: make("pack"),
            },
        },
    };
}

const ALL_ON: GateOptions = {
    clean: false,
    keepClone: false,
    skipTest: false,
    skipPack: false,
    verbose: false,
};

describe("runGate 的短路", () => {
    test("全绿时三个阶段都跑到，返回 true", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", ALL_ON, deps)).toBe(true);
        expect(calls).toEqual(["check", "test", "pack"]);
    });

    test("check 失败 → 后面两个阶段一个都不跑", async () => {
        const { deps, calls } = fakeDeps({ check: stageFail("check") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check"]);
    });

    test("test 失败 → pack 不跑", async () => {
        const { deps, calls } = fakeDeps({ test: stageFail("test") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "test"]);
    });

    test("pack 失败 → 返回 false", async () => {
        const { deps, calls } = fakeDeps({ pack: stageFail("pack") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "test", "pack"]);
    });

    test("--skip-pack 时 pack 根本不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipPack: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "test"]);
    });

    test("--skip-test 时 test 与 pack 都不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipTest: true }, deps)).toBe(true);
        expect(calls).toEqual(["check"]);
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
