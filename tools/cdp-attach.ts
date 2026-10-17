/**
 * cdp-attach.ts — 从当前会话（Session 0）通过 CDP 接入另一个会话里运行的应用
 *
 * 目的：证明「OTT 不派生 Session 1」也能做应用级自动化。
 * 应用由谁启动不重要（用户手点、登录任务、或别的机制），OTT 只做 TCP 客户端。
 *
 * 用法：
 *   bun run tools/cdp-attach.ts <port> [--eval "表达式"] [--screenshot out.png]
 */

const port = Number(process.argv[2] ?? 9222);
const evalIdx = process.argv.indexOf("--eval");
const expr = evalIdx > 0 ? process.argv[evalIdx + 1] : null;
const shotIdx = process.argv.indexOf("--screenshot");
const shotOut = shotIdx > 0 ? process.argv[shotIdx + 1] : null;

function fail(msg: string, code = 1): never {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

async function getJson(path: string): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) fail(`${path} -> HTTP ${r.status}`);
  return r.json();
}

type Target = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

// ---------- 探活 ----------

let version: any;
try {
  version = await getJson("/json/version");
} catch (e) {
  fail(`CDP endpoint unreachable on 127.0.0.1:${port} — ${(e as Error).message}`);
}

console.log("[cdp] endpoint reachable");
console.log(`  Browser        : ${version.Browser ?? "(n/a)"}`);
console.log(`  Protocol-Version: ${version["Protocol-Version"] ?? "(n/a)"}`);
console.log(`  User-Agent     : ${(version["User-Agent"] ?? "").slice(0, 90)}`);

// ---------- 枚举 target ----------

const targets = (await getJson("/json/list")) as Target[];
console.log(`[cdp] targets: ${targets.length}`);
for (const t of targets) {
  if (t.type === "page" || t.type === "webview") {
    console.log(`  - [${t.type}] "${t.title}"  ${t.url.slice(0, 70)}`);
  }
}

const page =
  targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
  targets.find((t) => t.webSocketDebuggerUrl);

if (!page) fail("no attachable target");

// ---------- 连接并执行 ----------

const ws = new WebSocket(page.webSocketDebuggerUrl!);
let seq = 0;
const pending = new Map<number, (v: any) => void>();

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 15000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("ws open timeout")), 8000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve();
  };
  ws.onerror = (e) => {
    clearTimeout(timer);
    reject(new Error(`ws error: ${String(e)}`));
  };
}).catch((e) => fail(`ws connect failed: ${e.message}`));

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const fn = pending.get(msg.id)!;
    pending.delete(msg.id);
    fn(msg);
  }
};

console.log(`[cdp] attached to "${page.title}"`);

// ---------- 自证身份：读页面里的 window/session 信息 ----------

const baseEval = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    href: location.href.slice(0, 60),
    title: document.title,
    innerW: innerWidth,
    innerH: innerHeight,
    dpr: devicePixelRatio,
    hasShell: typeof window.__shell !== "undefined",
    badges: Array.from(document.querySelectorAll(".badge")).map(e => e.textContent.trim())
  })`,
  returnByValue: true,
});

try {
  console.log("  [page] " + baseEval.result.result.value);
} catch {
  console.log("  [page] (evaluate returned unexpected shape)");
}

// ---------- 页面截图（不依赖任何 Session 1 代码） ----------

if (shotOut) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const b64 = shot.result?.data;
  if (!b64) fail("captureScreenshot returned no data");
  const bytes = Buffer.from(b64, "base64");
  await Bun.write(shotOut, bytes);
  console.log(`  [shot] ${shotOut} (${bytes.length} bytes)`);
}

// ---------- 自定义表达式 ----------

if (expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const v = r.result?.result;
  console.log(`  [eval] ${JSON.stringify(v?.value ?? v)}`);
}

ws.close();
console.log("[cdp] done");
