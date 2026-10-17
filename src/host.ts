import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import uiHtml from "./ui/index.html" with { type: "text" };
import { cstr, openNativeLib, ptr, readCStr, resolveNativeLib } from "./native-lib";
import { serveOnSafePort } from "./safe-port";

const ROOT = resolve(import.meta.dir, "..");
const PACKED = /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(import.meta.dir);

// 打包后 import.meta.dir 是 B:\~BUN\root（不可写），
// 日志改落到 exe 所在目录；开发时仍写仓库 build/。
const LOG = PACKED
  ? resolve(process.execPath, "..", "host.log")
  : resolve(ROOT, "build", "host.log");

writeFileSync(
  LOG,
  `=== shell start ${new Date().toISOString()} pid=${process.pid} packed=${PACKED} ===\n`,
);

function log(...parts: unknown[]) {
  const line = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
}

// 受控加载原生库：打包态从内嵌字节释放到 %LOCALAPPDATA%，不碰 %TEMP%
const libInfo = await resolveNativeLib("WebViewShell");
log(
  `[lib] source=${libInfo.source} path=${libInfo.path} bytes=${libInfo.bytes}` +
    `${libInfo.sha256 ? ` sha256=${libInfo.sha256.slice(0, 16)}` : ""}` +
    ` reused=${libInfo.reused}` +
    `${libInfo.pruned.length ? ` pruned=${JSON.stringify(libInfo.pruned)}` : ""}`,
);

const { symbols } = openNativeLib(libInfo.path);

function lastError(): string {
  return readCStr(symbols.shell_error()) || "(empty)";
}

const FLAG_FRAMELESS = 1;
const FLAG_TOPMOST = 2;
const FLAG_CENTER = 4;
const FLAG_RESIZABLE = 8;

const HOLD = process.env.HOLD === "1";

const token = crypto.randomUUID();
const events: string[] = [];
let finished = false;

function done(code: number) {
  if (finished) return;
  finished = true;
  try {
    symbols.shell_stop();
  } catch {}
  log(`=== exit ${code} events=${JSON.stringify(events)} ===`);
  setTimeout(() => process.exit(code), 200);
}

// 端口必须避开浏览器的受限端口表，否则 WebView2 直接报 ERR_UNSAFE_PORT
const server = serveOnSafePort({
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (url.searchParams.get("t") !== token) return new Response(null, { status: 403 });
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response(null, { status: 400 });
    }

    if (url.pathname === "/") {
      // HTML 通过 type:"text" 内联为字符串，不落盘、不经过临时目录
      return new Response(uiHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/ping") {
      return Response.json({ ok: true, answeredAt: Date.now() });
    }

    return new Response("not found", { status: 404 });
  },
  websocket: {
    open() {
      events.push("ws:open");
      log("[ws] open");
    },
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      log("[ws] <-", msg);

      if (msg.t === "env" || msg.t === "win") {
        events.push(`${msg.t}:${JSON.stringify(msg)}`);
      }

      if (msg.t === "hello") {
        ws.send(JSON.stringify({ t: "welcome", ua: msg.ua ?? null }));
        const rc = symbols.shell_post(cstr(JSON.stringify({ t: "from-host", at: Date.now() })));
        log(`[host] shell_post -> rc=${rc}${rc === 0 ? "" : ` err=${lastError()}`}`);
      }

      if (msg.t === "ui") {
        // 页面点按钮，转发到原生窗口操作
        const action = String(msg.action);
        const map: Record<string, () => number> = {
          minimize: () => symbols.shell_minimize(),
          maximize: () => symbols.shell_toggle_maximize(),
          close: () => symbols.shell_close(),
          drag: () => symbols.shell_drag(),
        };
        const rc = map[action]?.() ?? -1;
        log(`[host] ui:${action} -> rc=${rc}`);
      }

      if (msg.t === "hittest-probe") {
        // 页面侧报告鼠标落在哪、命中码是什么，用于核对边框几何
        const code = symbols.shell_debug_hittest(msg.x, msg.y);
        events.push(`hittest:${msg.label}(${msg.x},${msg.y})=${code}`);
        ws.send(JSON.stringify({ t: "hittest-result", label: msg.label, x: msg.x, y: msg.y, code }));
      }

      if (msg.t === "geo") {
        events.push(`geo:${JSON.stringify(msg)}`);
        log(`[geo] screenX=${msg.screenX} screenY=${msg.screenY} outer=${msg.outerW}x${msg.outerH} inner=${msg.innerW}x${msg.innerH} screen=${msg.screenW}x${msg.screenH} avail=${msg.availW}x${msg.availH} dpr=${msg.dpr}`);
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
  },
});

const url = `http://127.0.0.1:${server.port}/?t=${token}`;
log(`[serve] ${url} (port ${server.port})`);

symbols.shell_set_min_size(480, 320);

const flags = FLAG_FRAMELESS | FLAG_RESIZABLE | FLAG_CENTER | (HOLD ? FLAG_TOPMOST : 0);
const rc = symbols.shell_start_ex(cstr(url), cstr("WebView Shell"), 1000, 680, flags);
log(`[host] shell_start_ex(flags=${flags}) -> rc=${rc}${rc === 0 ? "" : ` err=${lastError()}`}`);
if (rc !== 0) done(1);

function metrics(label: string) {
  const buf = new Uint8Array(256);
  const n = symbols.shell_debug_metrics(ptr(buf), buf.length);
  if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    log(`[metrics] ${label}: ${text}`);
    events.push(`metrics:${label}=${text}`);
  }
}

function dpiInfo() {
  const buf = new Uint8Array(160);
  const n = symbols.shell_debug_dpi(ptr(buf), buf.length);
  if (n > 0) {
    const text = new TextDecoder().decode(buf.subarray(0, n));
    log(`[dpi] ${text}`);
    events.push(`dpi:${text}`);
  }
}

function selfInfo() {
  const base = symbols.shell_self_base();
  const buf = new Uint8Array(1024);
  const n = symbols.shell_self_path(ptr(buf), buf.length);
  const path = n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "(empty)";
  log(`[self] base=0x${base.toString(16)} path="${path}"`);
  events.push(`self:base=0x${base.toString(16)} path=${path}`);
}

selfInfo();
dpiInfo();

// 边框命中几何自检 + 最大化/还原（验证 NCCALCSIZE 的最大化补偿）
if (!HOLD) {
  setTimeout(() => {
    metrics("initial");
    const st = symbols.shell_get_state();
    log(`[host] state=${st} max=${!!(st & 1)} min=${!!(st & 2)} focus=${!!(st & 4)}`);
    log(`[host] toggle_maximize -> rc=${symbols.shell_toggle_maximize()}`);
    setTimeout(() => {
      metrics("maximized");
      const st2 = symbols.shell_get_state();
      log(`[host] state after maximize=${st2} max=${!!(st2 & 1)}`);
      log(`[host] restore -> rc=${symbols.shell_toggle_maximize()}`);
      setTimeout(() => {
        metrics("restored");
        const st3 = symbols.shell_get_state();
        log(`[host] state after restore=${st3} max=${!!(st3 & 1)}`);
        done(0);
      }, 1200);
    }, 1400);
  }, 1800);
} else {
  log("[host] HOLD 模式：窗口保持 25 秒，供截图");
  for (const t of [1000, 3000, 8000]) setTimeout(() => metrics(`hold@${t}`), t);
  setTimeout(() => done(0), 25000);
}

setTimeout(() => {
  events.push("timeout");
  done(2);
}, 30000);

process.on("SIGINT", () => done(130));
