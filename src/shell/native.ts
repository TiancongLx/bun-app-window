/**
 * native.ts — 原生库的 FFI 声明与字符串工具
 *
 * 只负责「怎么调」，不负责「库在哪」（后者见 resolve.ts）。
 */

import { CString, FFIType, dlopen, ptr } from "bun:ffi";
import type { Pointer } from "bun:ffi";

/**
 * 打开 libshell.dll。
 *
 * 导出面说明：DLL 实际导出 33 个符号，其中 `shell_start` 是 1.x 遗留入口，
 * TS 侧不声明、也不对外承诺（故下方声明 32 个）；`shell_debug_*` / `shell_self_*` 属排障面。
 */
export function openNativeLib(path: string) {
  return dlopen(path, {
    shell_start_ex: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    shell_post: { args: [FFIType.ptr], returns: FFIType.i32 },
    shell_title: { args: [FFIType.ptr], returns: FFIType.i32 },
    shell_minimize: { args: [], returns: FFIType.i32 },
    shell_toggle_maximize: { args: [], returns: FFIType.i32 },
    shell_close: { args: [], returns: FFIType.i32 },
    shell_drag: { args: [], returns: FFIType.i32 },
    shell_begin_resize: { args: [FFIType.i32], returns: FFIType.i32 },
    shell_set_min_size: { args: [FFIType.i32, FFIType.i32], returns: FFIType.void },
    shell_get_state: { args: [], returns: FFIType.i32 },
    shell_is_alive: { args: [], returns: FFIType.i32 },
    shell_stop: { args: [], returns: FFIType.void },
    shell_error: { args: [], returns: FFIType.ptr },
    // 系统集成面
    shell_show: { args: [], returns: FFIType.i32 },
    shell_set_app_id: { args: [FFIType.ptr], returns: FFIType.i32 },
    shell_is_dark: { args: [], returns: FFIType.i32 },
    shell_pick_folder: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_error_text: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },

    // 应用化面（关掉浏览器行为 + 应用自定义右键菜单）
    shell_set_browser_ui: { args: [FFIType.i32], returns: FFIType.i32 },
    shell_show_app_menu: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },

    // 窗口位置面
    shell_get_bounds: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_restore_bounds: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },

    // 输入与视图面
    shell_set_zoom: { args: [FFIType.f64], returns: FFIType.i32 },
    shell_get_zoom: { args: [], returns: FFIType.f64 },
    shell_reload: { args: [], returns: FFIType.i32 },
    shell_devtools: { args: [], returns: FFIType.i32 },
    shell_toggle_fullscreen: { args: [], returns: FFIType.i32 },

    // 排障面：不进稳定契约
    shell_debug_hittest: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    shell_debug_metrics: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_debug_dpi: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    shell_self_base: { args: [], returns: FFIType.u64 },
    shell_self_path: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}

export type NativeLib = ReturnType<typeof openNativeLib>;
export type NativeSymbols = NativeLib["symbols"];

/** JS 字符串 → 以 NUL 结尾的 UTF-8 C 字符串指针 */
export const cstr = (s: string) => ptr(new TextEncoder().encode(`${s}\0`));

/** C 字符串指针 → JS 字符串；空指针或异常返回空串 */
export function readCStr(p: unknown): string {
  if (!p) return "";
  try {
    return new CString(p as never).toString();
  } catch {
    return "";
  }
}

/** 读取原生侧写入定长缓冲的 UTF-8 文本 */
export function readBuffer(
  fill: (p: Pointer, len: number) => number,
  size = 1024,
): string {
  const buf = new Uint8Array(size);
  const n = fill(ptr(buf), buf.length);
  return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "";
}
