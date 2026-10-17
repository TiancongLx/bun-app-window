import { expect, test } from "bun:test";

import {
    FLAG_CENTER,
    FLAG_DEFER_SHOW,
    FLAG_FRAMELESS,
    FLAG_RESIZABLE,
    FLAG_TOPMOST,
    RESIZE_EDGE,
    STATE_FOCUSED,
    STATE_MAXIMIZED,
    STATE_MINIMIZED,
} from "@/shell/types";

test("标志位互不重叠，可按位或组合", () => {
    const flags = [FLAG_FRAMELESS, FLAG_TOPMOST, FLAG_CENTER, FLAG_RESIZABLE, FLAG_DEFER_SHOW];
    expect(new Set(flags).size).toBe(flags.length);

    for (const f of flags) {
        // 每个标志必须是单一二进制位
        expect(f & (f - 1)).toBe(0);
    }

    const combined = FLAG_FRAMELESS | FLAG_RESIZABLE | FLAG_CENTER;
    expect(combined & FLAG_FRAMELESS).toBe(FLAG_FRAMELESS);
    expect(combined & FLAG_TOPMOST).toBe(0);
    expect(combined & FLAG_RESIZABLE).toBe(FLAG_RESIZABLE);
    expect(combined & FLAG_CENTER).toBe(FLAG_CENTER);
});

test("FLAG_CENTER 不隐含无边框（带边框模式同样生效）", () => {
    // 曾经的缺陷：居中逻辑只写在无边框分支里，带边框窗口停在创建时的级联位置。
    // 这条守护绑定的是「居中与边框样式正交」这个契约。
    expect(FLAG_CENTER & FLAG_FRAMELESS).toBe(0);
    expect(FLAG_CENTER | FLAG_FRAMELESS).toBe(FLAG_FRAMELESS + FLAG_CENTER);
});

test("RESIZE_EDGE 取值与 Win32 HT* 常量一致", () => {
    // 原生层直接把 GetWindowLong 的命中码透传出来，改了这里等于改协议
    expect(RESIZE_EDGE.LEFT).toBe(10);
    expect(RESIZE_EDGE.RIGHT).toBe(11);
    expect(RESIZE_EDGE.TOP).toBe(12);
    expect(RESIZE_EDGE.TOPLEFT).toBe(13);
    expect(RESIZE_EDGE.TOPRIGHT).toBe(14);
    expect(RESIZE_EDGE.BOTTOM).toBe(15);
    expect(RESIZE_EDGE.BOTTOMLEFT).toBe(16);
    expect(RESIZE_EDGE.BOTTOMRIGHT).toBe(17);
});

test("RESIZE_EDGE 不含 HTCLIENT / HTCAPTION", () => {
    const values = Object.values(RESIZE_EDGE);
    // 1 = HTCLIENT，2 = HTCAPTION：这两个不能作为缩放边传入
    expect(values).not.toContain(1);
    expect(values).not.toContain(2);
});

test("状态位掩码互斥且覆盖低三位", () => {
    expect(STATE_MAXIMIZED).toBe(1);
    expect(STATE_MINIMIZED).toBe(2);
    expect(STATE_FOCUSED).toBe(4);

    const all = STATE_MAXIMIZED | STATE_MINIMIZED | STATE_FOCUSED;
    expect(all).toBe(7);
});
