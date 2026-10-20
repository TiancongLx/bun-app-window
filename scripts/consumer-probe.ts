/**
 * consumer-probe.ts — 在「已安装的 tarball」里跑一遍公开 API
 *
 * 由 `scripts/verify-pack.ts` 复制进临时消费方工程执行；在本仓库内也能直接跑，
 * 此时靠包名自引用解析到 `src/`。两条路径都必须通过——否则说明导出面与源码已经
 * 分道扬镳，而这正是仓库内 `bun test` 看不见的那种故障。
 *
 * 纪律：只用公开入口，不出现任何相对路径导入。这里一旦写 `./` 或 `../`，
 * 就从「消费方验收」退化成「又跑了一遍单元测试」。
 *
 *     bun run scripts/consumer-probe.ts                              # 仓库内（源码路径）
 *     bun run probe.ts --expect-source package                       # 安装态
 *
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */

import pkg from "bun-app-window/package.json";

import {
    BROWSER_UI_ALL,
    FLAG_CENTER,
    FLAG_FRAMELESS,
    FLAG_RESIZABLE,
    RESIZE_EDGE,
    STATE_FOCUSED,
    createShell,
    isRestrictedPort,
    openShell,
    serveOnSafePort,
} from "bun-app-window";
import { debugOf } from "bun-app-window/debug";
import { embeddedDll, embeddedDllPath } from "bun-app-window/embedded";
import {
    EVENT_CLOSED,
    EVENT_QUEUE_CAPACITY,
    EVENT_RECORD_BYTES,
    EVENT_STATE,
    EventCursor,
    decodeEvents,
} from "bun-app-window/events";
import { connect, createIpcServer } from "bun-app-window/ipc";
import type { Channel } from "bun-app-window/ipc";
import nativeLibPath from "bun-app-window/native" with { type: "file" };
import { parseBounds, parsePlacement } from "bun-app-window/state";
import { DEFAULT_APP_FLAGS, buildAppUrl, decideWs } from "bun-app-window/app";
import { glyphFor, labelFor, titleBarCss } from "bun-app-window/titlebar";

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
    results.push({ name, ok, detail: ok ? detail : detail || "failed" });
}

function equal<T>(name: string, actual: T, expected: T): void {
    const ok = Object.is(actual, expected);
    check(name, ok, ok ? "" : `expected ${String(expected)}, got ${String(actual)}`);
}

function argValue(flag: string): string | null {
    const argv = process.argv.slice(2);
    const at = argv.indexOf(flag);
    return at >= 0 ? (argv[at + 1] ?? null) : null;
}

// ---- 1. 包清单与导出面 -------------------------------------------------------

const meta = pkg as unknown as Record<string, unknown>;
equal("package.json 子路径的 name", meta["name"], "bun-app-window");
equal("package.json 的 os 限制为 win32", JSON.stringify(meta["os"]), '["win32"]');
equal("package.json 的 cpu 限制为 x64", JSON.stringify(meta["cpu"]), '["x64"]');

const exportsMap = (meta["exports"] ?? {}) as Record<string, unknown>;
const expectedSubpaths = [
    ".",
    "./app",
    "./events",
    "./embedded",
    "./debug",
    "./state",
    "./ipc",
    "./titlebar",
    "./native",
    "./package.json",
];
const missingSubpaths = expectedSubpaths.filter((k) => !(k in exportsMap));
check(
    "exports 覆盖全部已文档化的子路径",
    missingSubpaths.length === 0,
    missingSubpaths.length === 0 ? "" : `missing: ${missingSubpaths.join(", ")}`,
);

// ---- 2. 主入口形状 -----------------------------------------------------------

check("主入口导出 createShell", typeof createShell === "function");
check("主入口导出 openShell", typeof openShell === "function");
check("主入口导出 serveOnSafePort", typeof serveOnSafePort === "function");
check("主入口导出 isRestrictedPort", typeof isRestrictedPort === "function");
equal("FLAG_FRAMELESS 取值", FLAG_FRAMELESS, 1);
equal("FLAG_CENTER 取值", FLAG_CENTER, 4);
equal("RESIZE_EDGE.LEFT 与 Win32 HTLEFT 一致", RESIZE_EDGE.LEFT, 10);
equal("STATE_FOCUSED 取值", STATE_FOCUSED, 4);
equal("BROWSER_UI_ALL 覆盖五位", BROWSER_UI_ALL, 1 | 2 | 4 | 8 | 16);

// ---- 3. 原生库：真的能定位、真的是 PE ----------------------------------------

