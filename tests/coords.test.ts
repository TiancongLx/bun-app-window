import { expect, test } from "bun:test";

import {
    boxFromRect,
    clientShift,
    clientToImage,
    frameFor,
    imageToClient,
    imageToScreen,
    imageToWindow,
    insideClient,
    insideImage,
    roundPoint,
    scaleOf,
    screenToImage,
    screenToWindow,
    windowToClient,
    windowToScreen,
    type Box,
    type ShotFrame,
} from "../tools/coords";

/**
 * 截图坐标映射。
 *
 * 这一层是 Computer Use 的「视线 → 手」转换：模型在一张图上圈出的点，要变成
 * `SendInput` 能吃的屏幕坐标。全链路都是线性变换，所以**每一个判据都可以用闭式
 * 答案钉死**，不需要真窗口。真窗口只能证明「没崩」，证明不了「没偏」。
 *
 * 四类故障各对应一组断言：
 *   1. 漏掉裁剪偏移 → 截图裁过之后就整块偏
 *   2. 缩放方向搞反（乘 vs 除）→ 图被缩过就偏得离谱
 *   3. 客户区位置当成尺寸用（`GetClientRect().left` 恒为 0）→ 点击总落在左上角
 *   4. 中间环节取整 → 几百像素外差出一个控件
 */

/**
 * 一张 1600×1000 的整窗图，窗口在屏幕 (100, 200)。
 *
 * 客户区左上角在屏幕 (108, 240)：左边框 8px、标题栏 40px——与 `pitfalls` 六章记录的
 * 「96dpi 下边框 8px」一致。客户区尺寸 1584×952 = 整窗减左右各 8、上 40、下 8。
 */
function frame(over: Partial<ShotFrame> = {}): ShotFrame {
    const base: ShotFrame = {
        image: { width: 1600, height: 1000 },
        full: { width: 1600, height: 1000 },
        window: { x: 100, y: 200, width: 1600, height: 1000 },
        clientOrigin: { x: 108, y: 240 },
        client: { width: 1584, height: 952 },
        crop: null,
        dpi: 96,
    };
    return { ...base, ...over };
}

const crop = (b: Box): Partial<ShotFrame> => ({ crop: b });

// ---- boxFromRect ----

test("boxFromRect 把 Win32 的四边转成 x/y/宽/高", () => {
    expect(boxFromRect({ left: 10, top: 20, right: 110, bottom: 220 })).toEqual({
        x: 10,
        y: 20,
        width: 100,
        height: 200,
    });
});

test("boxFromRect 保留负坐标（副屏在左侧）", () => {
    expect(boxFromRect({ left: -1920, top: -100, right: -20, bottom: 900 })).toEqual({
        x: -1920,
        y: -100,
        width: 1900,
        height: 1000,
    });
});

// ---- scaleOf ----

test("未裁剪未缩放时缩放比为 1", () => {
    expect(scaleOf(frame())).toEqual({ x: 1, y: 1 });
});

test("裁剪后缩放比按裁剪区算，不是按整窗算", () => {
    // 裁 800×500，输出还是 800×500 → 1:1
    const f = frame({ ...crop({ x: 100, y: 50, width: 800, height: 500 }), image: { width: 800, height: 500 } });
    expect(scaleOf(f)).toEqual({ x: 1, y: 1 });
});

test("缩放比是「输出 / 来源」，缩过就是非 1", () => {
    // 裁 1600×1000，输出缩到 800×500 → 0.5
    const f = frame({ image: { width: 800, height: 500 } });
    expect(scaleOf(f)).toEqual({ x: 0.5, y: 0.5 });
});

test("尺寸为 0 时退化为 1，不产生 Infinity", () => {
    // 还没截图 / 参数写歪时不该让整条链炸成 NaN
    const f = frame({ image: { width: 0, height: 0 } });
    expect(scaleOf(f)).toEqual({ x: 1, y: 1 });
});

// ---- 图像 ↔ 整窗 ----

test("无裁剪时图像坐标就是整窗坐标", () => {
    expect(imageToWindow(frame(), { x: 300, y: 400 })).toEqual({ x: 300, y: 400 });
});

