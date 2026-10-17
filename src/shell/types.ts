/**
 * types.ts — 内核的公共类型与常量
 *
 * 这里的类型是**稳定面**：改动需要按语义化版本对待。
 * 调试自省类能力单独放在 Shell["debug"] 下，不视为稳定契约。
 */

/** 无边框：原生层不画标题栏与边框，由页面自绘 */
export const FLAG_FRAMELESS = 1;
/** 置顶 */
export const FLAG_TOPMOST = 2;
/**
 * 启动时把窗口居中到所在显示器的工作区（避开任务栏）。
 *
 * 带边框与无边框两种模式都生效。窗口比工作区大时会先收缩到工作区内再居中——
 * 高 DPI 下这很常见（900×940 逻辑像素在 200% 缩放加边框就是 1950 物理像素高，
 * 超过 1824 的工作区），不收缩只能贴顶，垂直方向看不出居中。
 */
export const FLAG_CENTER = 4;
/** 可缩放（配合无边框时，边框拖拽区由 shell_begin_resize 提供） */
export const FLAG_RESIZABLE = 8;
/**
 * 创建后先不显示，等调用方确认页面就绪再 `shell.show()`。
 * 用于消除「空窗口先出现、内容后填上」的首帧闪烁。
 */
export const FLAG_DEFER_SHOW = 16;

/** 缩放边框的 8 个命中边，取值与 Win32 HT* 常量一致 */
export const RESIZE_EDGE = {
  LEFT: 10,
  RIGHT: 11,
  TOP: 12,
  TOPLEFT: 13,
  TOPRIGHT: 14,
  BOTTOM: 15,
  BOTTOMLEFT: 16,
  BOTTOMRIGHT: 17,
} as const;

export type ResizeEdge = (typeof RESIZE_EDGE)[keyof typeof RESIZE_EDGE];

/** window state 位掩码（与原生 shell_get_state 一致） */
export const STATE_MAXIMIZED = 1;
export const STATE_MINIMIZED = 2;
export const STATE_FOCUSED = 4;

export type WindowState = {
  raw: number;
  maximized: boolean;
  minimized: boolean;
  focused: boolean;
  /** 系统当前是否深色（原生侧读 AppsUseLightTheme，并随 WM_SETTINGCHANGE 刷新） */
  dark: boolean;
};

/** 原生库的解析结果 */
export type NativeLibInfo = {
  path: string;
  /**
   * explicit  — 调用方显式指定
   * dev       — 本仓开发态（build/ 或 dist/）
   * package   — 包内 dist/ 或可执行文件同级
   * embedded  — 从编译产物内嵌字节释放
   * fallback-tmp — 受限环境下退回 Bun 默认释放
   */
  source: "explicit" | "dev" | "package" | "embedded" | "fallback-tmp";
  sha256: string;
  bytes: number;
  reused: boolean;
  pruned: string[];
};

export type ShellOptions = {
  /** 要加载的 URL（通常是本地回环地址） */
  url: string;
  title?: string;
  width?: number;
  height?: number;
  /** FLAG_* 位组合 */
  flags?: number;
  /** 启动后立即设置的最小尺寸（逻辑像素） */
  minWidth?: number;
  minHeight?: number;
  /**
   * 原生库路径。给定时跳过所有自动解析。
   * 用于测试或多副本部署。
   */
  nativeLibPath?: string;
  /**
   * 运行时数据目录名（`%LOCALAPPDATA%\<appName>\runtime`）。
   * 同一机器上多个应用共用一个包时应各自指定，避免互相清理 DLL 副本。
   */
  appName?: string;
  /**
   * 编译产物内嵌字节的提供者。
   * 使用 `bun build --compile` 时传入 `embeddedDll`（见 `webview-shell/embedded`）。
   */
  embedded?: () => Promise<Uint8Array | null>;
};

export type StartResult = { rc: number; error: string };
