/**
 * `native/model-image.ts` 的判据。
 *
 * 这一层只做「自家编码器做不到」的三件事：缩放、palette、jpeg/webp。
 * 所以测试也围绕这三件事，而不是重复 `tests/png.test.ts` 的无损往返。
 */

import { describe, expect, test } from "bun:test";

import { describeModelImage, estimateImageTokens, toModelImage } from "../native/model-image";
import { bgraToPng, encodePng } from "../native/png";

/** 造一张「类 UI」的 PNG：大面积同色 + 逐像素轻微抖动 */
function makeFlatPng(width: number, height: number): Uint8Array {
    // 显式标成三元组：本仓开了 `noUncheckedIndexedAccess`，
    // `number[][]` 解构出来的三个分量会被推成 `number | undefined`
    const base: Array<[number, number, number]> = [
        [0x1e, 0x29, 0x3b],
        [0x33, 0x41, 0x55],
        [0x64, 0x74, 0x8b],
        [0x94, 0xa3, 0xb8],
        [0xcb, 0xd5, 0xe1],
        [0xf8, 0xfa, 0xfc],
        [0x22, 0xaa, 0x55],
        [0xef, 0x44, 0x44],
    ];
    const bgra = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // 64px 横条 + 128px 竖条，形成大片同色区域
            const band = (Math.floor(y / 64) + Math.floor(x / 128)) % base.length;
            const [r, g, b] = base[band]!;
            // 逐像素微扰，模拟文字边缘的抗锯齿。
            //
            // 没有它，几个规则的纯色块会被 DEFLATE 压到 1.3 KB 出头，
            // palette 那 768 字节的调色板反而成了净亏损——那测的就不是
            // UI 截图的场景了（真实界面有文字、边框、抗锯齿，逐行都不重复）。
            const j = (x * 31 + y * 17) % 7;
            const at = (y * width + x) * 4;
            bgra[at] = Math.min(255, b + j);
            bgra[at + 1] = Math.min(255, g + j);
            bgra[at + 2] = Math.min(255, r + j);
            bgra[at + 3] = 255;
        }
    }
    return encodePng(bgraToPng(bgra, width, height, "rgb"), "rgb", 6);
}

describe("toModelImage", () => {
    test("默认保持无损 png —— 不替调用方做降质取舍", async () => {
        const r = await toModelImage(makeFlatPng(120, 80));
        expect(r.format).toBe("png");
        expect(r.width).toBe(120);
        expect(r.height).toBe(80);
    });

    test("maxEdge 缩到长边上限，保持长宽比", async () => {
        const r = await toModelImage(makeFlatPng(400, 200), { maxEdge: 100 });
        expect(r.width).toBe(100);
        expect(r.height).toBe(50);
    });

    test("maxEdge 不放大（withoutEnlargement）", async () => {
        // 放大只增加字节，不增加信息——小图必须原样返回
        const r = await toModelImage(makeFlatPng(80, 60), { maxEdge: 400 });
        expect(r.width).toBe(80);
        expect(r.height).toBe(60);
    });

    test("maxEdge 为 0 或省略时尺寸不变", async () => {
        const src = makeFlatPng(100, 70);
        for (const opts of [{}, { maxEdge: 0 }]) {
            const r = await toModelImage(src, opts);
            expect(r.width).toBe(100);
            expect(r.height).toBe(70);
        }
    });

    test("palette 比默认 png 字节更小（这是它唯一的理由）", async () => {
        const src = makeFlatPng(400, 300);
        const asPng = await toModelImage(src, { format: "png" });
        const asPalette = await toModelImage(src, { format: "palette" });
        expect(asPalette.bytes.length).toBeLessThan(asPng.bytes.length);
    });

    test("jpeg / webp 各自出对应格式", async () => {
        const src = makeFlatPng(160, 120);
        expect((await toModelImage(src, { format: "jpeg", quality: 80 })).format).toBe("jpeg");
        expect((await toModelImage(src, { format: "webp", quality: 80 })).format).toBe("webp");
    });

    test("产物能被独立解码器读回，尺寸与源一致", async () => {
        const src = makeFlatPng(150, 90);
        for (const format of ["png", "palette", "jpeg", "webp"] as const) {
            const r = await toModelImage(src, { format });
            const meta = await new Bun.Image(r.bytes).metadata();
            expect(meta.width).toBe(150);
            expect(meta.height).toBe(90);
        }
    });

    test("estimatedTokens 由实际产物尺寸算出，不是按 maxEdge 推算", async () => {
        // 300×600 缩到 100 长边 → 实际 50×100，与「350 长边」完全不同
        const r = await toModelImage(makeFlatPng(300, 600), { maxEdge: 100 });
        expect(r.estimatedTokens).toBe(estimateImageTokens(r.width, r.height));
        expect(r.estimatedTokens).toBe(estimateImageTokens(50, 100));
    });

    test("非法输入抛错，不回退到原图（静默回退会把成本失控伪装成成功）", async () => {
        await expect(toModelImage(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    });
});

describe("describeModelImage", () => {
    test("摘要含尺寸、格式、字节与 token 估算", async () => {
        const r = await toModelImage(makeFlatPng(100, 50));
        const text = describeModelImage(r);
        expect(text).toContain("100x50");
        expect(text).toContain("png");
        expect(text).toContain(String(r.bytes.length));
        expect(text).toContain(String(r.estimatedTokens));
    });
});