test("裁剪后要加回裁剪偏移", () => {
    // 这是最容易漏的一步：漏了之后裁过的截图整体偏 (100,50)
    const f = frame({ ...crop({ x: 100, y: 50, width: 800, height: 500 }), image: { width: 800, height: 500 } });
    expect(imageToWindow(f, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
    expect(imageToWindow(f, { x: 10, y: 20 })).toEqual({ x: 110, y: 70 });
});

test("缩放要除而不是乘", () => {
    // 输出是 800×500，来源是 1600×1000 —— 图上 1px 等于实际 2px
    const f = frame({ image: { width: 800, height: 500 } });
    expect(imageToWindow(f, { x: 100, y: 100 })).toEqual({ x: 200, y: 200 });
});

test("裁剪 + 缩放同时存在时两步都要做", () => {
    // 裁 (200,100,800,500)，再缩到 400×250（scale 0.5）
    const f = frame({
        ...crop({ x: 200, y: 100, width: 800, height: 500 }),
        image: { width: 400, height: 250 },
    });
    expect(imageToWindow(f, { x: 0, y: 0 })).toEqual({ x: 200, y: 100 });
    expect(imageToWindow(f, { x: 200, y: 100 })).toEqual({ x: 600, y: 300 });
});

// ---- 整窗 ↔ 屏幕 ----

test("整窗坐标 + 窗口位置 = 屏幕坐标，且可逆", () => {
    const f = frame();
    expect(windowToScreen(f, { x: 0, y: 0 })).toEqual({ x: 100, y: 200 });
    expect(windowToScreen(f, { x: 5, y: 7 })).toEqual({ x: 105, y: 207 });
    expect(screenToWindow(f, { x: 105, y: 207 })).toEqual({ x: 5, y: 7 });
});

test("副屏负坐标不被当成失败", () => {
    // 副屏在左侧时窗口 x 可以是 -1920
    const f = frame({ window: { x: -1920, y: 0, width: 1600, height: 1000 } });
    expect(imageToScreen(f, { x: 0, y: 0 })).toEqual({ x: -1920, y: 0 });
});

// ---- 客户区 ----

test("客户区偏移 = 客户区原点 − 窗口原点", () => {
    expect(clientShift(frame())).toEqual({ x: 8, y: 40 });
});

test("整窗坐标减去客户区偏移就是客户区坐标", () => {
    const f = frame();
    expect(windowToClient(f, { x: 8, y: 40 })).toEqual({ x: 0, y: 0 });
    expect(windowToClient(f, { x: 108, y: 240 })).toEqual({ x: 100, y: 200 });
});

test("图像坐标 → 客户区坐标（模型点的是页面哪里）", () => {
    const f = frame();
    // 图像 (8,40) = 客户区 (0,0)
    expect(imageToClient(f, { x: 8, y: 40 })).toEqual({ x: 0, y: 0 });
    // 图像 (100, 200) = 客户区 (92, 160)
    expect(imageToClient(f, { x: 100, y: 200 })).toEqual({ x: 92, y: 160 });
});

test("裁剪之后客户区映射仍然对齐", () => {
    const f = frame({ ...crop({ x: 100, y: 100, width: 400, height: 300 }), image: { width: 400, height: 300 } });
    // 图像 (0,0) = 整窗 (100,100) = 客户区 (92, 60)
    expect(imageToClient(f, { x: 0, y: 0 })).toEqual({ x: 92, y: 60 });
});

// ---- 复合往返 ----

test("图像 → 屏幕 → 图像：整数偏移下精确往返", () => {
    const f = frame();
    for (const p of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 799, y: 599 },
    ]) {
        expect(screenToImage(f, imageToScreen(f, p))).toEqual(p);
    }
});

