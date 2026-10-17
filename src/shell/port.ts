/**
 * port.ts — 为本地回环服务挑选浏览器允许访问的端口
 *
 * 背景：`Bun.serve({ port: 0 })` 由系统随意分配，可能拿到 6000、1719、1720 等
 * 「不安全端口」。WebView2 / Chromium 内核对这批端口一律拒绝连接，页面直接
 * 显示 ERR_UNSAFE_PORT，表现为窗口打开但白屏。本机实测命中过 1720（H.323 RAS）。
 *
 * 策略：40000–60000 区间随机挑选，避开受限端口表；该区间远离常见开发端口。
 */

import { randomInt } from "node:crypto";

/**
 * Chromium 的受限端口表（net/base/port_util.cc 的 kRestrictedPorts）。
 * 凡在此表内的端口，浏览器内核直接拒绝连接，不发任何网络请求。
 */
const RESTRICTED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179, 389, 427,
  465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

export function isRestrictedPort(port: number): boolean {
  return RESTRICTED_PORTS.has(port);
}

const RANGE_MIN = 40000;
const RANGE_MAX = 60000;

export type ServeOptions = {
  hostname?: string;
  /** 最多尝试几次（默认 20）；超出则抛错 */
  attempts?: number;
  fetch: (req: Request, server: unknown) => Response | undefined | Promise<Response | undefined>;
  websocket?: unknown;
  error?: (err: Error) => Response;
};

/**
 * 用已知安全的端口启动 Bun.serve。
 * 相比 `Bun.serve({ port: 0 })`，这里保证端口不在浏览器受限表内。
 */
export function serveOnSafePort(opts: ServeOptions) {
  const attempts = opts.attempts ?? 20;
  let lastErr: unknown = null;

  for (let i = 0; i < attempts; i++) {
    const port = randomInt(RANGE_MIN, RANGE_MAX);
    if (isRestrictedPort(port)) continue;

    try {
      const server = Bun.serve({
        hostname: opts.hostname ?? "127.0.0.1",
        port,
        fetch: opts.fetch as never,
        ...(opts.websocket === undefined ? {} : { websocket: opts.websocket as never }),
        ...(opts.error === undefined ? {} : { error: opts.error }),
      });

      // 双保险：即使指定了端口也再确认一次
      const bound = server.port;
      if (bound !== undefined && isRestrictedPort(bound)) {
        server.stop(true);
        lastErr = new Error(`allocated restricted port ${bound}`);
        continue;
      }
      return server;
    } catch (err) {
      lastErr = err;
      // 端口被占用等情况，继续尝试下一个
    }
  }

  throw new Error(`could not bind a safe port after ${attempts} attempts: ${String(lastErr)}`);
}
