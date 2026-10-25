/**
 * host.ts — 自检程序（bun-app-window 内核的消费者）
 *
 * 这不是库的一部分。它的作用是证明内核 API 足以支撑一个真实应用：
 * 起本地服务 → 开窗 → 双向消息 → 几何/DPI/命中自检 → 最大化还原 → 退出。
 *
 * 业务应用只需把这里面的自检段落替换成自己的逻辑。
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    FLAG_CENTER,
    FLAG_FRAMELESS,
    FLAG_RESIZABLE,
    FLAG_TOPMOST,
    openShell,
    serveOnSafePort,
    type Shell,
} from "./shell/index";
import { debugOf } from "./shell/debug";
// 副作用导入：让 `bun build --compile` 把 dist/libshell.dll 记进内嵌资源表。
//
// 没有这一行时，打包产物在空目录里会直接失败：
//   cannot locate libshell.dll in a compiled executable.
// 因为 resolve.ts 的三级回退（内嵌字节 → exe 同级 → 开发态路径）在
// `packed=true` 下只剩「exe 同级」可用，而空目录里没有那个文件。
//
// 只在自检程序里导入：`src/shell/` 本身不能有它——那会给所有非编译型消费者
// 加上一条静态 `type: "file"` 依赖（见 embedded.ts 的说明）。
// 本文件不在发布面（package.json 的 files 白名单），所以这只影响 `build:exe`。
import "./shell/embedded";
import uiHtml from "./ui/index.html" with { type: "text" };

const ROOT = resolve(import.meta.dir, "..");
const PACKED = /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir);

// 打包后 import.meta.dir 是 B:\~BUN\root（不可写），日志改落 exe 所在目录
const LOG = PACKED ? resolve(process.execPath, "..", "host.log") : resolve(ROOT, ".build", "host.log");

writeFileSync(LOG, `=== host start ${new Date().toISOString()} pid=${process.pid} packed=${PACKED} ===\n`);

const events: string[] = [];
let finished = false;

function log(...parts: unknown[]) {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
    console.log(line);
}

const HOLD = process.env.HOLD === "1";

const token = crypto.randomUUID();
let shell: Shell | null = null;

function done(code: number) {
    if (finished) return;
    finished = true;
    shell?.stop();
    log(`=== exit ${code} events=${JSON.stringify(events)} ===`);
    setTimeout(() => process.exit(code), 200);
}

// 端口必须避开浏览器受限端口表，否则 WebView2 直接报 ERR_UNSAFE_PORT
const server = serveOnSafePort({
    fetch(req, srv) {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
            if (url.searchParams.get("t") !== token) return new Response(null, { status: 403 });
            if ((srv as { upgrade(r: Request, o: unknown): boolean }).upgrade(req, { data: {} })) {
                return undefined;
            }
            return new Response(null, { status: 400 });
        }

        if (url.pathname === "/") {
            // HTML 通过 type:"text" 内联为字符串，不落盘、不经过临时目录
            return new Response(uiHtml as unknown as string, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }

        if (url.pathname === "/api/ping") {
            return Response.json({ ok: true, answeredAt: Date.now() });
        }

        return new Response("not found", { status: 404 });
    },
    websocket: {
        open(ws: { send(d: string): void }) {
            events.push("ws:open");
            log("[ws] open");
            void ws;
        },
        message(ws: { send(d: string): void }, raw: string | Buffer) {
            const msg = JSON.parse(String(raw));
            log("[ws] <-", msg);

            if (msg.t === "env" || msg.t === "win") {
                events.push(`${msg.t}:${JSON.stringify(msg)}`);
            }

            if (msg.t === "hello") {
                ws.send(JSON.stringify({ t: "welcome", ua: msg.ua ?? null }));
                if (!shell) return;
                const rc = shell.post(JSON.stringify({ t: "from-host", at: Date.now() }));
                log(`[host] shell_post -> rc=${rc}${rc === 0 ? "" : ` err=${shell.lastError()}`}`);
            }

            if (msg.t === "ui" && shell) {
                // 页面点按钮，转发到原生窗口操作
                const action = String(msg.action);
                const map: Record<string, () => number> = {
                    minimize: () => shell!.minimize(),
                    maximize: () => shell!.toggleMaximize(),
                    close: () => shell!.close(),
                    drag: () => shell!.drag(),
                };
                const rc = map[action]?.() ?? -1;
                log(`[host] ui:${action} -> rc=${rc}`);
            }

            if (msg.t === "hittest-probe" && shell) {
                // 页面侧报告鼠标落在哪、命中码是什么，用于核对边框几何
                const code = debugOf(shell).hittest(msg.x, msg.y);
                events.push(`hittest:${msg.label}(${msg.x},${msg.y})=${code}`);
                ws.send(JSON.stringify({ t: "hittest-result", label: msg.label, x: msg.x, y: msg.y, code }));
            }

            if (msg.t === "geo") {
                events.push(`geo:${JSON.stringify(msg)}`);
                log(
                    `[geo] screenX=${msg.screenX} screenY=${msg.screenY} outer=${msg.outerW}x${msg.outerH} ` +
                        `inner=${msg.innerW}x${msg.innerH} screen=${msg.screenW}x${msg.screenH} ` +
                        `avail=${msg.availW}x${msg.availH} dpr=${msg.dpr}`,
                );
            }

            if (msg.t === "win-report") {
                events.push(
                    `win:${msg.width}x${msg.height}css/${msg.pixelWidth}x${msg.pixelHeight}px@${msg.dpi}${msg.maximized ? " max" : ""}`,
                );
                log(
                    `[win] ${msg.width}×${msg.height} css / ${msg.pixelWidth}×${msg.pixelHeight} px @${msg.dpi}dpi maximized=${msg.maximized}`,
                );
            }

            if (msg.t === "shell-echo") {
                events.push("roundtrip:host->page->host");
            }
        },
        close() {
            log("[ws] close");
        },
    } as never,
});

const url = `http://127.0.0.1:${server.port}/?t=${token}`;
log(`[serve] ${url} (port ${server.port})`);

const flags = FLAG_FRAMELESS | FLAG_RESIZABLE | FLAG_CENTER | (HOLD ? FLAG_TOPMOST : 0);

try {
    shell = await openShell({
        url,
        title: "WebView Shell",
        width: 1000,
        height: 680,
        flags,
        minWidth: 480,
        minHeight: 320,
    });
} catch (err) {
    log(`[host] openShell failed: ${String(err)}`);
    done(1);
}

if (shell) {
    const s = shell;
    log(`[lib] source=${s.libInfo.source} path=${s.libInfo.path}`);
    log(`[debug] ${debugOf(s).dpi()}`);
    events.push(`dpi:${debugOf(s).dpi()}`);
    log(`[debug] base=0x${debugOf(s).selfBase().toString(16)} ${debugOf(s).selfPath()}`);

    // 边框命中几何自检 + 最大化/还原（验证 NCCALCSIZE 的最大化补偿）
    if (!HOLD) {
        setTimeout(() => {
            log(`[metrics] initial: ${debugOf(s).metrics()}`);
            const st = s.state();
            log(`[host] state max=${st.maximized} min=${st.minimized} focus=${st.focused}`);
            log(`[host] toggle_maximize -> rc=${s.toggleMaximize()}`);
            setTimeout(() => {
                log(`[metrics] maximized: ${debugOf(s).metrics()}`);
                log(`[host] state after maximize=${s.state().maximized}`);
                log(`[host] restore -> rc=${s.toggleMaximize()}`);
                setTimeout(() => {
                    log(`[metrics] restored: ${debugOf(s).metrics()}`);
                    log(`[host] state after restore=${s.state().maximized}`);
                    done(0);
                }, 1200);
            }, 1400);
        }, 1800);
    } else {
        log("[host] HOLD 模式：窗口保持 25 秒，供截图");
        for (const t of [1000, 3000, 8000]) {
            setTimeout(() => log(`[metrics] hold@${t}: ${debugOf(s).metrics()}`), t);
        }
        setTimeout(() => done(0), 25000);
    }
}

setTimeout(() => {
    events.push("timeout");
    done(2);
}, 30000);

process.on("SIGINT", () => done(130));
