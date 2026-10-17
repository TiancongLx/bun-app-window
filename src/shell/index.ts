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

import { cstr, openNativeLib, readBuffer } from "./native";
import { ptr } from "bun:ffi";
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
  /**
   * 显示窗口。配合 `FLAG_DEFER_SHOW` 使用：页面就绪后再调用，消除首帧闪烁。
   * 未启用延迟显示时是幂等 no-op。
   */
  show(): number;
  /**
   * 设置 AppUserModelID（任务栏分组与图标归属）。
   * 只在 `start()` 之前调用才对本窗口生效。
   */
  setAppId(appId: string): number;
  /**
   * 弹出系统文件夹选择框，返回选中路径；用户取消返回 null。
   *
   * 直接调 shell32，不起子进程、不落临时脚本——比「spawn powershell 跑 WinForms」
   * 快一个数量级，也不受执行策略限制。
   *
   * **同步阻塞**：SHBrowseForFolder 自带模态循环，调用期间调用线程被占住
   * （实测：Bun 主线程上的定时器在此期间不会触发）。同理，被阻塞的调用链
   * 无法取消或超时。需要并发时把它放到 Worker 里调用。
   */
  pickFolder(title?: string): string | null;
  state(): WindowState;
  /**
   * 窗口是否仍然存在。
   *
   * `state()` 无法区分「未启动」与「已销毁」（两者都返回全 false），
   * 宿主需要这个信号才能判断窗口是否已被用户关掉，进而回收自己的进程——
   * 窗口销毁后原生 UI 线程会返回，但宿主进程与它起的本地服务不会自己退出。
   */
  isAlive(): boolean;
  /** 最近一次失败的原因；无错误时为空串。走拷贝式读出，不受并发写影响 */
  lastError(): string;

  // ---- 输入与视图 ----
  /**
   * 页面缩放倍率（0.25 ~ 3.0）。也支持用户键盘操作：Ctrl± / Ctrl+0 / Ctrl+滚轮。
   * 生效是异步的（投到 UI 线程），getZoom() 读的是缓存值。
   */
  setZoom(factor: number): number;
  /** 当前缩放倍率（缓存值） */
  getZoom(): number;
  /** 重新加载页面（等同 Ctrl+R / F5） */
  reload(): number;
  /** 打开开发者工具（等同 F12） */
  openDevTools(): number;
  /** 切换全屏（等同 F11）；全屏与最大化不同，连边框与任务栏一起让出 */
  toggleFullscreen(): number;
  /** 停止并释放窗口（可重复调用） */
  stop(): void;

  readonly started: boolean;
  readonly libInfo: NativeLibInfo;
  /** 逃生舱：直接访问 dlopen 出来的符号 */
  readonly symbols: NativeSymbols;

  // 排障面（hittest / metrics / dpi / selfBase / selfPath）已移到独立入口
  //     import { debugOf } from "webview-shell/debug"
  // 目的：公共面只承诺产品向能力。把排障面留在主入口，等于把它也变成契约，
  // 将来改一次诊断输出就成了破坏性变更。
};

export async function createShell(opts: ShellOptions): Promise<Shell> {
  if (!opts.url) throw new Error("createShell: url is required");

  const libInfo = await resolveNativeLib({
    ...(opts.nativeLibPath === undefined ? {} : { nativeLibPath: opts.nativeLibPath }),
    ...(opts.appName === undefined ? {} : { appName: opts.appName }),
    ...(opts.embedded === undefined ? {} : { embedded: opts.embedded }),
  });
  const { symbols } = openNativeLib(libInfo.path);

  let started = false;
  let stopped = false;

  // 拷贝式读出：shell_error() 返回共享缓冲区的指针，解锁后可能被别的线程改写
  const lastError = () => readBuffer((p, len) => symbols.shell_error_text(p, len), 512);

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
    show: () => symbols.shell_show(),
    setAppId: (appId) => symbols.shell_set_app_id(cstr(appId)),

    pickFolder(title?: string): string | null {
      const buf = new Uint8Array(4096);
      const rc = symbols.shell_pick_folder(
        cstr(title ?? "选择文件夹"),
        ptr(buf),
        buf.length,
      );
      if (rc !== 0) return null; // 1 = 取消，-1 = 失败
      const end = buf.indexOf(0);
      return new TextDecoder().decode(buf.subarray(0, end < 0 ? buf.length : end));
    },

    state(): WindowState {
      const raw = symbols.shell_get_state();
      return {
        raw,
        maximized: (raw & STATE_MAXIMIZED) !== 0,
        minimized: (raw & STATE_MINIMIZED) !== 0,
        focused: (raw & STATE_FOCUSED) !== 0,
        dark: symbols.shell_is_dark() !== 0,
      };
    },

    isAlive: () => symbols.shell_is_alive() !== 0,

    lastError,

    setZoom: (factor) => symbols.shell_set_zoom(factor),
    getZoom: () => symbols.shell_get_zoom(),
    reload: () => symbols.shell_reload(),
    openDevTools: () => symbols.shell_devtools(),
    toggleFullscreen: () => symbols.shell_toggle_fullscreen(),

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
