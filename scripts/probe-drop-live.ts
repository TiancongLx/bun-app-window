/**
 * 拖放探针（交互式）：验证「真实拖放 → DOM drop → `AdditionalObjects` → 完整路径」，
 * 覆盖**文件**与**目录**两种载荷。
 *
 * 与 `probe-drop.ts` 是姊妹篇，分工明确：
 *
 * - `probe-drop.ts`：合成 `WM_DROPFILES`，守**兜底**链（`handle_drop` → `DragFinish`）。
 * - 本探针：**真实拖放**，守**主路**（`get_AdditionalObjects` → `get_Path`）。
 *
 * ## 为什么必须人手
 *
 * `AdditionalObjects` 里的对象只能由真实拖放产生。页面 JS 造不出带真实路径的
 * `File`（`new File` 的路径是空的），`keybd_event` 也做不到「按住鼠标跨进程拖」。
 * 所以这一步合成输入覆盖不了——人的动作只有一次：把文件或文件夹从资源管理器拖进窗口。
 *
 * ## 「什么都没发生」有四种原因，外部表现一模一样
 *
 * 这个探针的全部设计就是把这四种分开，否则一次失败只能得到「没反应」三个字：
 *
 * | 观测 | 结论 |
 * | --- | --- |
 * | `inject=OFF` | 注入脚本没跑到页面（`FLAG_ACCEPT_DROP` 没传 / `kInit` 拼接丢了） |
 * | 一条 drag 事件都没有 | OLE 在 OS 层就被挡了（典型：宿主比拖放源**完整性级别高**，UIPI 在 `DoDragDrop` 里拒绝） |
 * | 有 `dragenter` 但 `dropEffect=none` | 落点没被接受——`preventDefault` 之外还缺 `dropEffect` |
 * | 有 `drop` 但没 `/report` | 事件到了，路径没取到（`AdditionalObjects` 空 / 投递 API 用错） |
 *
 * ## 目录与文件的区别
 *
 * WebView2 支持的 DOM 对象只有 `File` 与 `FileSystemHandle` 两种，**目录只能是后者**
 * （`FileSystemDirectoryHandle`）。所以注入脚本走
 * `dataTransfer.items[i].getAsFileSystemHandle()`，宿主侧 `get_Kind` 判目录，
 * `shell-msg` 里多一个 `dirs` 字段（`paths` 是全部路径，`dirs` 是其中的目录子集）。
 *
 * 本探针同时验两条：`--file` 判文件、`--dir` 判目录。都不给时只判「拿到了绝对路径」。
 *
 * ## 用法
 *
 * ```text
 * bun run scripts/probe-drop-live.ts                        # 拖任意文件
 * bun run scripts/probe-drop-live.ts --file <path>          # 只认这个文件
 * bun run scripts/probe-drop-live.ts --dir <path>           # 只认这个目录
 * bun run scripts/probe-drop-live.ts --timeout 120          # 等人拖的秒数（默认 90）
 * ```
 *
 * **不进默认门禁**：`scripts/gate.ts` 不跑它，`AGENTS.md` §4 登记为人工探针。
 *
 * **必须在非提权的桌面会话里跑**：OTT 承载在 `RunLevel Highest` 的登录任务里，它的
 * 子进程全是 High 完整性，而资源管理器是 Medium —— 那样拖放会被 UIPI 拒掉，与代码
 * 无关。用计划任务 `RunLevel Limited` 拿到「完整但非提权」令牌来跑本探针。
 */

import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { FLAG_ACCEPT_DROP, FLAG_CENTER, FLAG_RESIZABLE, openShell } from "../src/shell/index.ts";
import { serveOnSafePort } from "../src/shell/port.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
    checks.push({ name, ok, detail });
}

type Args = { file: string | null; dir: string | null; timeoutSec: number };

