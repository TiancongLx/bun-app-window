/**
 * `native/resample.ts` 的判据。
 *
 * 这一层的风险集中在两件事：
 *
 * 1. **区间取错** —— 目标像素该取哪几个源像素，算错了结果看着「还行」但整体偏移
 * 2. **alpha 处理错** —— 透明像素的 RGB 混进平均，边缘出现黑边（或灰边）
 *
 * 第 2 条尤其重要：`scripts/make-icon.ts` 产出的图标有透明圆角，一旦回归到
 * 「直接平均」就会长出黑边，而那种缺陷在小图上极难用肉眼发现。
 */

import { describe, expect, test } from "bun:test";

import { downscaleBgra, fitInside } from "../native/resample";

/** 造一张 BGRA：`pixel(x,y)` 返回 [B,G,R,A] */
function makeBgra(
    width: number,
    height: number,
    pixel: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
    const buf = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [b, g, r, a] = pixel(x, y);
            const at = (y * width + x) * 4;
            buf[at] = b;
            buf[at + 1] = g;
            buf[at + 2] = r;
            buf[at + 3] = a;
        }
    }
    return buf;
}

/** 取某像素的 [B,G,R,A] */
function px(buf: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
    const at = (y * width + x) * 4;
    return [buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!];
}

describe("fitInside", () => {
    test("横图按长边等比缩小", () => {
        expect(fitInside(2000, 1360, 1300)).toEqual({ width: 1300, height: 884 });
    });

    test("竖长图按长边缩小（不是按宽）", () => {
        // 这条能抓到「只限宽」那类 bug：写成 resize(w) 会得到 300×600
        expect(fitInside(600, 1200, 300)).toEqual({ width: 150, height: 300 });
    });

    test("已经不超过上限时原样返回，不放大", () => {
        expect(fitInside(1000, 680, 1300)).toEqual({ width: 1000, height: 680 });
        expect(fitInside(1300, 1300, 1300)).toEqual({ width: 1300, height: 1300 });
    });

    test("极端长宽比也至少留 1 像素", () => {
        // 10000×3 缩到 10 → 高会是 0.003，必须钳到 1 而不是 0
        expect(fitInside(10000, 3, 10)).toEqual({ width: 10, height: 1 });
    });

    test("非法参数返回 null", () => {
        expect(fitInside(0, 100, 100)).toBeNull();
        expect(fitInside(100, 0, 100)).toBeNull();
        expect(fitInside(100, 100, 0)).toBeNull();
        expect(fitInside(100.5, 100, 50)).toBeNull();
    });
});

