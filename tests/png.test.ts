import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import {
    bgraToPng,
    chunk,
    crc32,
    encodePng,
    getPixel,
    pngFromBgra,
    type PngImage,
} from "../native/png";

/**
 * PNG 编码器的判据。
 *
 * 核心手法是**往返**：编码出来的字节自己再解一遍，看像素是否原样回来。
 * 只断言「文件头是 89 50 4E 47」是不够的——那种断言在通道写错、
 * 扫描行错位、CRC 漏算时照样绿。
 *
 * 解码器是几十行最小实现（只认非隔行、8 位、filter=0），够验证我们自己产出的东西。
 */

// ---- 最小解码器（仅供测试用） -----------------------------------------------

type Decoded = { width: number; height: number; colorType: number; pixels: Uint8Array };

/** 从 PNG 字节里解出像素。只支持本模块会产出的形态 */
function decodePng(bytes: Uint8Array): Decoded {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i++) {
        expect(bytes[i]).toBe(sig[i]);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let width = 0;
    let height = 0;
    let colorType = -1;
    const idat: Uint8Array[] = [];

    while (at < bytes.length) {
        const len = view.getUint32(at, false);
        const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
        const data = bytes.subarray(at + 8, at + 8 + len);
        const storedCrc = view.getUint32(at + 8 + len, false);

        // CRC 必须覆盖 type + data（不含 length）
        const crcInput = new Uint8Array(4 + data.length);
        crcInput.set(bytes.subarray(at + 4, at + 8), 0);
        crcInput.set(data, 4);
        expect(crc32(crcInput)).toBe(storedCrc);

        if (type === "IHDR") {
            width = view.getUint32(at + 8, false);
            height = view.getUint32(at + 12, false);
            expect(data[8]).toBe(8); // bit depth
            colorType = data[9] ?? -1;
            expect(data[10]).toBe(0); // compression
            expect(data[11]).toBe(0); // filter
            expect(data[12]).toBe(0); // interlace
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        at += 12 + len;
    }

    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
    expect(channels).toBeGreaterThan(0);

    const totalIdat = idat.reduce((n, d) => n + d.length, 0);
    const merged = new Uint8Array(totalIdat);
    let off = 0;
    for (const d of idat) {
        merged.set(d, off);
        off += d.length;
    }
    // 用 node:zlib 的 inflateSync（**严格**要求 zlib 包装）。
    // 绝不能用 Bun.inflateSync —— 它和 Bun.deflateSync 同源于 raw deflate，
    // 会把不合规的产物也解开，等于把这条判据废掉。
    const raw = new Uint8Array(inflateSync(merged));

    const stride = width * channels;
    const pixels = new Uint8Array(width * height * channels);
    for (let y = 0; y < height; y++) {
        const src = y * (stride + 1);
        expect(raw[src]).toBe(0); // filter = None
        pixels.set(raw.subarray(src + 1, src + 1 + stride), y * stride);
    }
    return { width, height, colorType, pixels };
}

// ---- CRC32 ------------------------------------------------------------------

describe("crc32", () => {
    test("空输入为 0", () => {
        expect(crc32(new Uint8Array(0))).toBe(0);
    });

    test("已知向量：\"123456789\" = 0xCBF43926", () => {
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });

    test("单字节不碰撞常见值", () => {
        const a = crc32(new Uint8Array([0]));
        const b = crc32(new Uint8Array([1]));
        expect(a).not.toBe(b);
    });
});

// ---- chunk ------------------------------------------------------------------

describe("chunk", () => {
    test("长度字段为 0 时结构为 12 字节", () => {
        const c = chunk("IEND", new Uint8Array(0));
        expect(c.length).toBe(12);
    });

    test("type 必须是 4 字节 ASCII", () => {
        expect(() => chunk("ABC", new Uint8Array(0))).toThrow();
        expect(() => chunk("ABCDE", new Uint8Array(0))).toThrow();
    });

    test("CRC 覆盖 type+data，不含 length", () => {
        const data = new Uint8Array([1, 2, 3]);
        const c = chunk("tEXt", data);
        const view = new DataView(c.buffer);
        expect(view.getUint32(0, false)).toBe(3); // length
        const crcInput = new Uint8Array(4 + 3);
        crcInput.set(new TextEncoder().encode("tEXt"), 0);
        crcInput.set(data, 4);
        expect(view.getUint32(8 + 3, false)).toBe(crc32(crcInput));
    });
});

// ---- BGRA 转换 --------------------------------------------------------------

describe("bgraToPng", () => {
    test("通道顺序：BGRA → RGBA（这条能抓到「漏写 B 通道」）", () => {
        // 一个青色像素：B=255 G=255 R=0 A=255
        const bgra = new Uint8Array([255, 255, 0, 255]);
        const img = bgraToPng(bgra, 1, 1, "rgba");
        expect([...img.pixels]).toEqual([0, 255, 255, 255]);
    });

    test("RGB 格式也保留 B 通道", () => {
        const bgra = new Uint8Array([10, 20, 30, 255]);
        const img = bgraToPng(bgra, 1, 1, "rgb");
        // R=30 G=20 B=10
        expect([...img.pixels]).toEqual([30, 20, 10]);
    });

    test("alpha 全 0 且要求不透明补丁时，整块变 255", () => {
        const bgra = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 0]);
        const kept = bgraToPng(bgra, 2, 1, "rgba");
        expect(kept.pixels[3]).toBe(0);
        expect(kept.pixels[7]).toBe(0);

        const fixed = bgraToPng(bgra, 2, 1, "rgba", { treatZeroAlphaAsOpaque: true });
        expect(fixed.pixels[3]).toBe(255);
        expect(fixed.pixels[7]).toBe(255);
    });

    test("有任一非 0 alpha 时不做补丁（说明 alpha 是真实数据）", () => {
        const bgra = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 128]);
        const img = bgraToPng(bgra, 2, 1, "rgba", { treatZeroAlphaAsOpaque: true });
        expect(img.pixels[3]).toBe(0); // 保持原样
        expect(img.pixels[7]).toBe(128);
    });

    test("缓冲不足时抛错，不静默截断", () => {
        expect(() => bgraToPng(new Uint8Array(3), 1, 1, "rgba")).toThrow();
    });
});