function parseArgs(argv: string[]): Args {
    let file: string | null = null;
    let dir: string | null = null;
    let timeoutSec = 90;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--file") {
            file = resolve(argv[i + 1] ?? "");
            i += 1;
        } else if (arg === "--dir") {
            dir = resolve(argv[i + 1] ?? "");
            i += 1;
        } else if (arg === "--timeout") {
            timeoutSec = Number(argv[i + 1] ?? "90");
            i += 1;
        } else if (arg === "--help" || arg === "-h") {
            console.log("用法：bun run scripts/probe-drop-live.ts [--file <path>] [--dir <path>] [--timeout <秒>]");
            process.exit(0);
        }
    }
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        throw new Error("--timeout 必须是正数");
    }
    return { file, dir, timeoutSec };
}

const { file: targetFile, dir: targetDir, timeoutSec } = parseArgs(Bun.argv.slice(2));

// `--file` 与 `--dir` 是**互斥**的：一次只验一个目标。
// 同时给两个会让判据自相矛盾——只拖了一个，另一个必然「没找到」，
// 那条 FAIL 指向的是探针配置，不是产品缺陷（2026-10-21 实际踩到）。
if (targetFile && targetDir) {
    console.error("--file 与 --dir 只能给一个：一次验一个目标。");
    process.exit(2);
}

/**
 * 页面脚本。
 *
 * 只做五件事：报到（带注入标记）、回 ping、每次 drag 事件首次出现时报一声、
 * 把 `effectAllowed` / `dropEffect` 报上来、把 drop 的 paths / dirs 原样 `fetch` 回来。
 *
 * **不在这里做任何 drop 处理，也不设 `dropEffect`**——那会掩盖「注入脚本有没有
 * 干活」，而这一点正是要观测的对象。判据侧必须看到壳层实际发出的字节。
 *
 * 事件只挂 **capture 一份**。上一版 capture + 冒泡各挂一次，计数翻了一倍
 * （`dragenter=2` 其实是 1 次），读数直接把人带偏。
 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>probe-drop-live</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; background: #1b1b1f; color: #e6e6ea;
    font: 15px/1.6 "Segoe UI", system-ui, sans-serif;
  }
  #hint { font-size: 21px; }
  #step { color: #8a8a93; font-size: 13px; }
  #counts, #dt { color: #f6c177; font-family: Consolas, monospace; font-size: 12px; }
  #log { max-width: 92%; white-space: pre-wrap; word-break: break-all;
         color: #9ae6b4; font-family: Consolas, monospace; font-size: 13px; }
</style>
</head>
<body>
  <div id="hint">把文件或文件夹拖进这个窗口</div>
  <div id="step">等待页面脚本…</div>
  <div id="counts"></div>
  <div id="dt"></div>
  <pre id="log"></pre>
<script>
  var step = document.getElementById('step');
  var log = document.getElementById('log');
  var counts = document.getElementById('counts');
  var dtEl = document.getElementById('dt');
  var inject = !!window.__shellDropReady;
  var n = { dragenter: 0, dragover: 0, dragleave: 0, drop: 0 };
  var last = { effectAllowed: '-', dropEffect: '-' };
  function paint() {
    counts.textContent = 'inject=' + (inject ? 'on' : 'OFF') +
      '   dragenter=' + n.dragenter + '  dragover=' + n.dragover +
      '  dragleave=' + n.dragleave + '  drop=' + n.drop;
    dtEl.textContent = 'effectAllowed=' + last.effectAllowed +
      '  dropEffect=' + last.dropEffect;
  }
  function report(kind, extra) {
    fetch('/drag?kind=' + kind + (extra || ''));
  }
  paint();
  window.addEventListener('dragenter', function (e) {
    n.dragenter += 1;
    if (e.dataTransfer) { last.effectAllowed = e.dataTransfer.effectAllowed; }
    paint();
    if (n.dragenter === 1) { report('dragenter'); }
  }, true);
  window.addEventListener('dragover', function (e) {
    n.dragover += 1;
    if (e.dataTransfer) {
      last.effectAllowed = e.dataTransfer.effectAllowed;
      last.dropEffect = e.dataTransfer.dropEffect;
    }
    paint();
    if (n.dragover === 1 || n.dragover === 20) {
      report('dragover', '&n=' + n.dragover +
        '&ea=' + encodeURIComponent(last.effectAllowed) +
        '&de=' + encodeURIComponent(last.dropEffect));
    }
  }, true);
  window.addEventListener('dragleave', function () {
    n.dragleave += 1;
    paint();
    if (n.dragleave === 1) { report('dragleave'); }
  }, true);
  window.addEventListener('drop', function (e) {
    n.drop += 1;
    var dt = e.dataTransfer;
    var nf = (dt && dt.files) ? dt.files.length : -1;
    var ni = (dt && dt.items) ? dt.items.length : -1;
    paint();
    step.textContent = 'drop 到了，files=' + nf + ' items=' + ni + '，等待宿主回报';
    report('drop', '&files=' + nf + '&items=' + ni);
  }, true);
  window.addEventListener('shell-msg', function (e) {
    var m = e.detail || {};
    if (m.t === 'drop') {
      var paths = m.paths || [];
      var dirs = m.dirs || [];
      log.textContent = 'paths=' + JSON.stringify(paths) + '\\n' +
        'dirs=' + JSON.stringify(dirs);
      step.textContent = '已上报，探针会在几秒内退出';
      // 把注入脚本那几个标记**随 report 一起**带上去。不能另发一条延迟请求：
      // 宿主收到 /report 就关窗口，后发的那条会随页面一起消失，判据于是永远红。
      fetch('/report?paths=' + encodeURIComponent(JSON.stringify(paths)) +
        '&dirs=' + encodeURIComponent(JSON.stringify(dirs)) +
        '&raw=' + encodeURIComponent(JSON.stringify(m)) +
        '&ok=' + (window.__shellDropPosted ? 1 : 0) +
        '&via=' + encodeURIComponent(window.__shellDropVia || '') +
        '&err=' + encodeURIComponent(window.__shellDropError || ''));
      return;
    }
    if (m.t === 'ping') {
      step.textContent = '通道打通，等待拖放';
      fetch('/hello');
    }
  });
  fetch('/ready?inject=' + (inject ? 1 : 0));
</script>
</body>
</html>`;

let readyDone = false;
let injectOn = false;
let helloDone = false;
/** 注入脚本里的投递是否成功返回过（页面回报）。 */
let postedOk = false;
/** 投递走的是哪条路：`handles` / `files`。 */
let postedVia = "";
/** 投递抛错的 message；空串表示没抛。 */
let postError = "";
/** 页面收到 drop 时 `dataTransfer.files.length`；-1 表示 drop 还没来。 */
let dropFileCount = -1;
/** 页面收到 drop 时 `dataTransfer.items.length`；-1 表示 drop 还没来。 */
let dropItemCount = -1;
const dragSeen = new Set<string>();
let effectAllowed = "-";
let dropEffect = "-";