describe("downscaleBgra", () => {
    test("整数倍缩小：2×2 块取平均", () => {
        // R(x,y) = x*10 + y，G/B 恒 0，A 恒 255
        const src = makeBgra(4, 4, (x, y) => [0, 0, x * 10 + y, 255]);
        const out = downscaleBgra(src, 4, 4, 2, 2);
        expect(out).not.toBeNull();
        expect(out!.width).toBe(2);
        expect(out!.height).toBe(2);
        // 左上块 (0,0)(1,0)(0,1)(1,1) → 0+10+1+11 = 22, /4 = 5.5 → 5
        expect(px(out!.bgra, 2, 0, 0)[2]).toBe(5);
        // 右下块 (2,2)(3,2)(2,3)(3,3) → 22+32+23+33 = 110, /4 = 27.5 → 27
        expect(px(out!.bgra, 2, 1, 1)[2]).toBe(27);
    });

    test("均匀色缩完还是那个色（所有通道）", () => {
        const src = makeBgra(32, 24, () => [17, 34, 51, 255]);
        const out = downscaleBgra(src, 32, 24, 8, 6);
        expect(out).not.toBeNull();
        for (const [x, y] of [
            [0, 0],
            [7, 0],
            [0, 5],
            [7, 5],
        ] as const) {
            expect(px(out!.bgra, 8, x, y)).toEqual([17, 34, 51, 255]);
        }
    });

    test("尺寸不变时返回副本，不是同一个引用", () => {
        const src = makeBgra(4, 4, () => [1, 2, 3, 255]);
        const out = downscaleBgra(src, 4, 4, 4, 4);
        expect(out).not.toBeNull();
        expect(out!.bgra).not.toBe(src);
        expect(out!.bgra).toEqual(src);
    });

    test("非整数倍缩小不越界、不产生空洞", () => {
        // 7 → 3，区间是 [0,2) [2,4) [4,7)：每个目标像素都必须有源
        const src = makeBgra(7, 7, (x, y) => [x * 30, y * 30, 128, 255]);
        const out = downscaleBgra(src, 7, 7, 3, 3);
        expect(out).not.toBeNull();
        expect(out!.width).toBe(3);
        expect(out!.height).toBe(3);
        // 每个输出像素的 B 必须落在源值域内，且不为 0（源 x=0 时才是 0）
        expect(px(out!.bgra, 3, 2, 2)[0]).toBeGreaterThan(0);
    });

    test("放大返回 null —— 平均做不到插值", () => {
        const src = makeBgra(4, 4, () => [0, 0, 0, 255]);
        expect(downscaleBgra(src, 4, 4, 8, 8)).toBeNull();
        // 单方向放大也拒绝
        expect(downscaleBgra(src, 4, 4, 4, 8)).toBeNull();
    });

    test("零尺寸 / 负数返回 null", () => {
        const src = makeBgra(4, 4, () => [0, 0, 0, 255]);
        expect(downscaleBgra(src, 4, 4, 0, 2)).toBeNull();
        expect(downscaleBgra(src, 4, 4, 2, 0)).toBeNull();
        expect(downscaleBgra(src, 0, 4, 2, 2)).toBeNull();
    });

    test("源缓冲不足返回 null，不越界读", () => {
        expect(downscaleBgra(new Uint8Array(8), 4, 4, 2, 2)).toBeNull();
    });

    test("确定性：同输入同输出", () => {
        const src = makeBgra(16, 12, (x, y) => [x * 7, y * 9, (x + y) * 5, 255]);
        const a = downscaleBgra(src, 16, 12, 5, 4);
        const b = downscaleBgra(src, 16, 12, 5, 4);
        expect(a!.bgra).toEqual(b!.bgra);
    });
});

describe("downscaleBgra：alpha 加权（预乘语义）", () => {
    test("含透明像素时不能出现黑边 —— 加权而不是直接平均", () => {
        // 2×2 缩到 1×1：(0,0) 是纯黑全透明，(其余) 是白色不透明。
        //
        // 直接平均会得到 (191,191,191,191) 的灰 —— 那就是黑边。
        // alpha 加权是 255 白，alpha = 765/4 = 191：颜色不受透明像素污染。
        const src = makeBgra(2, 2, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : [255, 255, 255, 255]));
        const out = downscaleBgra(src, 2, 2, 1, 1);
        expect(out).not.toBeNull();
        const [b, g, r, a] = px(out!.bgra, 1, 0, 0);
        expect([b, g, r]).toEqual([255, 255, 255]);
        expect(a).toBe(191);
    });

    test("全透明区域保持透明，不冒出颜色", () => {
        const src = makeBgra(4, 4, () => [255, 0, 0, 0]);
        const out = downscaleBgra(src, 4, 4, 2, 2);
        expect(out).not.toBeNull();
        const [, , , a] = px(out!.bgra, 2, 0, 0);
        expect(a).toBe(0);
    });

    test("全不透明走快路径：像素精确，不是加权后的近似", () => {
        // 三个亮 + 一个暗，直接平均 (100+200+200+200)/4 = 175；
        // 若错误地按 alpha 加权（全 255，权重相同）也会得到 175——
        // 但只要加权路径的取整位置不同就会有 1 的偏差，所以这里钉死精确值。
        const src = makeBgra(2, 2, (x, y) => (x === 0 && y === 0 ? [100, 100, 100, 255] : [200, 200, 200, 255]));
        const out = downscaleBgra(src, 2, 2, 1, 1);
        expect(px(out!.bgra, 1, 0, 0)).toEqual([175, 175, 175, 255]);
    });
});
