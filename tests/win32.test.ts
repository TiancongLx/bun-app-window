import { describe, expect, test } from "bun:test";

import {
    activeConsoleSessionId,
    closeAll,
    currentSessionId,
    indexOfBytes,
    isCommittedRegion,
    listPids,
    listTopLevelWindows,
    readRect,
    readUtf16,
    setDpiAware,
    toHandle,
    utf16z,
    type MemoryRegion,
} from "../native/win32";

/**
 * `native/win32.ts` 的判据。
 *
 * 分两层：
 *
 * - **纯函数**（字符串、句柄归一化、字节搜索、RECT 解析）：完整断言
 * - **真实 FFI 调用**（枚举窗口、列 PID）：只断言「不抛错 + 形状正确」，
 *   **不断言数量** —— 数量取决于当时开了多少程序，写死数字必然漂移
 *
 * 第二层的克制是有意的：一条依赖环境快照的断言会在别人的机器上红，
 * 而它红的时候并不说明代码有问题。
 */

// ---- 字符串 -----------------------------------------------------------------

describe("utf16z / readUtf16", () => {
    test("往返：ASCII", () => {
        expect(readUtf16(utf16z("hello"))).toBe("hello");
    });

    test("往返：中文（每个字符 2 字节，不是 UTF-8 的 3 字节）", () => {
        expect(readUtf16(utf16z("鲸鱼酱"))).toBe("鲸鱼酱");
    });

    test("往返：emoji 走代理对", () => {
        expect(readUtf16(utf16z("🪼"))).toBe("🪼");
    });

    test("空串得到 2 字节（只有一个 NUL）", () => {
        expect(utf16z("").length).toBe(2);
        expect(readUtf16(utf16z(""))).toBe("");
    });

    test("尾部有 NUL，且长度是 (字符数+1)*2", () => {
        const buf = utf16z("ab");
        expect(buf.length).toBe(6);
        expect(buf[4]).toBe(0);
        expect(buf[5]).toBe(0);
    });

    test("带偏移读取", () => {
        const a = utf16z("xy");
        const merged = new Uint8Array(a.length * 2);
        merged.set(a, 0);
        merged.set(utf16z("zz"), a.length);
        expect(readUtf16(merged, a.length)).toBe("zz");
    });

    test("没有 NUL 时读到缓冲末尾，不越界", () => {
        // 手工构造一段没有终止符的 UTF-16
        const buf = new Uint8Array([0x41, 0x00, 0x42, 0x00]);
        expect(readUtf16(buf)).toBe("AB");
    });
});

// ---- 句柄归一化 -------------------------------------------------------------

describe("toHandle", () => {
    test("bigint 原样返回", () => {
        expect(toHandle(123n)).toBe(123n);
    });

    test("正 number 转 bigint", () => {
        expect(toHandle(456)).toBe(456n);
    });

    test("0 / null / undefined 都归一为 0n（空句柄）", () => {
        expect(toHandle(0)).toBe(0n);
        expect(toHandle(0n)).toBe(0n);
        expect(toHandle(null)).toBe(0n);
        expect(toHandle(undefined)).toBe(0n);
    });

    test("NaN / Infinity 也归一为 0n，不产生 BigInt 抛错", () => {
        expect(toHandle(Number.NaN)).toBe(0n);
        expect(toHandle(Number.POSITIVE_INFINITY)).toBe(0n);
    });
});

// ---- 字节搜索 ---------------------------------------------------------------

describe("indexOfBytes", () => {
    const hay = new TextEncoder().encode("...shell_debug_dpi...");

    test("找到时返回首次偏移", () => {
        const needle = new TextEncoder().encode("shell_debug_dpi");
        expect(indexOfBytes(hay, needle)).toBe(3);
    });

    test("找不到返回 -1", () => {
        expect(indexOfBytes(hay, new TextEncoder().encode("nope"))).toBe(-1);
    });

    test("空 needle 返回 0（定义为「空串在位置 0 匹配」）", () => {
        expect(indexOfBytes(hay, new Uint8Array(0))).toBe(0);
    });

    test("needle 比 haystack 长返回 -1，不抛错", () => {
        expect(indexOfBytes(new Uint8Array(2), new Uint8Array(10))).toBe(-1);
    });

    test("重复前缀也能定位（首字节相同的干扰项）", () => {
        const data = new TextEncoder().encode("aaaaab");
        expect(indexOfBytes(data, new TextEncoder().encode("aab"))).toBe(3);
    });
});

// ---- RECT -------------------------------------------------------------------

describe("readRect", () => {
    test("四个 int32 小端", () => {
        const buf = new Uint8Array(16);
        const view = new DataView(buf.buffer);
        view.setInt32(0, 10, true);
        view.setInt32(4, 20, true);
        view.setInt32(8, 110, true);
        view.setInt32(12, 220, true);
        expect(readRect(buf)).toEqual({ left: 10, top: 20, right: 110, bottom: 220 });
    });

    test("支持负坐标（窗口在屏幕左侧之外）", () => {
        const buf = new Uint8Array(16);
        const view = new DataView(buf.buffer);
        view.setInt32(0, -500, true);
        view.setInt32(8, 500, true);
        const r = readRect(buf);
        expect(r.left).toBe(-500);
        expect(r.right).toBe(500);
        expect(r.right - r.left).toBe(1000);
    });

    test("支持偏移读取", () => {
        const buf = new Uint8Array(32);
        const view = new DataView(buf.buffer);
        view.setInt32(16, 7, true);
        expect(readRect(buf, 16).left).toBe(7);
    });
});

// ---- 真实 FFI ---------------------------------------------------------------

describe("真实 Win32 调用（不断言数量）", () => {
    test("setDpiAware 不抛错", () => {
        expect(() => setDpiAware()).not.toThrow();
    });

    test("listTopLevelWindows 返回结构正确的数组", () => {
        const wins = listTopLevelWindows();
        expect(Array.isArray(wins)).toBe(true);
        // 任何 Windows 桌面至少有一个顶层窗口；但干净会话里也可能是 0，
        // 所以只验证「如果有，字段形状对」
        for (const w of wins.slice(0, 5)) {
            expect(typeof w.hwnd).toBe("bigint");
            expect(typeof w.className).toBe("string");
            expect(typeof w.pid).toBe("number");
            expect(typeof w.visible).toBe("boolean");
            expect(w.width).toBe(w.rect.right - w.rect.left);
            expect(w.height).toBe(w.rect.bottom - w.rect.top);
        }
    });

    test("listPids 至少包含自己", () => {
        const pids = listPids();
        expect(pids.length).toBeGreaterThan(0);
        expect(pids).toContain(process.pid);
    });

    test("currentSessionId 是合法会话号", () => {
        const sid = currentSessionId();
        expect(Number.isInteger(sid)).toBe(true);
        expect(sid).toBeGreaterThanOrEqual(0);
    });

    test("activeConsoleSessionId 返回数字（无控制台时为 -1）", () => {
        const sid = activeConsoleSessionId();
        expect(typeof sid).toBe("number");
    });

    test("isCommittedRegion 只认 0x1000", () => {
        const base: MemoryRegion = { base: 0n, size: 4096n, state: 0x1000, protect: 0x04, type: 0x20000 };
        expect(isCommittedRegion(base)).toBe(true);
        expect(isCommittedRegion({ ...base, state: 0x10000 })).toBe(false); // MEM_RESERVE
        expect(isCommittedRegion({ ...base, state: 0x10000 | 0x1000 })).toBe(false);
    });

    test("closeAll 可调用且重复调用不抛错", () => {
        expect(() => closeAll()).not.toThrow();
    });
});
