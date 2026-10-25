/**
 * check-runner.ts — 判定原语，`release-sentinel.ts` 与 `release-verify.ts` 共用
 *
 * 两个脚本守的事完全不同（一个查本地六载体，一个查跨载体），但**输出形态必须
 * 一致**：同样一行一条结论、同样的 `PASS` / `FAIL` 前缀、同样的收尾统计。
 *
 * 为什么值得单独抽一个文件：两份实现会漂移，而漂移在这里的表现是**诊断信息的
 * 格式变掉**——「假红看起来和真红一样」，读的人就要多花一轮才能判断该不该继续。
 * 那点成本比省下的三十行高得多。
 */

export type CheckResult = { ok: boolean; detail: string };

export type Check = {
    /** 稳定标识，日志与 `--only` 按它定位 */
    id: string;
    /** 一句话结论 */
    title: string;
    run: () => Promise<CheckResult> | CheckResult;
};

export type Row = { id: string; title: string; ok: boolean; detail: string };

export type Runner = {
    rows: Row[];
    run: (check: Check) => Promise<boolean>;
    summary: () => { total: number; failed: number };
};

export function createRunner(): Runner {
    const rows: Row[] = [];
    let failed = 0;

    async function run(check: Check): Promise<boolean> {
        let result: CheckResult;
        try {
            result = await check.run();
        } catch (err) {
            // 判据自己崩了也必须产出一行结论：静默的检查比失败的检查更危险
            result = { ok: false, detail: `检查自身抛错：${err instanceof Error ? err.message : String(err)}` };
        }
        rows.push({ id: check.id, ...result, title: check.title });
        console.log(`${result.ok ? "PASS" : "FAIL"}  ${check.title.padEnd(38)} ${result.detail}`);
        if (!result.ok) failed += 1;
        return result.ok;
    }

    return { rows, run, summary: () => ({ total: rows.length, failed }) };
}