check(
    "bun-app-window/native 解析为 libshell dll",
    /libshell.*\.dll$/i.test(nativeLibPath),
    nativeLibPath,
);
const dllFile = Bun.file(nativeLibPath);
check("native 子路径指向的文件存在", await dllFile.exists());

const dllBytes = new Uint8Array(await dllFile.arrayBuffer());
check("native 子路径指向的是 PE 映像", dllBytes[0] === 0x4d && dllBytes[1] === 0x5a);

// ---- 4. embedded：非编译产物下必须优雅为空 -----------------------------------

check("embeddedDllPath 指回包的 dist 目录", /[\\/]dist[\\/]libshell\.dll$/i.test(embeddedDllPath), embeddedDllPath);
equal("embeddedDll() 在非编译产物下返回 null", await embeddedDll(), null);

// ---- 5. createShell：解析来源必须与实际安装形态一致 --------------------------

const expectSource = argValue("--expect-source") ?? "dev";
const shell = await createShell({ url: "http://127.0.0.1:1/" });

equal("libInfo.source 与运行形态一致", shell.libInfo.source, expectSource);
check("libInfo.path 指向已加载的 DLL", /libshell.*\.dll$/i.test(shell.libInfo.path), shell.libInfo.path);
check(
    "libInfo.bytes 与磁盘上的文件大小一致",
    shell.libInfo.bytes === dllFile.size,
    `${shell.libInfo.bytes} vs ${dllFile.size}`,
);
check(
    "sha256 只在 embedded 分支计算，其余分支不谎报",
    expectSource === "embedded" ? shell.libInfo.sha256.length === 64 : shell.libInfo.sha256 === "",
    `source=${expectSource} sha256=${shell.libInfo.sha256}`,
);
equal("dlopen 后并未自动开窗（started）", shell.started, false);
equal("未启动时 isAlive() 为 false", shell.isAlive(), false);
equal("未启动时 pollEvents() 返回空数组", shell.pollEvents().length, 0);
equal("未启动时 lastError() 为空串", shell.lastError(), "");

const idle = shell.state();
check(
    "未启动时 state() 全为 false",
    !idle.maximized && !idle.minimized && !idle.focused && idle.raw === 0,
    JSON.stringify(idle),
);

// ---- 6. debug：排障面可用 ----------------------------------------------------

const dbg = debugOf(shell);
check("debugOf 提供五个排障口径", [
    dbg.hittest(0, 0),
    dbg.metrics(),
    dbg.dpi(),
    dbg.selfBase(),
    dbg.selfPath(),
].every((v) => v !== undefined));
check("debugOf.selfPath 指向同一份 DLL", dbg.selfPath().toLowerCase() === shell.libInfo.path.toLowerCase(), dbg.selfPath());

shell.stop();

// ---- 7. ipc：一次完整的请求/回复与事件推送 -----------------------------------

const ipc = createIpcServer({
    service: {
        greet: (name: string) => `hi ${name}`,
        fail: () => {
            throw new Error("boom");
        },
    },
});

let toClient: ((data: string) => void) | null = null;
const peer = {
    send(data: string): void {
        toClient?.(data);
    },
};
ipc.attach(peer);

const channel: Channel = {
    send: (data) => {
        void ipc.handle(peer, data);
    },
    close: () => {
        ipc.detach(peer);
    },
    onMessage: (fn) => {
        toClient = fn;
    },
    onClose: () => {},
};

type Api = { greet(name: string): string; fail(): void };

const api = await connect<Api>({ channel });
equal("ipc 请求/回复往返", await api.greet("baw"), "hi baw");
equal("ipc 未知方法拒绝", await api.fail().then(() => "resolved", (e: Error) => e.message), "boom");

let pushed: unknown = null;
api.on("tick", (payload) => {
    pushed = payload;
});
equal("ipc 事件已投递给已登记连接", ipc.emit("tick", { n: 7 }), 1);
equal("ipc 事件载荷原样到达", JSON.stringify(pushed), '{"n":7}');
api.close();

// ---- 8. state：外部输入的形状校验 --------------------------------------------

const bounds = parseBounds("10,20,1024,768,1,144");
equal("state.parseBounds 解析六字段", JSON.stringify(bounds), '{"x":10,"y":20,"width":1024,"height":768,"maximized":true,"dpi":144}');
equal("state.parseBounds 拒绝残缺输入", parseBounds("10,20"), null);
equal("state.parsePlacement 拒绝越界尺寸", parsePlacement({ x: 0, y: 0, width: 99999, height: 768, dpi: 96 }), null);

// ---- 9. titlebar：纯函数与样式 ----------------------------------------------