test("裁剪 + 缩放下的往返误差小于半个像素", () => {
    const f = frame({
        ...crop({ x: 137, y: 89, width: 803, height: 501 }),
        image: { width: 401, height: 250 },
    });
    for (const p of [
        { x: 0, y: 0 },
        { x: 200, y: 125 },
        { x: 400, y: 249 },
    ]) {
        // 走真实的复合函数，不自己重写一遍逆运算——那样等于用同一套推演自证
        const screen = imageToScreen(f, p);
        const rt = screenToImage(f, screen);
        expect(Math.abs(rt.x - p.x)).toBeLessThan(0.5);
        expect(Math.abs(rt.y - p.y)).toBeLessThan(0.5);
    }
});

test("客户区 → 图像 → 客户区：往返恒等", () => {
    const f = frame();
    for (const p of [
        { x: 0, y: 0 },
        { x: 400, y: 300 },
    ]) {
        const img = clientToImage(f, p);
        expect(imageToClient(f, img)).toEqual(p);
    }
});

// ---- 有效性 ----

test("insideImage 是左闭右开", () => {
    const f = frame({ image: { width: 100, height: 50 } });
    expect(insideImage(f, { x: 0, y: 0 })).toBe(true);
    expect(insideImage(f, { x: 99, y: 49 })).toBe(true);
    // 右边界与下边界本身不在图内
    expect(insideImage(f, { x: 100, y: 0 })).toBe(false);
    expect(insideImage(f, { x: 0, y: 50 })).toBe(false);
    expect(insideImage(f, { x: -1, y: 0 })).toBe(false);
});

test("insideClient 用客户区尺寸，不把右边框算进去", () => {
    const f = frame();
    // 客户区 1584×952，其右下角对应整窗 (8+1584, 40+952) = (1592, 992)
    expect(insideClient(f, { x: 1591, y: 991 })).toBe(true);
    // 再往右一格进的是右边框，不是客户区
    expect(insideClient(f, { x: 1592, y: 991 })).toBe(false);
    // 标题栏里（y < 40）不是客户区
    expect(insideClient(f, { x: 500, y: 39 })).toBe(false);
    expect(insideClient(f, { x: 500, y: 40 })).toBe(true);
});

test("insideClient 在裁剪之后仍然看客户区，不看图像边界", () => {
    // 只裁了标题栏那一块：图上整块都在标题栏里，没有一个点属于客户区
    const f = frame({ ...crop({ x: 0, y: 0, width: 1600, height: 40 }), image: { width: 1600, height: 40 } });
    expect(insideClient(f, { x: 500, y: 10 })).toBe(false);
});

// ---- 取整 ----

test("roundPoint 是四舍五入，不是截断", () => {
    // floor 会让所有点系统性偏左上半个像素；这条钉住「用的是 round」
    expect(roundPoint({ x: 0.5, y: 0.4 })).toEqual({ x: 1, y: 0 });
    expect(roundPoint({ x: 10.6, y: 10.5 })).toEqual({ x: 11, y: 11 });
    // 负坐标：Math.round(-0.5) 得 -0，归一成 0 才好比
    expect(roundPoint({ x: -0.5, y: -1.4 })).toEqual({ x: -0, y: -1 });
});

test("取整只在末端做：中间结果保持浮点", () => {
    // 缩放 0.5 时图上 101 → 整窗 202；若中间取整再乘，误差会累积
    const f = frame({ image: { width: 800, height: 500 } });
    const w = imageToWindow(f, { x: 101, y: 101 });
    expect(w).toEqual({ x: 202, y: 202 });
    // 反过来：整窗 101 → 图上 50.5，不该被提前取整成 50
    const img = screenToImage(f, { x: f.window.x + 101, y: f.window.y + 101 });
    expect(img.x).toBeCloseTo(50.5, 10);
    expect(img.y).toBeCloseTo(50.5, 10);
});

// ---- frameFor：需要真窗口，只断言失败路径 ----

test("frameFor 对无效句柄返回 null 而不是伪造坐标", () => {
    // 0n 不是窗口，ClientToScreen 会失败。这里要的是「失败可辨认」：
    // 若返回 (0,0) 当默认值，调用方会悄悄点到屏幕左上角去。
    expect(frameFor(0n, { image: { width: 10, height: 10 } })).toBeNull();
});
