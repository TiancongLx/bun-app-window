import { describe, expect, test } from "bun:test";

import {
    LABELS,
    type GateDeps,
    type GateIO,
    type GateOptions,
    type RunResult,
    type Stage,
    type StageResult,
    checkedFileCount,
    formatStage,
    main,
    normalizeArg,
    parseGateArgs,
    parsePackSummary,
    parsePs1Summary,
    parseTestCounts,
    planStages,
    runGate,
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

describe("parsePackSummary", () => {
    test("取最后一行 VERIFY-PACK 结论", () => {
        const out = [
            "  ok   tarball 非空   19 个文件",
            "VERIFY-PACK FAILED (2/7)",
            "verify-pack: something went wrong",
            "",
        ].join("\n");
        expect(parsePackSummary({ code: 1, out, err: "" })).toBe(
            "verify-pack: something went wrong",
        );
    });

    test("没有结论行时返回空串", () => {
        expect(parsePackSummary({ code: 0, out: "random output", err: "" })).toBe("");
    });
});

describe("parsePs1Summary", () => {
    test("取 PS1 SYNTAX 行", () => {
        expect(
            parsePs1Summary({ code: 0, out: "PS1 SYNTAX OK (18 files)", err: "" }),
        ).toBe("PS1 SYNTAX OK (18 files)");
        expect(
            parsePs1Summary({ code: 1, out: "x.ps1:3: missing }\nPS1 SYNTAX FAILED (1 errors in 1 files)", err: "" }),
        ).toBe("PS1 SYNTAX FAILED (1 errors in 1 files)");
    });
});

// ---- 阶段编排 ---------------------------------------------------------------

describe("planStages", () => {
    const base: GateOptions = { clean: false, keepClone: false, skipTest: false, skipPack: false };

    test("默认四个阶段，顺序固定", () => {
        expect(planStages(base)).toEqual(["check", "ps1", "test", "pack"]);
    });

    test("--skip-test 连带跳过 pack（行为层的两段一起走）", () => {
        expect(planStages({ ...base, skipTest: true })).toEqual(["check", "ps1"]);
    });

    test("--skip-pack 只砍掉最后一段", () => {
        expect(planStages({ ...base, skipPack: true })).toEqual(["check", "ps1", "test"]);
    });

    test("--clean 不影响阶段组成（它改的是运行位置）", () => {
        expect(planStages({ ...base, clean: true })).toEqual(["check", "ps1", "test", "pack"]);
    });
});

// ---- 输出格式 ---------------------------------------------------------------

describe("formatStage / summarize", () => {
    const okStage: StageResult = { stage: "check", ok: true, rc: 0, ms: 90, detail: "27 files" };
    const badStage: StageResult = { stage: "test", ok: false, rc: 1, ms: 430, detail: "1 fail" };

    test("通过行带耗时与细节", () => {
        expect(formatStage(okStage)).toBe("bun check ok (0.1s) — 27 files");
    });

    test("失败行带 rc", () => {
        expect(formatStage(badStage)).toBe("bun test FAILED (rc=1, 0.4s) — 1 fail");
    });

    test("每个阶段都有标签，不会打出 undefined", () => {
        for (const stage of Object.keys(LABELS) as Stage[]) {
            expect(formatStage({ stage, ok: true, rc: 0, ms: 0, detail: "" })).toContain(
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

function stageOk(stage: Stage): StageResult {
    return { stage, ok: true, rc: 0, ms: 1, detail: "" };
}

function stageFail(stage: Stage): StageResult {
    return { stage, ok: false, rc: 1, ms: 1, detail: "boom" };
}

function fakeDeps(
    overrides: Partial<Record<Stage, StageResult>>,
    packageJsonExists = true,
): { deps: GateDeps; io: GateIO; calls: Stage[] } {
    const { io } = fakeIO();
    const calls: Stage[] = [];
    const make = (stage: Stage) => async () => {
        calls.push(stage);
        return overrides[stage] ?? stageOk(stage);
    };
    return {
        io,
        calls,
        deps: {
            io,
            hasPackageJson: async () => packageJsonExists,
            runner: {
                check: make("check"),
                ps1: make("ps1"),
                test: make("test"),
                pack: make("pack"),
            },
        },
    };
}

const ALL_ON: GateOptions = { clean: false, keepClone: false, skipTest: false, skipPack: false };

describe("runGate 的短路", () => {
    test("全绿时四个阶段都跑到，返回 true", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", ALL_ON, deps)).toBe(true);
        expect(calls).toEqual(["check", "ps1", "test", "pack"]);
    });

    test("check 失败 → 后面三个阶段一个都不跑", async () => {
        const { deps, calls } = fakeDeps({ check: stageFail("check") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check"]);
    });

    test(".ps1 语法失败 → 停在第二段", async () => {
        const { deps, calls } = fakeDeps({ ps1: stageFail("ps1") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "ps1"]);
    });

    test("test 失败 → pack 不跑", async () => {
        const { deps, calls } = fakeDeps({ test: stageFail("test") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "ps1", "test"]);
    });

    test("pack 失败 → 返回 false", async () => {
        const { deps, calls } = fakeDeps({ pack: stageFail("pack") });
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual(["check", "ps1", "test", "pack"]);
    });

    test("--skip-pack 时 pack 根本不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipPack: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "ps1", "test"]);
    });

    test("--skip-test 时 test 与 pack 都不被调用", async () => {
        const { deps, calls } = fakeDeps({});
        expect(await runGate("/x", { ...ALL_ON, skipTest: true }, deps)).toBe(true);
        expect(calls).toEqual(["check", "ps1"]);
    });

    test("不是包根目录时直接判失败，一个阶段都不跑", async () => {
        const { deps, calls } = fakeDeps({}, false);
        expect(await runGate("/x", ALL_ON, deps)).toBe(false);
        expect(calls).toEqual([]);
    });

    test("被跳过的阶段必须在日志里留痕", async () => {
        const { deps, io } = fakeDeps({});
        const { lines } = fakeIO();
        void lines;
        const captured: string[] = [];
        const depsWithCapture: GateDeps = {
            ...deps,
            io: { ...io, log: (l) => captured.push(l) },
        };
        await runGate("/x", { ...ALL_ON, skipPack: true }, depsWithCapture);
        expect(captured.some((l) => l.includes("--skip-pack"))).toBe(true);
    });
});

// ---- 入口 -------------------------------------------------------------------

describe("main 的帮助路径", () => {
    test("--help 返回 0，且不触碰任何阶段", async () => {
        expect(await main(["--help"], "/nonexistent")).toBe(0);
        expect(await main(["-Help"], "/nonexistent")).toBe(0);
    });
});