equal("titlebar.glyphFor 最大化状态取还原字形", glyphFor("unicode", "maximize", true), "\u2750");
equal("titlebar.labelFor 随状态变化", labelFor("maximize", true), "向下还原");
check("titlebar.titleBarCss 暴露 CSS 变量", titleBarCss().includes("--ws-tb-height"));

// ---- 10. port：安全端口绑定 -------------------------------------------------

const server = serveOnSafePort({
    fetch: () => new Response("ok"),
});
const boundPort = server.port ?? 0;
check(
    "serveOnSafePort 绑定在 40000–60000 且非受限端口",
    boundPort >= 40000 && boundPort <= 60000 && !isRestrictedPort(boundPort),
    `port=${boundPort}`,
);
equal("serveOnSafePort 的 fetch 可达", await (await fetch(`http://127.0.0.1:${boundPort}/`)).text(), "ok");
server.stop(true);

// ---- 11. app：应用骨架 -------------------------------------------------------

// 只测纯函数。`createApp` 本身要开窗，探针在无桌面环境下跑会挂。
equal("app.DEFAULT_APP_FLAGS 不含无边框位", DEFAULT_APP_FLAGS & FLAG_FRAMELESS, 0);
equal("app.DEFAULT_APP_FLAGS 含可缩放", DEFAULT_APP_FLAGS & FLAG_RESIZABLE, FLAG_RESIZABLE);
check(
    "app.buildAppUrl 拼出带 token 的回环地址",
    /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f-]{36}$/.test(buildAppUrl(45678, "11111111-2222-3333-4444-555555555555")),
    buildAppUrl(45678, "11111111-2222-3333-4444-555555555555"),
);
equal("app.decideWs 非 /ws 交回默认处理", decideWs("/", null, "k", true), "not-ws");
equal("app.decideWs 未开 ipc 时 404", decideWs("/ws", "k", "k", false), "ipc-disabled");
equal("app.decideWs token 不符拒绝", decideWs("/ws", "x", "k", true), "forbidden");
equal("app.decideWs token 相符升级", decideWs("/ws", "k", "k", true), "upgrade");

// ---- 12. events：窗口生命周期事件（解码与游标） -------------------------------

equal("events.EVENT_RECORD_BYTES 与原生 EventRecord 一致", EVENT_RECORD_BYTES, 32);
equal("events.EVENT_QUEUE_CAPACITY 与原生环一致", EVENT_QUEUE_CAPACITY, 128);
equal("events.EVENT_STATE 取值", EVENT_STATE, 1);
equal("events.EVENT_CLOSED 取值", EVENT_CLOSED, 2);

// 手拼一条记录：这是「TS 侧偏移与原生布局对齐」唯一能离线验的判据
const rec = new Uint8Array(EVENT_RECORD_BYTES);
const recView = new DataView(rec.buffer);
recView.setUint32(0, 7, true); // seq
recView.setUint32(4, EVENT_STATE, true); // type
recView.setInt32(8, 800, true); // 宽
recView.setInt32(12, 600, true); // 高
recView.setInt32(16, 96, true); // dpi
recView.setUint32(24, 1 | 8, true); // maximized | dark
const decoded = decodeEvents(rec, 1)[0];
equal(
    "events.decodeEvents 按偏移解出状态位与尺寸",
    JSON.stringify(decoded),
    '{"type":1,"seq":7,"width":800,"height":600,"dpi":96,"maximized":true,"minimized":false,"focused":false,"dark":true}',
);

const cursor = new EventCursor();
// 新建游标的首条不是 1，说明前面有丢弃（宿主从未读过）
equal("events.EventCursor 首条非 1 报出缺口", cursor.push([decoded!]).gaps[0], 6);
equal("events.EventCursor 记下最新序号", cursor.seq, 7);
equal("events.EventCursor 连续事件不报缺口", cursor.push([{ ...decoded!, seq: 8 }]).gaps.length, 0);
equal("events.EventCursor 断档时报出丢了多少条", cursor.push([{ ...decoded!, seq: 11 }]).gaps[0], 2);

// ---- 汇总 -------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const width = results.reduce((w, r) => Math.max(w, r.name.length), 0);
for (const r of results) {
    const mark = r.ok ? "ok  " : "FAIL";
    const tail = r.detail ? `  ${r.detail}` : "";
    console.log(`  ${mark} ${r.name.padEnd(width)}${tail}`);
}

if (failed.length > 0) {
    console.log("");
    console.log(`PROBE FAILED (${failed.length}/${results.length})`);
    process.exit(1);
}

console.log("");
console.log(`PROBE PASSED (${results.length} checks, source=${expectSource})`);