type Report = { paths: string[]; dirs: string[] };
let resolveReport: ((r: Report) => void) | null = null;
const reported = new Promise<Report>((res) => {
    resolveReport = res;
});

const server = serveOnSafePort({
    fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
            return new Response(PAGE, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }
        if (url.pathname === "/ready") {
            injectOn = url.searchParams.get("inject") === "1";
            onReady();
            return new Response("ok");
        }
        if (url.pathname === "/hello") {
            helloDone = true;
            return new Response("ok");
        }
        if (url.pathname === "/drag") {
            const kind = url.searchParams.get("kind") ?? "?";
            const n = url.searchParams.get("n");
            const ea = url.searchParams.get("ea");
            const de = url.searchParams.get("de");
            const files = url.searchParams.get("files");
            const items = url.searchParams.get("items");
            if (ea !== null) {
                effectAllowed = ea;
            }
            if (de !== null) {
                dropEffect = de;
            }
            if (files !== null) {
                dropFileCount = Number(files);
            }
            if (items !== null) {
                dropItemCount = Number(items);
            }
            const first = !dragSeen.has(kind);
            dragSeen.add(kind);
            const detail = [
                n ? `n=${n}` : "",
                ea !== null ? `effectAllowed=${ea}` : "",
                de !== null ? `dropEffect=${de}` : "",
                files !== null ? `files=${files}` : "",
                items !== null ? `items=${items}` : "",
            ]
                .filter(Boolean)
                .join("  ");
            console.log(`  ·  ${kind}${first ? "（首次）" : ""}${detail ? `  ${detail}` : ""}`);
            return new Response("ok");
        }
        if (url.pathname === "/report") {
            postedOk = url.searchParams.get("ok") === "1";
            postedVia = url.searchParams.get("via") ?? "";
            postError = url.searchParams.get("err") ?? "";
            const rawPayload = url.searchParams.get("raw") ?? "";
            console.log(
                `  ·  投递 via=${postedVia || "?"}  ${postedOk ? "成功返回" : "没有返回成功"}${postError ? `  抛错：${postError}` : ""}`,
            );
            console.log(`  ·  宿主推回的原文：${rawPayload || "（空）"}`);
            onReport(parseList(url.searchParams.get("paths")), parseList(url.searchParams.get("dirs")));
            return new Response("ok");
        }
        return new Response("not found", { status: 404 });
    },
    error: () => new Response("probe error", { status: 500 }),
});

