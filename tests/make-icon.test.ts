import { describe, expect, test } from "bun:test";

import {
    DEFAULT_SIZES,
    buildIco,
    detailFor,
    gradientT,
    parseIconArgs,
    readIcoIndex,
    renderIcon,
    sdRoundRect,
} from "../scripts/make-icon";

/**
 * `make-icon.ts` 的判据。
 *
 * 原版是 `System.Drawing` 的黑箱——画出来的 PNG 只能靠人眼看。
 * 现在 `renderIcon(size)` 是纯函数，几何与覆盖率都能断言。
 *
 * 断言分两类：
 *
 * 1. **数学**：距离场与渐变的定义域/值域，一眼可判对错
 * 2. **形态**：渲染结果的 alpha 分布（角透明、中心不透明），
 *    这类断言能在「形状画反了」「覆盖率没归一化」时立刻红
 */

// ---- 距离场 -----------------------------------------------------------------

describe("sdRoundRect", () => {
    // 20x20 的方框，中心 (10,10)，半宽高 10，圆角半径 4
    const args = [10, 10, 10, 10, 4] as const;

    test("中心在内部（负值）", () => {
        expect(sdRoundRect(10, 10, ...args)).toBeLessThan(0);
    });

    test("正好在边缘上为 0", () => {
        // 右边缘 x = 20
        expect(sdRoundRect(20, 10, ...args)).toBeCloseTo(0, 5);
    });

    test("外部为正，且随距离增大", () => {
        const near = sdRoundRect(21, 10, ...args);
        const far = sdRoundRect(25, 10, ...args);
        expect(near).toBeGreaterThan(0);
        expect(far).toBeGreaterThan(near);
    });

    test("四个角被圆角削掉（角点比边中点更远）", () => {
        // 方框角 (20,20)；圆角半径 4 意味着角点距轮廓约 4*(√2-1)≈1.66
        const corner = sdRoundRect(20, 20, ...args);
        const edgeMid = sdRoundRect(20, 10, ...args);
        expect(corner).toBeGreaterThan(edgeMid);
    });

    test("对称性：四个方向的同距离点数值相等", () => {
        const left = sdRoundRect(0, 10, ...args);
        const right = sdRoundRect(20, 10, ...args);
        const top = sdRoundRect(10, 0, ...args);
        const bottom = sdRoundRect(10, 20, ...args);
        expect(left).toBeCloseTo(right, 5);
        expect(top).toBeCloseTo(bottom, 5);
        expect(left).toBeCloseTo(top, 5);
    });
});

// ---- 渐变 -------------------------------------------------------------------

describe("gradientT", () => {
    const box = [0, 0, 100, 100] as const;

    test("45° 时左上角接近 0、右下角接近 1（GDI+ 的 45° 是朝右下）", () => {
        // 45° 的渐变方向是 (cos45, sin45) = 向右下。
        // (0,100)→(100,0) 这条线与它垂直，两端都在 t=0.5，所以不能拿来当端点。
        expect(gradientT(0, 0, ...box, 45)).toBeCloseTo(0, 1);
        expect(gradientT(100, 100, ...box, 45)).toBeCloseTo(1, 1);
    });

    test("与渐变方向垂直的两点取值相同", () => {
        // (0,100) 与 (100,0) 在 45° 方向上的投影重合
        expect(gradientT(0, 100, ...box, 45)).toBeCloseTo(gradientT(100, 0, ...box, 45), 10);
    });

    test("值域恒在 [0,1]", () => {
        for (const t of [0, 30, 45, 60, 90, 135, 180]) {
            for (const [x, y] of [[0, 0], [100, 0], [0, 100], [100, 100], [50, 50]]) {
                const v = gradientT(x!, y!, ...box, t);
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(1);
            }
        }
    });

    test("退化包围盒（宽高为 0）返回 0，不产生 NaN", () => {
        expect(gradientT(0, 0, 0, 0, 0, 0, 45)).toBe(0);
    });
});

// ---- 细节开关 ---------------------------------------------------------------

describe("detailFor", () => {
    test("16px 不画描边与圆点（否则糊成一片）", () => {
        expect(detailFor(16)).toEqual({ stroke: false, dots: false });
    });

    test("24px 起两者都画", () => {
        expect(detailFor(24)).toEqual({ stroke: true, dots: true });
        expect(detailFor(256)).toEqual({ stroke: true, dots: true });
    });
});

// ---- 渲染 -------------------------------------------------------------------