// ---- 编码 + 往返 ------------------------------------------------------------

describe("encodePng", () => {
    function image(width: number, height: number, channels: 3 | 4): PngImage {
        const pixels = new Uint8Array(width * height * channels);
        for (let i = 0; i < pixels.length; i++) pixels[i] = i % 256;
        return { width, height, channels, pixels };
    }

    test("RGBA 往返：像素原样回来", () => {
        const img = image(4, 3, 4);
        const decoded = decodePng(encodePng(img, "rgba"));
        expect(decoded.width).toBe(4);
        expect(decoded.height).toBe(3);
        expect(decoded.colorType).toBe(6);
        expect([...decoded.pixels]).toEqual([...img.pixels]);
    });

    test("RGB 往返：像素原样回来", () => {
        const img = image(5, 2, 3);
        const decoded = decodePng(encodePng(img, "rgb"));
        expect(decoded.colorType).toBe(2);
        expect([...decoded.pixels]).toEqual([...img.pixels]);
    });

    test("1x1 也能编码（边界尺寸）", () => {
        const img: PngImage = { width: 1, height: 1, channels: 4, pixels: new Uint8Array([1, 2, 3, 4]) };
        const decoded = decodePng(encodePng(img, "rgba"));
        expect([...decoded.pixels]).toEqual([1, 2, 3, 4]);
    });

    test("尺寸为 0 时抛错", () => {
        expect(() =>
            encodePng({ width: 0, height: 1, channels: 4, pixels: new Uint8Array(0) }, "rgba"),
        ).toThrow();
    });

    test("格式与通道数不匹配时抛错", () => {
        const img = image(2, 2, 3);
        expect(() => encodePng(img, "rgba")).toThrow();
    });

    test("像素缓冲长度不符时抛错", () => {
        expect(() =>
            encodePng({ width: 2, height: 2, channels: 4, pixels: new Uint8Array(4 * 4 - 1) }, "rgba"),
        ).toThrow();
    });

    test("输出以 IEND 结束（最后一 chunk 是 IEND 的空数据）", () => {
        const bytes = encodePng(image(2, 2, 4), "rgba");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        // IEND: 长度 0 + "IEND" + CRC 共 12 字节
        const tail = bytes.subarray(bytes.length - 12);
        expect(new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(0, false)).toBe(0);
        expect(new TextDecoder().decode(tail.subarray(4, 8))).toBe("IEND");
        void view;
    });

    test("同样输入产出同样字节（确定性，便于比对）", () => {
        const a = encodePng(image(3, 3, 4), "rgba");
        const b = encodePng(image(3, 3, 4), "rgba");
        expect(a.length).toBe(b.length);
        expect([...a]).toEqual([...b]);
    });

    /**
     * IDAT 必须是 zlib 包装（RFC 1950），不是 raw deflate。
     *
     * 这条是被真事逼出来的，而且极难发现：
     *
     *   - 编码侧原本用 `Bun.deflateSync`，它产出 **raw deflate**
     *     （与 `zlib.deflateRawSync` 逐字节相同，首字节 0x73/0x8c 之类）
     *   - 解码侧用 `Bun.inflateSync`，与它同源，raw 对 raw **正常解开**
     *   - `System.Drawing` 宽容，**正常打开**
     *   - 只有严格解码器（`Bun.Image` / libspng / litellm 上游）才拒，
     *     报 `ERR_IMAGE_DECODE_FAILED`
     *   - 而 `Bun.Image.metadata()` 仍然成功 —— 它只读 header、不解压 IDAT，
     *     于是「尺寸对、格式对、就是打不开」
     *
     * 所以判据必须是**严格解码器**，绝不能用 Bun 自己那对同源函数。
     */
    test("IDAT 是 zlib 格式（首字节 0x78），不是 raw deflate", () => {
        const bytes = encodePng(image(8, 8, 4), "rgba");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let at = 8;
        let first: number | null = null;
        while (at < bytes.length) {
            const len = view.getUint32(at, false);
            const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
            if (type === "IDAT") {
                first = bytes[at + 8] ?? null;
                break;
            }
            at += 12 + len;
        }
        expect(first).not.toBeNull();
        // zlib CMF：低 4 位必须是 8（deflate），高 4 位是窗口大小（通常是 7 → 0x78）
        expect((first! & 0x0f)).toBe(8);
        expect(first).toBe(0x78);
    });

    test("decodePng 用严格 inflate 仍能解开（与上一条互为印证）", () => {
        // decodePng 内部用 node:zlib 的 inflateSync；若 IDAT 是 raw deflate，
        // 它会在 inflate 处直接抛错。
        expect(() => decodePng(encodePng(image(4, 4, 3), "rgb"))).not.toThrow();
    });
});