function parseList(raw: string | null): string[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((x): x is string => typeof x === "string");
        }
    } catch {
        // 落到空数组：判据会因此变红，不会静默通过
    }
    return [];
}

const shell = await openShell({
    url: `http://127.0.0.1:${server.port}/`,
    title: "probe-drop-live",
    width: 720,
    height: 480,
    flags: FLAG_RESIZABLE | FLAG_CENTER | FLAG_ACCEPT_DROP,
});

function onReady(): void {
    if (readyDone) {
        return;
    }
    readyDone = true;
    // 页面脚本已经跑起来了：发一条 ping 验证 shell-msg 单向通道
    shell.post('{"t":"ping","from":"probe-drop-live"}');
}

function onReport(paths: string[], dirs: string[]): void {
    resolveReport?.({ paths, dirs });
}

console.log("");
console.log(`  窗口已弹出（端口 ${server.port}）。`);
if (targetFile) {
    console.log("  请把下面这个文件拖进窗口：");
    console.log(`    ${targetFile}`);
} else if (targetDir) {
    console.log("  请把下面这个文件夹拖进窗口：");
    console.log(`    ${targetDir}`);
} else {
    console.log("  请从资源管理器拖**任意文件或文件夹**进窗口。");
}
console.log(`  最多等 ${timeoutSec} 秒。`);
console.log("");
console.log("  拖的时候请看两件事：");
console.log("    1. 光标是「复制」箭头，还是圆圈里一道斜杠（禁止）？");
console.log("    2. 页面那行 inject= / dropEffect= 显示什么？");
console.log("");

/** 可取消的超时：`Bun.sleep` 不可取消，正常路径会留下悬挂定时器（pitfalls 3.4）。 */
let timer: ReturnType<typeof setTimeout> | null = null;
const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), timeoutSec * 1000);
});

const outcome = await Promise.race([reported, timeout]);
if (timer) {
    clearTimeout(timer);
}

check("页面加载并执行了页面脚本", readyDone, readyDone ? "" : "没有收到 /ready");
check(
    "拖放注入脚本真的跑了（window.__shellDropReady）",
    injectOn,
    injectOn ? "" : "页面读到 __shellDropReady 为空 —— FLAG_ACCEPT_DROP 的 kDropInit 没拼进 kInit",
);
check(
    "shell-msg 通道打通（宿主 ping 能到页面）",
    helloDone,
    helloDone ? "" : "没有收到 /hello —— 可能是 shell.post 或 __shell.recv 的问题",
);
check(
    "OLE 到达渲染进程（页面见到 dragenter）",
    dragSeen.has("dragenter"),
    dragSeen.has("dragenter")
        ? `effectAllowed=${effectAllowed} dropEffect=${dropEffect}`
        : "一条 drag 事件都没有 —— 拖放在 OS 层就被挡了",
);
check(
    "页面收到 drop 事件",
    dropFileCount >= 0,
    dropFileCount >= 0 ? `files=${dropFileCount}  items=${dropItemCount}` : "一条 drop 都没到",
);
check(
    "注入脚本的 postMessageWithAdditionalObjects 成功返回",
    postedOk,
    postedOk ? `via=${postedVia}` : `没有返回成功${postError ? `，抛错：${postError}` : ""}`,
);

