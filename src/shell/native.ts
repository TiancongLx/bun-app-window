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
 * 导出面说明：`shell_start` 是 1.x 遗留入口，TS 侧不声明、也不对外承诺；
 * `shell_debug_*` / `shell_self_*` 属排障面。声明总数由
 * `tests/native-surface.test.ts` 的 `DECLARED` 钉住——本文不写数字，避免随增删漂移。
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
        // 窗口生命周期事件：批量拉取（消费式），capacity 是记录条数
        shell_poll_events: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
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

        // 读回面（ADR 0023）：三个 setter 的同步直读。不进命令队列——getter 必须当场给值。
        //   shell_get_title       写入 UTF-8，返回字节数；< 0 表示窗口不存在或装不下
        //   shell_get_min_size    写入 "w,h"，返回长度；< 0 表示窗口不存在
        //   shell_get_browser_ui  返回累积的位掩码，0 = 什么都没关
        shell_get_title: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        shell_get_min_size: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        shell_get_browser_ui: { args: [], returns: FFIType.i32 },

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
        // 运行时形态切换（ADR 0019）。只在创建期给了 SHELL_FLAG_FRAMELESS 时可用，
        // 否则 set 返回 -1 并把理由写进 shell_error_text；is 恒回创建期形态。
        shell_set_frameless: { args: [FFIType.i32], returns: FFIType.i32 },
        shell_is_frameless: { args: [], returns: FFIType.i32 },

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
export function readBuffer(fill: (p: Pointer, len: number) => number, size = 1024): string {
    const buf = new Uint8Array(size);
    const n = fill(ptr(buf), buf.length);
    return n > 0 ? new TextDecoder().decode(buf.subarray(0, n)) : "";
}