describe("pngFromBgra", () => {
    test("端到端：BGRA → PNG 字节 → 解回来是 RGBA", () => {
        // 2x1：像素 0 = 青(B255 G255 R0 A255)，像素 1 = 红(B0 G0 R255 A255)
        const bgra = new Uint8Array([255, 255, 0, 255, 0, 0, 255, 255]);
        const png = pngFromBgra(bgra, 2, 1, "rgba");
        const decoded = decodePng(png);
        expect([...decoded.pixels]).toEqual([0, 255, 255, 255, 255, 0, 0, 255]);
    });
});

describe("getPixel", () => {
    const img: PngImage = {
        width: 2,
        height: 2,
        channels: 4,
        pixels: new Uint8Array([
            1, 2, 3, 4, 5, 6, 7, 8,
            9, 10, 11, 12, 13, 14, 15, 16,
        ]),
    };

    test("取到正确像素", () => {
        expect(getPixel(img, 0, 0)).toEqual({ r: 1, g: 2, b: 3, a: 4 });
        expect(getPixel(img, 1, 1)).toEqual({ r: 13, g: 14, b: 15, a: 16 });
    });

    test("越界返回 null，不返回垃圾值", () => {
        expect(getPixel(img, -1, 0)).toBeNull();
        expect(getPixel(img, 0, -1)).toBeNull();
        expect(getPixel(img, 2, 0)).toBeNull();
        expect(getPixel(img, 0, 2)).toBeNull();
    });

    test("RGB 图像的 alpha 恒为 255", () => {
        const rgb: PngImage = { width: 1, height: 1, channels: 3, pixels: new Uint8Array([9, 8, 7]) };
        expect(getPixel(rgb, 0, 0)).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    });
});
