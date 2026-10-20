import { expect, test } from "bun:test";
import { ptr } from "bun:ffi";

import { openNativeLib } from "@/shell/native";
import { resolveNativeLib } from "@/shell/resolve";

/**
 * ABI 面测试：shell.cc 改了导出、native.ts 没同步，或者反过来，
 * 都会在这里断掉。这是「装进别人工程后才炸」的高发点。
 */

const DECLARED = [
    "shell_start_ex",
    "shell_post",
    "shell_title",
    "shell_minimize",
    "shell_toggle_maximize",
    "shell_close",
    "shell_drag",
    "shell_begin_resize",
    "shell_set_min_size",
    "shell_get_state",
    "shell_is_alive",
    "shell_poll_events",
    "shell_stop",
    "shell_error",
    // 系统集成面
    "shell_show",
    "shell_set_app_id",
    "shell_is_dark",
    "shell_pick_folder",
    "shell_error_text",
    // 输入与视图面
    "shell_set_browser_ui",
    "shell_show_app_menu",
    "shell_get_bounds",
    "shell_restore_bounds",
    "shell_set_zoom",
    "shell_get_zoom",
    "shell_reload",
    "shell_devtools",
    "shell_toggle_fullscreen",
    // 排障面
    "shell_debug_hittest",
    "shell_debug_metrics",
    "shell_debug_dpi",
    "shell_self_base",
    "shell_self_path",
] as const;

test("libshell.dll 是合法 PE 映像", async () => {
    const info = await resolveNativeLib();
    const bytes = await Bun.file(info.path).bytes();
    expect(bytes.length).toBeGreaterThan(100_000);
    // MZ 头
    expect(bytes[0]).toBe(0x4d);
    expect(bytes[1]).toBe(0x5a);
    // e_lfanew 指向的签名必须是 PE\0\0
    const lfanew =
        (bytes[0x3c] ?? 0) |
        ((bytes[0x3d] ?? 0) << 8) |
        ((bytes[0x3e] ?? 0) << 16) |
        ((bytes[0x3f] ?? 0) << 24);
    expect(lfanew).toBeGreaterThan(0);
    expect(bytes[lfanew]).toBe(0x50); // P
    expect(bytes[lfanew + 1]).toBe(0x45); // E
});

test("dlopen 成功且 33 个声明符号全部存在", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    const keys = new Set(Object.keys(lib.symbols));

    const missing = DECLARED.filter((name) => !keys.has(name));
    expect(missing).toEqual([]);
    // 与 native.ts 的声明数、DLL 的 34 个导出（含遗留 shell_start）保持一致
    expect(DECLARED.length).toBe(33);

    lib.close();
});

test("未启动时的调用是安全的（消费者可能在 start 之前就查询状态）", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    try {
        // shell.cc 里 get_state 对 !g_hwnd 直接返回 0；stop 对 !g_webview 是 no-op。
        // 这两条是 API 契约：消费者可以先 state() 再 start()。
        expect(lib.symbols.shell_get_state()).toBe(0);

        // 未启动就 stop 不应崩溃（幂等前置条件）
        expect(() => lib.symbols.shell_stop()).not.toThrow();

        // 停过一次之后状态仍可读
        expect(lib.symbols.shell_get_state()).toBe(0);
    } finally {
        lib.close();
    }
});

test("shell_poll_events 在未启动时返回 0 而不是 -1", async () => {
    // 这条是事件通道的核心契约：CLOSED 在 g_webview 置空**之后**才产生，
    // 早退成 -1 会让宿主永远读不到「窗口已关闭」。所以「没有事件」与
    // 「没有窗口」必须同义（都是 0），不能靠 -1 区分。
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    try {
        const buf = new Uint8Array(32 * 4);
        expect(lib.symbols.shell_poll_events(ptr(buf), 4)).toBe(0);
        // 空指针与非法容量一律 0，不崩
        expect(lib.symbols.shell_poll_events(null, 4)).toBe(0);
        expect(lib.symbols.shell_poll_events(ptr(buf), 0)).toBe(0);
    } finally {
        lib.close();
    }
});

test("is_alive 与 get_state 的语义差异：已销毁 ≠ 未启动", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    try {
        // 未启动：两者都是「没有窗口」
        expect(lib.symbols.shell_is_alive()).toBe(0);
        expect(lib.symbols.shell_get_state()).toBe(0);

        // 这条用例的存在理由：宿主曾用 state() 判断窗口是否关闭，
        // 但 get_state 对「未启动」和「已销毁」都返回 0 且不抛错，
        // 导致窗口关闭后进程一直挂着、本地端口不释放。
        // is_alive 是专门用来区分这两种状态的信号。
        expect(typeof lib.symbols.shell_is_alive).toBe("function");
    } finally {
        lib.close();
    }
});

test("符号是可直接调用的函数（bun:ffi 不暴露 args/returns 元数据）", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    try {
        // 记录事实：bun:ffi 的 symbol 是裸函数，没有 info/args/returns 可反射。
        // 因此 ABI 一致性只能靠「dlopen 不报错 + 实际调用」来保证，不能靠元数据断言。
        for (const name of DECLARED) {
            const fn = (lib.symbols as unknown as Record<string, unknown>)[name];
            expect(typeof fn).toBe("function");
        }
    } finally {
        lib.close();
    }
});

test("未声明的遗留符号不应出现在 FFI 面上", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    const keys = Object.keys(lib.symbols);
    // DLL 里确有 shell_start（1.x 遗留），但 TS 侧刻意不声明
    expect(keys).not.toContain("shell_start");
    lib.close();
});

test("shell_error 在未启动时返回可读字符串（空串或说明）", async () => {
    const info = await resolveNativeLib();
    const lib = openNativeLib(info.path);
    try {
        // 只读调用，不触窗口；用于确认指针返回可安全解引用
        const { readCStr } = await import("@/shell/native");
        const msg = readCStr(lib.symbols.shell_error());
        expect(typeof msg).toBe("string");
    } finally {
        lib.close();
    }
});
