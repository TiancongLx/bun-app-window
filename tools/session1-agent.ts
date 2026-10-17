/**
 * session1-agent — 交互式会话执行代理
 *
 * 问题：OTT 以 Windows 服务形态运行在 Session 0（services 会话），
 * 那里没有交互式桌面，WebView2 无法创建 controller，任何 GUI 验证都会失败
 * （表现为 ERROR_INVALID_WINDOW_HANDLE 0x80070578，而非「运行时不存在的」）。
 *
 * 方案：在 Session 1（用户 console 会话）里常驻一个受控执行代理。
 * Session 0 通过 127.0.0.1 上的 HTTP 把命令派发进来，代理在 Session 1 里执行并回传结果。
 * 这样 OTT 的服务形态不必改动（避免自噬禁令），但调试能力完整。
 *
 * 安全边界：
 *   -   仅监听 127.0.0.1
 *   -   Bearer token 鉴权，token 随机生成、仅本用户可读
 *   -   代理以当前用户身份运行，权限不超过该用户
 *   -   不做任何提权
 *
 * 启动方式：由 install-session1-agent.ps1 注册登录触发任务，通过 VBS 隐藏窗口拉起。
 */

import { FFIType, dlopen, ptr } from "bun:ffi";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------- 会话探测 ----------

function currentSessionId(): number {
  try {
    const { symbols } = dlopen("kernel32.dll", {
      ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    });
    const out = new Uint32Array(1);
    if (symbols.ProcessIdToSessionId(process.pid, ptr(out))) return out[0];
  } catch {
    // 退回到环境变量判断
  }
  return process.env.SESSIONNAME === "Console" ? -1 : -2;
}

const SESSION_ID = currentSessionId();

// ---------- 配置与日志 ----------

const CONFIG_DIR = join(homedir(), ".config", "session1-agent");
const PORT_FILE = join(CONFIG_DIR, "port");
const TOKEN_FILE = join(CONFIG_DIR, "token");
const LOG_FILE = join(CONFIG_DIR, "agent.log");

mkdirSync(CONFIG_DIR, { recursive: true });

function log(...parts: unknown[]) {
  const line = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try {
    appendFileSync(LOG_FILE, stamped);
  } catch {
    // 日志写不进去不应影响服务
  }
  console.log(stamped.trimEnd());
}

function loadOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  writeFileSync(TOKEN_FILE, token + "\n");
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，忽略
  }
  return token;
}

const TOKEN = loadOrCreateToken();

// ---------- 执行辅助 ----------

type ExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

async function runExec(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? 30_000, 600_000);

  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }, timeoutMs);

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    exitCode,
    stdout: new TextDecoder().decode(stdoutBuf),
    stderr: new TextDecoder().decode(stderrBuf),
    durationMs: Date.now() - started,
    timedOut,
  };
}

type Tracked = { pid: number; argv: string[]; startedAt: string };
const tracked = new Map<number, Tracked>();

function spawnDetached(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> },
): number {
  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts.cwd ? resolve(opts.cwd) : process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  tracked.set(proc.pid, { pid: proc.pid, argv, startedAt: new Date().toISOString() });
  proc.unref();
  return proc.pid;
}

function killPids(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
      tracked.delete(pid);
    } catch {
      // 不存在或无权限
    }
  }
  return killed;
}

function listMatching(namePattern?: string): Tracked[] {
  const all = [...tracked.values()];
  if (!namePattern) return all;
  const re = new RegExp(namePattern, "i");
  return all.filter((t) => re.test(t.argv[0] ?? "") || re.test(t.argv.join(" ")));
}

// ---------- HTTP 服务 ----------

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (header === `Bearer ${TOKEN}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("t") === TOKEN;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const STARTED_AT = new Date().toISOString();
const STARTED_MS = Date.now();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // 健康检查不需要 token，便于 Session 0 判断代理是否在线
      return json({
        ok: true,
        pid: process.pid,
        sessionId: SESSION_ID,
        user: process.env.USERNAME ?? "",
        sessionName: process.env.SESSIONNAME ?? "",
        bun: Bun.version,
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_MS,
      });
    }

    if (!authorized(req)) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/exec" && req.method === "POST") {
      const body = (await req.json()) as {
        argv: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      };
      if (!Array.isArray(body.argv) || body.argv.length === 0) {
        return json({ error: "argv is required" }, 400);
      }
      log(`[exec] ${body.argv.join(" ")}`);
      const result = await runExec(body.argv, body);
      log(`[exec] done exit=${result.exitCode} ${result.durationMs}ms${result.timedOut ? " TIMEOUT" : ""}`);
      return json({ ...result, sessionId: SESSION_ID });
    }

    if (url.pathname === "/spawn" && req.method === "POST") {
      const body = (await req.json()) as {
        argv: string[];
        cwd?: string;
        env?: Record<string, string>;
      };
      if (!Array.isArray(body.argv) || body.argv.length === 0) {
        return json({ error: "argv is required" }, 400);
      }
      const pid = spawnDetached(body.argv, body);
      log(`[spawn] pid=${pid} ${body.argv.join(" ")}`);
      return json({ pid, sessionId: SESSION_ID });
    }

    if (url.pathname === "/kill" && req.method === "POST") {
      const body = (await req.json()) as { pids?: number[]; name?: string };
      let targets = body.pids ?? [];
      if (body.name) {
        targets = [...targets, ...listMatching(body.name).map((t) => t.pid)];
      }
      const killed = killPids([...new Set(targets)]);
      log(`[kill] ${JSON.stringify(killed)}`);
      return json({ killed });
    }

    if (url.pathname === "/procs") {
      return json({ procs: listMatching(url.searchParams.get("name") ?? undefined) });
    }

    return json({ error: "not found" }, 404);
  },
  error(err) {
    log(`[error] ${err.message}`);
    return json({ error: err.message }, 500);
  },
});

// ---------- 启动前检查：是否已有实例 ----------

if (existsSync(PORT_FILE)) {
  const existing = Number(readFileSync(PORT_FILE, "utf8").trim());
  if (Number.isInteger(existing) && existing > 0) {
    try {
      const r = await fetch(`http://127.0.0.1:${existing}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        const info = (await r.json()) as { sessionId: number };
        log(`[start] another instance already running on port ${existing} (session ${info.sessionId}), exiting`);
        process.exit(0);
      }
    } catch {
      // 旧端口已失效，继续占用
    }
  }
}

writeFileSync(PORT_FILE, String(server.port) + "\n");

log(
  `[start] listening on http://127.0.0.1:${server.port} ` +
    `session=${SESSION_ID} user=${process.env.USERNAME ?? "?"} ` +
    `bun=${Bun.version} pid=${process.pid}`,
);

if (SESSION_ID === 0) {
  log('[warn] 当前进程在 Session 0，GUI 验证仍会失败；请确认代理由登录触发任务启动');
}

process.on("uncaughtException", (err) => {
  log(`[uncaught] ${err.message}`);
});
process.on("unhandledRejection", (reason) => {
  log(`[unhandled] ${String(reason)}`);
});
