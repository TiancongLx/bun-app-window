#!/usr/bin/env bun
/**
 * probe-window-events.ts — 窗口生命周期事件的端到端验收
 *
 * 单测能覆盖字节偏移与序号连续性，但覆盖不了「事件真的会被原生侧写进队列」。
 * 那件事只能开一个真窗口来验：最大化 → 宿主看到 `maximized`，还原 → 看到它清掉，
 * 关闭 → 看到 `CLOSED`。
 *
 * 两条路径都要跑：无边框模式走 `shell_wnd_proc`，带边框模式走 `toplevel_proc`
 * ——它们是两个不同的窗口过程，只验一条会让另一条静默失效（ADR 0016）。
 *
 * `about:blank` 没有 origin，导航守卫按「同文档」退化处理，适合当探针的启动地址。
 *
 *     bun run scripts/probe-window-events.ts
 *     bun run scripts/probe-window-events.ts --keep-open   # 不跑溢出段（窗口会疯狂最大化/还原）
 *
 * 约 8 秒。**不进默认门禁**：它要交互式桌面，与 `demo` 同类。
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */

import { resolveNativeLib } from "../src/shell/resolve";
import {
    EVENT_CLOSED,
    EVENT_QUEUE_CAPACITY,
    EVENT_STATE,
    attachEventPump,
    type StateEvent,
    type WindowEvent,
} from "../src/shell/events";
import { openShell, type Shell } from "../src/shell/index";
import { FLAG_CENTER, FLAG_FRAMELESS, FLAG_RESIZABLE } from "../src/shell/types";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
    results.push({ name, ok, detail: ok ? detail : detail || "failed" });
}

/**
 * 等一个「已被事件置位的标志」。
 *
 * 这不是轮询原生状态——判据是事件到达后置位的布尔值，而不是反复调 `getState()`
 * 问原生。二者差别正是本轮要证明的东西：宿主不必知道「多久问一次」。
 */
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (pred()) {
            return true;
        }
        await Bun.sleep(8);
    }
    return pred();
}

const isState = (e: WindowEvent): e is StateEvent => e.type === EVENT_STATE;

/** 一条完整的生命周期剧本 */
async function runCase(label: string, flags: number): Promise<void> {
    const shell: Shell = await openShell({
        url: "about:blank",
        title: `probe ${label}`,
        width: 900,
        height: 640,
        flags,
    });

    const seen: WindowEvent[] = [];
    let closed = false;
    const pump = attachEventPump(shell, { intervalMs: 8, keepAlive: true });
    pump.on((e) => {
        seen.push(e);
        if (e.type === EVENT_CLOSED) {
            closed = true;
        }
    });

    const states = (): StateEvent[] => seen.filter(isState);

    // 1. 首个 STATE 必须自己到达
    check(`${label}：启动后收到 STATE 事件`, await waitFor(() => states().length > 0, 3000), `${seen.length} 条`);

    // 2. 载荷是快照：尺寸与 DPI 必须是真的
    const initial = states().at(-1);
    check(
        `${label}：STATE 带非零尺寸与 DPI`,
        initial !== undefined && initial.width > 0 && initial.height > 0 && initial.dpi > 0,
        initial ? `${initial.width}x${initial.height} dpi=${initial.dpi}` : "无",
    );

    // 3. 最大化
    shell.toggleMaximize();
    check(`${label}：最大化后收到 maximized=true`, await waitFor(() => states().some((e) => e.maximized), 3000));

    // 4. 还原
    shell.toggleMaximize();
    check(
        `${label}：还原后收到 maximized=false`,
        await waitFor(() => {
            const last = states().at(-1);
            return last !== undefined && !last.maximized;
        }, 3000),
    );

    // 5. 关闭 → CLOSED。这是「可以 restart」的唯一判据
    shell.close();
    check(`${label}：关闭后收到 CLOSED`, await waitFor(() => closed, 5000));
    check(`${label}：CLOSED 之后事件泵自动停止`, !pump.running);
    check(`${label}：CLOSED 是最后一条`, seen.at(-1)?.type === EVENT_CLOSED);

    // 6. 拉取是消费式的：读过的不会再来
    check(`${label}：CLOSED 读走后队列为空`, shell.pollEvents().length === 0);
}

/**
 * 溢出：不拉取的情况下灌超过容量的状态变化。
 *
 * 判据是「一次最多拉回容量条数」+「保住的序号是新的」。缺口的具体条数不必精确——
 * toggle 投递到 UI 线程是异步的，实际产生多少条取决于消息循环，但一定超过容量。
 */
async function runOverflowCase(): Promise<void> {
    const shell: Shell = await openShell({
        url: "about:blank",
        title: "probe overflow",
        width: 640,
        height: 480,
        flags: FLAG_RESIZABLE,
    });

    // 先清空启动期产生的事件，让「首条序号」只反映溢出
    await Bun.sleep(120);
    shell.pollEvents();

    const rounds = EVENT_QUEUE_CAPACITY * 2;
    for (let i = 0; i < rounds; i++) {
        shell.toggleMaximize();
    }
    await Bun.sleep(1500);

    const drained = shell.pollEvents(EVENT_QUEUE_CAPACITY * 2);
    const seqs = drained.map((e) => e.seq);
    const first = seqs[0] ?? 0;
    const last = seqs.at(-1) ?? 0;

    check(
        "溢出：一次最多拉回容量条数",
        drained.length === EVENT_QUEUE_CAPACITY,
        `${drained.length} 条（容量 ${EVENT_QUEUE_CAPACITY}）`,
    );
    check(
        "溢出：拉回的序号连续递增",
        seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1),
    );
    // 丢最旧：首条序号远大于 1，说明前面那些被顶掉了，而最新的状态还在
    check("溢出：丢的是最旧（首条序号远大于 1）", first > 1, `首条 seq=${first}`);
    check("溢出：最新一条仍在", last >= first && last > 0, `末条 seq=${last}`);

    shell.close();
    check(
        "溢出：关闭后仍能拿到 CLOSED",
        await waitFor(() => shell.pollEvents().some((e) => e.type === EVENT_CLOSED), 5000),
    );
}

// ---- 主流程 ---------------------------------------------------------------

const keepOpen = process.argv.includes("--keep-open");

const info = await resolveNativeLib();
console.log(`native: ${info.source}  ${info.path}`);
console.log("");

await runCase("带边框", FLAG_RESIZABLE | FLAG_CENTER);
await Bun.sleep(150);
await runCase("无边框", FLAG_FRAMELESS | FLAG_RESIZABLE | FLAG_CENTER);
await Bun.sleep(150);

if (keepOpen) {
    console.log("--keep-open：跳过溢出段（它会连续 toggle 数百次）");
} else {
    await runOverflowCase();
}

const failed = results.filter((r) => !r.ok);
const width = results.reduce((w, r) => Math.max(w, r.name.length), 0);
for (const r of results) {
    const mark = r.ok ? "ok  " : "FAIL";
    const tail = r.detail ? `  ${r.detail}` : "";
    console.log(`  ${mark} ${r.name.padEnd(width)}${tail}`);
}

console.log("");
if (failed.length > 0) {
    console.log(`PROBE FAILED (${failed.length}/${results.length})`);
    process.exitCode = 1;
} else {
    console.log(`PROBE PASSED (${results.length} checks)`);
}
