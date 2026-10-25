/**
 * probe-frameless-toggle.ts — 运行时形态切换（ADR 0019）的真机判据
 *
 * ## 它验什么
 *
 * `shell_set_frameless()` 的核心承诺：**不改样式位，只让 `WM_NCCALCSIZE` 不再拦截，
 * 再强制系统重算一次非客户区**，就能让带边框回来。这条承诺的全部证据是几何读数：
 *
 * ```text
 * frameless + 还原   win == client      客户区占满窗口
 * 切到带边框         win >  client      让出标题栏 + 边框
 * 切回无边框         win == client      必须逐像素回到初始值
 * ```
 *
 * 第三行是最要紧的一条：如果 `SWP_FRAMECHANGED` 少写、或者 `fit_widget` 没跟上，
 * 症状会是「切回来之后客户区比原来小一圈」——而只看前两行的话它是绿的。
 *
 * ## 为什么不用截图
 *
 * 「带边框生效了」在像素层表现为「窗口顶部多了一条灰带」，但那条带子的颜色随主题变，
 * 判据会跟着腐。几何读数不随主题变，且它正是 `WM_NCCALCSIZE` 直接作用的那个量。
 *
 * ## 前置
 *
 * 必须在**交互式桌面会话**里跑（要真起窗口）。它自己起窗、自己关窗，不碰用户的其它窗口，
 * 但会抢一次焦点。不是门禁。
 */
import {
    FLAG_FRAMELESS,
    FLAG_NATIVE_CAPTIONS,
    FLAG_RESIZABLE,
    openShell,
    serveOnSafePort,
} from "../src/shell/index";
import { debugOf } from "../src/shell/debug";

const HTML = `<!doctype html><meta charset="utf-8">
<title>frameless toggle probe</title>
<body style="margin:0;background:#202020;color:#eee;font:14px system-ui">
<h1 style="padding:24px">runtime frameless toggle</h1>
</body>`;

type Metrics = {
    pos: string;
    win: string;
    client: string;
    work: string;
    border: string;
};

/** 从 `debugOf().metrics()` 的定长串里取四个尺寸。取不到就抛，不返回半截读数。 */
function parseMetrics(raw: string): Metrics {
    const grab = (key: string): string => {
        const m = new RegExp(`${key}=(\\S+)`).exec(raw);
        if (!m?.[1]) throw new Error(`metrics 缺 ${key}：${JSON.stringify(raw)}`);
        return m[1];
    };
    return {
        pos: grab("pos"),
        win: grab("win"),
        client: grab("client"),
        work: grab("work"),
        border: grab("border"),
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = serveOnSafePort({
    hostname: "127.0.0.1",
    fetch: () => new Response(HTML, { headers: { "content-type": "text/html;charset=utf-8" } }),
});

const url = `http://127.0.0.1:${server.port}/`;
const shell = await openShell({
    url,
    title: "frameless toggle probe",
    width: 900,
    height: 600,
    flags: FLAG_FRAMELESS | FLAG_NATIVE_CAPTIONS | FLAG_RESIZABLE,
    appName: "baw-frameless-probe",
});

const rows: Array<{ step: string; ok: boolean; note: string }> = [];
const record = (step: string, ok: boolean, note: string) => {
    rows.push({ step, ok, note });
    console.log(`${ok ? "PASS" : "FAIL"}  ${step.padEnd(28)} ${note}`);
};

try {
    // 等首帧与 caption 子窗口建起来。不给固定 sleep 而是轮询 metrics 非空：
    // 固定 sleep 在慢机器上会读到「还没布局完」的 0x0，那是假红。
    let base: Metrics | null = null;
    for (let i = 0; i < 40; i++) {
        await sleep(100);
        const raw = debugOf(shell).metrics();
        if (raw === "") continue;
        base = parseMetrics(raw);
        break;
    }
    if (base === null) throw new Error("窗口 4 秒内没有给出 metrics");

    const initialFrameless = shell.isFrameless();
    record(
        "isFrameless() 初值",
        initialFrameless === true,
        `期望 true（创建期给了 FLAG_FRAMELESS），实际 ${initialFrameless}`,
    );

    record(
        "frameless + 还原",
        base.win === base.client,
        `win=${base.win} client=${base.client}（期望相等） border=${base.border}`,
    );

    // ---- 切到带边框 ----
    const rc1 = shell.setFrameless(false);
    record("setFrameless(false) rc", rc1 === 0, `rc=${rc1} err=${rc1 === 0 ? "" : shell.lastError()}`);
    await sleep(500);

    const framed = parseMetrics(debugOf(shell).metrics());
    const framedIsFramed = shell.isFrameless() === false;
    record("isFrameless() 切后", framedIsFramed, `期望 false，实际 ${shell.isFrameless()}`);
    record(
        "带边框后 win > client",
        framed.win !== framed.client,
        `win=${framed.win} client=${framed.client}（期望不等）`,
    );

    // ---- 切回无边框 ----
    const rc2 = shell.setFrameless(true);
    record("setFrameless(true) rc", rc2 === 0, `rc=${rc2}`);
    await sleep(500);

    const back = parseMetrics(debugOf(shell).metrics());
    record("isFrameless() 切回", shell.isFrameless() === true, `实际 ${shell.isFrameless()}`);
    record(
        "切回后 win == client",
        back.win === back.client,
        `win=${back.win} client=${back.client}`,
    );
    // 这一条防的是「切回来之后客户区悄悄小了一圈」：只判 win==client 的话，
    // 两边一起缩小照样绿。
    record(
        "切回后客户区与初始一致",
        back.client === base.client,
        `初始 client=${base.client} 切回 client=${back.client}`,
    );

    // ---- 幂等 ----
    const rc3 = shell.setFrameless(true);
    await sleep(200);
    const again = parseMetrics(debugOf(shell).metrics());
    record(
        "重复设同一形态是 no-op",
        rc3 === 0 && again.client === base.client,
        `rc=${rc3} client=${again.client}`,
    );
} catch (err) {
    record("探针自身", false, err instanceof Error ? err.message : String(err));
} finally {
    shell.close();
    await sleep(300);
    shell.stop();
    server.stop(true);
}

const failed = rows.filter((r) => !r.ok).length;
console.log(`\n汇总 ${rows.length - failed} PASS / ${failed} FAIL（共 ${rows.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
