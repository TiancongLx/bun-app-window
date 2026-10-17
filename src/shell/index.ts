/**
 * index.ts — webview-shell 内核门面
 *
 * 这是包的唯一稳定入口。它只做三件事：解析原生库、暴露窗口操作、暴露排障探针。
 * 不带任何业务逻辑、不读环境变量、不写日志文件、不调用 process.exit。
 *
 * ```ts
 * import { createShell, FLAG_FRAMELESS, FLAG_CENTER } from "webview-shell";
 *
 * const shell = await createShell({
 *   url: "http://127.0.0.1:40001",
 *   title: "My App",
 *   width: 1000, height: 680,
 *   flags: FLAG_FRAMELESS | FLAG_CENTER,
 * });
 * if (shell.start().rc !== 0) throw new Error(shell.lastError());
 * shell.post(JSON.stringify({ t: "hello" }));
 * ```
 *
 * 线程模型：`start()` 立即返回（原生层自建 UI 线程），调用方主线程不被阻塞。
 */

import { cstr, openNativeLib, readBuffer, readCStr } from "./native";
import type { NativeSymbols } from "./native";
import { resolveNativeLib } from "./resolve";
import {
  STATE_FOCUSED,
  STATE_MAXIMIZED,
  STATE_MINIMIZED,
  type NativeLibInfo,
  type ShellOptions,
  type StartResult,
  type WindowState,
} from "./types";

export * from "./types";
export { resolveNativeLib, isPackedRuntime } from "./resolve";
export type { ResolveOptions } from "./resolve";
export { serveOnSafePort, isRestrictedPort } from "./port";
export type { ServeOptions } from "./port";
export { cstr, readCStr } from "./native";
export type { NativeSymbols, NativeLib } from "./native";

export type Shell = {
  /** 创建窗口并加载 URL。返回码 0 表示成功；失败原因见 lastError() */
  start(): StartResult;
  /** 宿 → 页面：投递 JSON 文本（单向，不等结果） */
  post(json: string): number;
  setTitle(title: string): number;
  minimize(): number;
  toggleMaximize(): number;
  close(): number;
  /** 由页面 pointerdown 触发原生拖拽；保留贴边分屏 */
  drag(): number;
  /** 由页面 pointermove 触发边框缩放；edge 取 RESIZE_EDGE 的值 */
  beginResize(edge: number): number;
  /** 最小尺寸，逻辑像素 */
  setMinSize(width: number, height: number): void;
  state(): WindowState;
  /** 最近一次失败的原因；无错误时为空串 */
  lastError(): string;
  /** 停止并释放窗口（可重复调用） */
  stop(): void;

  readonly started: boolean;
  readonly libInfo: NativeLibInfo;
  /** 逃生舱：直接访问 dlopen 出来的符号 */
  readonly symbols: NativeSymbols;

  /**
   * 排障面 —— 不是稳定契约，可能随版本变化。
   * 生产代码不应依赖这里。
   */
  readonly debug: {
    /** 客户区坐标 → Win32 命中码（HT* 常量） */
    hittest(x: number, y: number): number;
    /** 一次性几何快照：pos / win / client / work / border / round */
    metrics(): string;
    /** DPI 感知级别与缩放 */
    dpi(): string;
    /** 原生库自身模块基址 */
    selfBase(): bigint;
    /** 原生库自身文件路径 */
    selfPath(): string;
  };
};

export async function createShell(opts: ShellOptions): Promise<Shell> {
  if (!opts.url) throw new Error("createShell: url is required");

  const libInfo = await resolveNativeLib({
    nativeLibPath: opts.nativeLibPath,
    appName: opts.appName,
    embedded: opts.embedded,
  });
  const { symbols } = openNativeLib(libInfo.path);

  let started = false;
  let stopped = false;

  const lastError = () => readCStr(symbols.shell_error());

  const shell: Shell = {
    start(): StartResult {
      if (started) return { rc: -1, error: "shell already started" };
      const rc = symbols.shell_start_ex(
        cstr(opts.url),
        cstr(opts.title ?? "webview-shell"),
        opts.width ?? 1000,
        opts.height ?? 680,
        opts.flags ?? 0,
      );
      started = rc === 0;
      if (started && opts.minWidth && opts.minHeight) {
        symbols.shell_set_min_size(opts.minWidth, opts.minHeight);
      }
      return { rc, error: rc === 0 ? "" : lastError() };
    },

    post: (json) => symbols.shell_post(cstr(json)),
    setTitle: (title) => symbols.shell_title(cstr(title)),
    minimize: () => symbols.shell_minimize(),
    toggleMaximize: () => symbols.shell_toggle_maximize(),
    close: () => symbols.shell_close(),
    drag: () => symbols.shell_drag(),
    beginResize: (edge) => symbols.shell_begin_resize(edge),
    setMinSize: (w, h) => symbols.shell_set_min_size(w, h),

    state(): WindowState {
      const raw = symbols.shell_get_state();
      return {
        raw,
        maximized: (raw & STATE_MAXIMIZED) !== 0,
        minimized: (raw & STATE_MINIMIZED) !== 0,
        focused: (raw & STATE_FOCUSED) !== 0,
      };
    },

    lastError,

    stop() {
      if (stopped) return;
      stopped = true;
      started = false;
      try {
        symbols.shell_stop();
      } catch {
        // 窗口已销毁时无需处理
      }
    },

    get started() {
      return started;
    },
    libInfo,
    symbols,

    debug: {
      hittest: (x, y) => symbols.shell_debug_hittest(x, y),
      metrics: () => readBuffer((p, len) => symbols.shell_debug_metrics(p, len)),
      dpi: () => readBuffer((p, len) => symbols.shell_debug_dpi(p, len)),
      selfBase: () => symbols.shell_self_base(),
      selfPath: () => readBuffer((p, len) => symbols.shell_self_path(p, len)),
    },
  };

  return shell;
}

/** 语法糖：创建并启动；失败直接抛错 */
export async function openShell(opts: ShellOptions): Promise<Shell> {
  const shell = await createShell(opts);
  const { rc, error } = shell.start();
  if (rc !== 0) {
    throw new Error(`shell_start_ex failed (rc=${rc}): ${error || "unknown"}`);
  }
  return shell;
}
