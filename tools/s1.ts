/**
 * s1 — session1-agent 的命令行客户端（在 Session 0 使用）
 *
 * 用法：
 *   bun run tools/s1.ts health
 *   bun run tools/s1.ts exec   [--cwd DIR] [--env K=V]... [--timeout MS] -- <cmd...>
 *   bun run tools/s1.ts spawn  [--cwd DIR] [--env K=V]...               -- <cmd...>
 *   bun run tools/s1.ts kill   [--name REGEX] [--pid N]...
 *   bun run tools/s1.ts procs  [--name REGEX]
 *
 * 退出码：0 成功；1 代理不可达；2 远端命令非零退出；3 参数错误
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "session1-agent");
const PORT_FILE = join(CONFIG_DIR, "port");
const TOKEN_FILE = join(CONFIG_DIR, "token");

function fail(msg: string, code = 1): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function readPort(): number {
  if (!existsSync(PORT_FILE)) fail("agent port file missing — run install-session1-agent.ps1 -Start");
  const n = Number(readFileSync(PORT_FILE, "utf8").trim());
  if (!Number.isInteger(n) || n <= 0) fail(`invalid port in ${PORT_FILE}`);
  return n;
}

function readToken(): string {
  if (!existsSync(TOKEN_FILE)) fail("agent token file missing");
  return readFileSync(TOKEN_FILE, "utf8").trim();
}

function baseUrl(): string {
  return `http://127.0.0.1:${readPort()}`;
}

async function api(path: string, body?: unknown): Promise<any> {
  const url = `${baseUrl()}${path}`;
  const init: RequestInit = { signal: AbortSignal.timeout(600_000) };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${readToken()}`,
    };
    init.body = JSON.stringify(body);
  } else {
    init.headers = { authorization: `Bearer ${readToken()}` };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    fail(`agent unreachable at ${baseUrl()} — ${(err as Error).message}\n       try: pwsh -File tools\\install-session1-agent.ps1 -Start`);
  }
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) fail(`agent returned ${res.status}: ${JSON.stringify(parsed)}`, 1);
  return parsed;
}

// ---------- 参数解析 ----------

function splitArgs(argv: string[]) {
  const opts: Record<string, string[]> = {};
  const rest: string[] = [];
  let i = 0;
  let afterDoubleDash = false;

  while (i < argv.length) {
    const a = argv[i]!;
    if (afterDoubleDash) {
      rest.push(a);
      i++;
      continue;
    }
    if (a === "--") {
      afterDoubleDash = true;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        opts[key] = [...(opts[key] ?? []), "true"];
        i++;
      } else {
        opts[key] = [...(opts[key] ?? []), val];
        i += 2;
      }
      continue;
    }
    rest.push(a);
    i++;
  }
  return { opts, rest };
}

function envPairs(raw: string[] | undefined): Record<string, string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw) {
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`bad --env value: ${pair}`, 3);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

// ---------- 主流程 ----------

const argv = process.argv.slice(2);
const sub = argv[0];

if (!sub || sub === "--help" || sub === "-h") {
  console.log(
    [
      "usage:",
      "  s1.ts health",
      "  s1.ts exec   [--cwd DIR] [--env K=V]... [--timeout MS] -- <cmd...>",
      "  s1.ts spawn  [--cwd DIR] [--env K=V]...               -- <cmd...>",
      "  s1.ts kill   [--name REGEX] [--pid N]...",
      "  s1.ts procs  [--name REGEX]",
    ].join("\n"),
  );
  process.exit(0);
}

const { opts, rest } = splitArgs(argv.slice(1));

if (sub === "health") {
  const h = await api("/health");
  console.log(JSON.stringify(h, null, 2));
  if (h.sessionId !== 1) {
    console.error(`warn: agent is in session ${h.sessionId}, not 1`);
    process.exit(2);
  }
  process.exit(0);
}

if (sub === "exec") {
  if (rest.length === 0) fail("exec requires a command after --", 3);
  const body = {
    argv: rest,
    cwd: opts.cwd?.[0] ? resolve(opts.cwd[0]) : undefined,
    env: envPairs(opts.env),
    timeoutMs: opts.timeout?.[0] ? Number(opts.timeout[0]) : undefined,
  };
  const r = await api("/exec", body);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  console.error(
    `[exec] exit=${r.exitCode} ${r.durationMs}ms session=${r.sessionId}${r.timedOut ? " TIMEOUT" : ""}`,
  );
  process.exit(r.exitCode === 0 ? 0 : 2);
}

if (sub === "spawn") {
  if (rest.length === 0) fail("spawn requires a command after --", 3);
  const body = {
    argv: rest,
    cwd: opts.cwd?.[0] ? resolve(opts.cwd[0]) : undefined,
    env: envPairs(opts.env),
  };
  const r = await api("/spawn", body);
  console.log(JSON.stringify(r));
  process.exit(0);
}

if (sub === "kill") {
  const body: { pids?: number[]; name?: string } = {};
  if (opts.pid) body.pids = opts.pid.map(Number).filter(Number.isInteger);
  if (opts.name?.[0]) body.name = opts.name[0];
  if (!body.pids && !body.name) fail("kill requires --name or --pid", 3);
  const r = await api("/kill", body);
  console.log(`killed: ${JSON.stringify(r.killed)}`);
  process.exit(0);
}

if (sub === "procs") {
  const q = opts.name?.[0] ? `?name=${encodeURIComponent(opts.name[0])}` : "";
  const r = await api(`/procs${q}`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

fail(`unknown subcommand: ${sub}`, 3);
