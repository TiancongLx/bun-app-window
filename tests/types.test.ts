import { expect, test } from "bun:test";

import {
    FLAG_ACCEPT_DROP,
    FLAG_ALLOW_EXTERNAL_NAV,
    FLAG_CENTER,
    FLAG_DEFER_SHOW,
    FLAG_FRAMELESS,
    FLAG_RESIZABLE,
    FLAG_START_MAXIMIZED,
    FLAG_TOPMOST,
    RESIZE_EDGE,
    RESIZE_INDEX,
    STATE_FOCUSED,
    STATE_MAXIMIZED,
    STATE_MINIMIZED,
    ZOOM_LADDER,
    ZOOM_MAX,
    ZOOM_MIN,
    resizeIndex,
} from "@/shell/types";

test("标志位互不重叠，可按位或组合", () => {
    const flags = [
        FLAG_FRAMELESS,
        FLAG_TOPMOST,
        FLAG_CENTER,
        FLAG_RESIZABLE,
        FLAG_DEFER_SHOW,
        FLAG_ACCEPT_DROP,
        FLAG_START_MAXIMIZED,
        FLAG_ALLOW_EXTERNAL_NAV,
    ];
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

/**
 * 这一组守的是 0.5.x 那个真 bug：`RESIZE_EDGE` 是 HT* 常量（10–17），
 * 而原生 `shell_begin_resize()` 收的是 `codes[]` 的数组下标（0–7）。
 *
 * 关键点是映射**非线性**——`HTTOPLEFT`=13 落在下标 4、`HTBOTTOM`=15 落在下标 3，
 * 所以「减 10」看起来能对上三项，第四项就错。当年 `beginResize` 的实现直传入参，
 * 照注释传 `RESIZE_EDGE.LEFT` 必然 `rc=-1`，表现是「点了没反应」而门禁全绿。
 */
test("RESIZE_INDEX 与原生 codes[] 的顺序逐项一致", () => {
    // 顺序取自 native/shell.cc:
    //   {HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT}
    expect(RESIZE_INDEX[RESIZE_EDGE.LEFT]).toBe(0);
    expect(RESIZE_INDEX[RESIZE_EDGE.RIGHT]).toBe(1);
    expect(RESIZE_INDEX[RESIZE_EDGE.TOP]).toBe(2);
    expect(RESIZE_INDEX[RESIZE_EDGE.BOTTOM]).toBe(3);
    expect(RESIZE_INDEX[RESIZE_EDGE.TOPLEFT]).toBe(4);
    expect(RESIZE_INDEX[RESIZE_EDGE.TOPRIGHT]).toBe(5);
    expect(RESIZE_INDEX[RESIZE_EDGE.BOTTOMLEFT]).toBe(6);
    expect(RESIZE_INDEX[RESIZE_EDGE.BOTTOMRIGHT]).toBe(7);
});

test("RESIZE_INDEX 恰好 8 项，下标是 0..7 的一个排列", () => {
    const keys = Object.keys(RESIZE_INDEX);
    expect(keys.length).toBe(8);

    const indices = Object.values(RESIZE_INDEX).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("RESIZE_INDEX 不是「减 10」—— 这条专门防那次误判", () => {
    // 如果哪天有人把它「简化」成 value - 10，前三个仍然对，这三个会红。
    expect(RESIZE_INDEX[RESIZE_EDGE.BOTTOM]).not.toBe(RESIZE_EDGE.BOTTOM - 10);
    expect(RESIZE_INDEX[RESIZE_EDGE.TOPLEFT]).not.toBe(RESIZE_EDGE.TOPLEFT - 10);
    expect(RESIZE_INDEX[RESIZE_EDGE.TOPRIGHT]).not.toBe(RESIZE_EDGE.TOPRIGHT - 10);
});

test("resizeIndex 覆盖全部 8 个合法边，并对非法值返回 -1", () => {
    for (const edge of Object.values(RESIZE_EDGE)) {
        const idx = resizeIndex(edge);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(7);
    }

    // -1 交给原生 `edge < 0` 拒掉，与「窗口已销毁」同一个外部表现
    expect(resizeIndex(0)).toBe(-1);
    expect(resizeIndex(1)).toBe(-1);
    expect(resizeIndex(9)).toBe(-1);
    expect(resizeIndex(18)).toBe(-1);
    expect(resizeIndex(-10)).toBe(-1);
    expect(resizeIndex(Number.NaN)).toBe(-1);
});

test("ZOOM_LADDER 与原生 kZoomLadder 逐档一致", () => {
    // 14 档，首尾就是原生 apply_zoom 的钳制边界
    expect(ZOOM_LADDER.length).toBe(14);
    expect([...ZOOM_LADDER]).toEqual([
        0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
    ]);
});

test("ZOOM_MIN / ZOOM_MAX 就是阶梯首尾，且严格递增", () => {
    expect(ZOOM_MIN).toBe(ZOOM_LADDER[0]);
    expect(ZOOM_MAX).toBe(ZOOM_LADDER[ZOOM_LADDER.length - 1]);
    expect(ZOOM_MIN).toBe(0.25);
    expect(ZOOM_MAX).toBe(3.0);

    for (let i = 1; i < ZOOM_LADDER.length; i += 1) {
        const prev = ZOOM_LADDER[i - 1];
        const cur = ZOOM_LADDER[i];
        expect(prev).toBeDefined();
        expect(cur).toBeDefined();
        expect(cur as number).toBeGreaterThan(prev as number);
    }
});