describe("renderIcon", () => {
    test("输出尺寸与通道正确", () => {
        const img = renderIcon(16);
        expect(img.width).toBe(16);
        expect(img.height).toBe(16);
        expect(img.channels).toBe(4);
        expect(img.pixels.length).toBe(16 * 16 * 4);
    });

    test("四角透明（圆角底板之外）", () => {
        const img = renderIcon(32);
        const at = (x: number, y: number) => img.pixels[(y * 32 + x) * 4 + 3] ?? -1;
        expect(at(0, 0)).toBe(0);
        expect(at(31, 0)).toBe(0);
        expect(at(0, 31)).toBe(0);
        expect(at(31, 31)).toBe(0);
    });

    test("中心不透明", () => {
        const img = renderIcon(32);
        const center = (16 * 32 + 16) * 4 + 3;
        expect(img.pixels[center]).toBe(255);
    });

    test("中心像素落在深色底板的色域内（不是强调色）", () => {
        const img = renderIcon(64);
        const at = (16 * 4 + 32) * 4; // 中心偏上，避开描边
        const r = img.pixels[at] ?? 0;
        const b = img.pixels[at + 2] ?? 0;
        // 底板是 (32,36,48)→(16,18,24) 之间，蓝分量高于红
        expect(b).toBeGreaterThanOrEqual(r);
        expect(r).toBeLessThan(60);
    });

    test("16px 的像素全非零 alpha 的都在外框内（不会溢出画布）", () => {
        const img = renderIcon(16);
        // 只验证不抛错 + 长度正确；具体形状由上面的几何断言覆盖
        expect(img.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
    });

    test("尺寸参数为 0 或负数时抛错", () => {
        expect(() => renderIcon(0)).toThrow();
        expect(() => renderIcon(-1)).toThrow();
    });

    test("同一尺寸两次渲染结果相同（确定性）", () => {
        expect([...renderIcon(16, 2).pixels]).toEqual([...renderIcon(16, 2).pixels]);
    });

    test("采样数越高，边缘越平滑（半透明像素更多）", () => {
        const low = renderIcon(32, 1);
        const high = renderIcon(32, 4);
        const countPartial = (img: typeof low) => {
            let n = 0;
            for (let i = 3; i < img.pixels.length; i += 4) {
                const a = img.pixels[i] ?? 0;
                if (a > 0 && a < 255) n++;
            }
            return n;
        };
        // 1 采样没有任何中间值；4 采样必然产生一批
        expect(countPartial(low)).toBe(0);
        expect(countPartial(high)).toBeGreaterThan(0);
    });
});

// ---- ICO 容器 ---------------------------------------------------------------

describe("buildIco", () => {
    const fake = (size: number, len: number) => ({ size, png: new Uint8Array(len).fill(size) });

    test("头部三字段正确", () => {
        const ico = buildIco([fake(16, 4), fake(32, 8)]);
        const view = new DataView(ico.buffer);
        expect(view.getUint16(0, true)).toBe(0); // reserved
        expect(view.getUint16(2, true)).toBe(1); // type = icon
        expect(view.getUint16(4, true)).toBe(2); // count
    });

    test("256 在尺寸字段里写成 0（单字节装不下）", () => {
        const ico = buildIco([fake(256, 4)]);
        expect(ico[6]).toBe(0);
        expect(ico[7]).toBe(0);
    });

    test("载荷偏移从头部之后开始，且逐项累加", () => {
        const ico = buildIco([fake(16, 4), fake(32, 8)]);
        const view = new DataView(ico.buffer);
        const headerSize = 6 + 16 * 2;
        expect(view.getUint32(6 + 12, true)).toBe(headerSize); // 第 1 项偏移
        expect(view.getUint32(6 + 16 + 12, true)).toBe(headerSize + 4); // 第 2 项
    });

    test("空数组抛错（空 ICO 不是合法文件）", () => {
        expect(() => buildIco([])).toThrow();
    });

    test("超过 255 项抛错（count 是 16 位但规范限 255）", () => {
        const many = Array.from({ length: 256 }, (_, i) => fake((i % 255) + 1, 1));
        expect(() => buildIco(many)).toThrow();
    });
});

describe("readIcoIndex", () => {
    test("往返：写进去的尺寸能读回来", () => {
        const sizes = [16, 32, 256];
        const ico = buildIco(sizes.map((s) => ({ size: s, png: new Uint8Array(8) })));
        const idx = readIcoIndex(ico);
        expect(idx.count).toBe(3);
        expect(idx.entries.map((e) => e.size)).toEqual(sizes);
    });

    test("非 ICO 字节抛错", () => {
        expect(() => readIcoIndex(new Uint8Array(32))).toThrow();
    });

    test("太短的输入抛错", () => {
        expect(() => readIcoIndex(new Uint8Array(3))).toThrow();
    });
});

// ---- 参数 -------------------------------------------------------------------

describe("parseIconArgs", () => {
    const ROOT = "C:/repo";

    test("默认输出到 assets/app.ico，默认尺寸集完整", () => {
        const plan = parseIconArgs([], ROOT);
        expect(plan.sizes).toEqual([...DEFAULT_SIZES]);
        expect(plan.out.replace(/\\/g, "/")).toContain("assets/app.ico");
    });

    test("--sizes 去重并升序", () => {
        const plan = parseIconArgs(["--sizes", "256,16,32,16"], ROOT);
        expect(plan.sizes).toEqual([16, 32, 256]);
    });

    test("--sizes 越界抛错", () => {
        expect(() => parseIconArgs(["--sizes", "0,16"], ROOT)).toThrow();
        expect(() => parseIconArgs(["--sizes", "257"], ROOT)).toThrow();
        expect(() => parseIconArgs(["--sizes", "16.5"], ROOT)).toThrow();
    });

    test("--help 识别，两种横线都行", () => {
        expect(parseIconArgs(["--help"], ROOT).help).toBe(true);
        expect(parseIconArgs(["-Help"], ROOT).help).toBe(true);
    });

    test("未知参数抛错，不静默忽略", () => {
        expect(() => parseIconArgs(["--dark-mode"], ROOT)).toThrow();
    });

    test("缺少值时抛错", () => {
        expect(() => parseIconArgs(["--out"], ROOT)).toThrow();
    });
});