let paths: string[] = [];
let dirs: string[] = [];
if (outcome === null) {
    check("真实拖放到达宿主", false, `${timeoutSec} 秒内没有收到 /report`);
} else {
    paths = outcome.paths;
    dirs = outcome.dirs;
    check("真实拖放到达宿主", true, `${paths.length} 条路径`);
    check("paths 非空", paths.length > 0, paths.length ? paths.join(" | ") : "空数组");
    check(
        "每条都是绝对路径",
        paths.length > 0 && paths.every((p) => isAbsolute(p)),
        paths.filter((p) => !isAbsolute(p)).join(" | ") || "全部绝对",
    );
    check(
        "路径真实存在",
        paths.length > 0 && paths.every((p) => existsSync(p)),
        paths.filter((p) => !existsSync(p)).join(" | ") || "全部存在",
    );

    // `dirs` 必须与文件系统的真实情况一致：把 paths 里每个路径按 statSync 分类，
    // 与壳层报的 dirs 逐个比对。这一条才能抓到「kind 判错」——只断言 dirs 非空
    // 抓不到「目录被当成文件报」。
    const realDirs = paths.filter((p) => {
        try {
            return statSync(p).isDirectory();
        } catch {
            return false;
        }
    });
    const dirsSet = [...dirs].sort();
    const realSet = [...realDirs].sort();
    check(
        "目录识别与文件系统一致（paths 里的目录都在 dirs，反之亦然）",
        JSON.stringify(dirsSet) === JSON.stringify(realSet),
        `壳层 dirs=${JSON.stringify(dirsSet)}  实际=${JSON.stringify(realSet)}`,
    );

    if (targetFile) {
        const hit = paths.some((p) => p.toLowerCase() === targetFile.toLowerCase());
        check(
            `拖的正是指定的文件 ${basename(targetFile)}`,
            hit,
            hit ? targetFile : `收到的是 ${paths.join(" | ") || "（空）"}`,
        );
        check(
            "它是被当成文件报的（不在 dirs 里）",
            !dirs.some((p) => p.toLowerCase() === targetFile.toLowerCase()),
            dirs.length ? `dirs=${dirs.join(" | ")}` : "dirs 为空",
        );
    } else if (targetDir) {
        const hit = dirs.some((p) => p.toLowerCase() === targetDir.toLowerCase());
        check(
            `拖的正是指定的目录 ${basename(targetDir)}`,
            hit,
            hit ? targetDir : `dirs 收到的是 ${dirs.join(" | ") || "（空）"}`,
        );
    }
}

if (outcome === null) {
    if (!dragSeen.has("dragenter")) {
        console.log("  判读：一条 drag 事件都没有。最常见的两个原因——");
        console.log("    1. 宿主进程处于**提权**状态（High 完整性），UIPI 在 DoDragDrop 里就拒了；");
        console.log("       资源管理器是 Medium。请在非提权的桌面会话里再跑一次。");
        console.log("    2. 窗口根本没在前台（拖到了别的窗口上）。");
    } else if (dropFileCount < 0) {
        console.log("  判读：drag 事件到了，drop 不来。按 inject 与 dropEffect 分两种情况——");
        console.log("    - inject=OFF                → 注入脚本没跑，落点自然没人接受。");
        console.log("    - dropEffect=none（且 inject=on）→ 缺 dataTransfer.dropEffect = 'copy'。");
    } else {
        console.log("  判读：页面收到 drop 且 files/items 有数，但宿主没收到 WebMessage。");
        console.log("    查 DropMessageHandler：get_AdditionalObjects 有没有返回对象。");
    }
}

shell.close();
await Bun.sleep(300);
server.stop(true);

console.log("");
for (const c of checks) {
    const mark = c.ok ? " ok " : "FAIL";
    console.log(`  ${mark}  ${c.name}${c.detail ? `         ${c.detail}` : ""}`);
}
console.log("");
const failed = checks.filter((c) => !c.ok);
if (failed.length === 0) {
    console.log(`PROBE PASSED (${checks.length} checks)`);
    process.exit(0);
}
console.log(`PROBE FAILED (${failed.length} of ${checks.length} checks)`);
process.exit(1);
