/**
 * png.ts — PNG 编码器（只写不读）
 *
 * 三个 `.ps1` 工具卡在同一个地方：它们都靠 `System.Drawing` 的
 * `Bitmap.Save(..., ImageFormat.Png)` 输出图像。迁到 TS 时这是唯一的硬障碍，
 * 而它其实只是「拼 chunk + zlib 压缩」——没有解码、没有滤波选择、没有调色板。
 *
 * 支持两种像素格式，够用了：
 *
 *   - `rgb`  （colorType 2）：截图用，不需要 alpha
 *   - `rgba` （colorType 6）：图标用，需要 alpha
 *
 * 位深固定 8 位、非隔行、filter 全 0（None）。这三点都是合法 PNG 的最简选择，
 * 任何解码器都认。文件比最优 encoder 大一些，但这些图是给人看的诊断产物，
 * 不是发布资源。
 *
 * 为什么不用第三方库：本仓的运行时前提只有 Bun。`Bun.deflateSync` 已经提供
 * zlib 压缩，剩下要写的只有 CRC32 和 chunk 框架——一共不到 100 行，
 * 相比引入依赖后还要担心它在 Bun 下能不能正常工作，手写更可控。
 */

// ---- CRC32 ------------------------------------------------------------------

/** CRC32 查表，模块加载时算一次 */
const CRC_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/** 标准 CRC32（PNG 用的就是这个多项式） */
export function crc32(bytes: Uint8Array, seed = 0): number {
    let c = (seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === undefined) break;
        c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// ---- chunk ------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function u32be(value: number): Uint8Array {
    const out = new Uint8Array(4);
    out[0] = (value >>> 24) & 0xff;
    out[1] = (value >>> 16) & 0xff;
    out[2] = (value >>> 8) & 0xff;
    out[3] = value & 0xff;
    return out;
}

/**
 * 拼一个 chunk：`length | type | data | crc`。
 *
 * CRC 覆盖 `type + data`，**不含 length** —— 这是 PNG 规范里最容易写错的一处。
 */
export function chunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    if (typeBytes.length !== 4) {
        throw new Error(`PNG chunk type must be 4 ASCII bytes, got ${JSON.stringify(type)}`);
    }
    const out = new Uint8Array(4 + 4 + data.length + 4);
    out.set(u32be(data.length), 0);
    out.set(typeBytes, 4);
    out.set(data, 8);

    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    out.set(u32be(crc32(crcInput)), 8 + data.length);
    return out;
}

// ---- 像素格式 ---------------------------------------------------------------

export type PngFormat = "rgb" | "rgba";

export type PngImage = {
    width: number;
    height: number;
    /** 每像素的字节数：rgb=3, rgba=4 */
    channels: 3 | 4;
    /** 行优先、从头到尾的像素字节，长度必须等于 width * height * channels */
    pixels: Uint8Array;
};

const COLOR_TYPE: Record<PngFormat, number> = { rgb: 2, rgba: 6 };
const CHANNELS: Record<PngFormat, 3 | 4> = { rgb: 3, rgba: 4 };

/**
 * 把 BGRA（Windows GDI 的原生顺序）转成 PNG 要的 RGB / RGBA。
 *
 * GDI 的 32 位 DIB 是 `B G R X` 小端序，最高字节未使用。截图场景 alpha 无意义，
 * 直接丢掉；图标场景要把「全 0 的 alpha」当成不透明处理——很多 GDI 路径会
 * 在 hbmColor 里留 alpha=0，而实际图像是实心的（掩码在 hbmMask 里）。
 */
export function bgraToPng(
    bgra: Uint8Array,
    width: number,
    height: number,
    format: PngFormat,
    opts: { treatZeroAlphaAsOpaque?: boolean } = {},
): PngImage {
    const channels = CHANNELS[format];
    const expected = width * height * 4;
    if (bgra.length < expected) {
        throw new Error(`bgra buffer too small: need ${expected}, got ${bgra.length}`);
    }
    const pixels = new Uint8Array(width * height * channels);
    let anyAlpha = false;
    for (let i = 0, j = 0; i < expected; i += 4, j += channels) {
        const b = bgra[i] ?? 0;
        const g = bgra[i + 1] ?? 0;
        const r = bgra[i + 2] ?? 0;
        const a = bgra[i + 3] ?? 0;
        if (a !== 0) anyAlpha = true;
        // RGB 与 RGBA 都要写 B 通道：初版只在 channels === 4 分支里写 j+3，
        // 把 j+2 漏掉了 —— 那样所有图都会丢蓝，看起来像「偏黄」。
        pixels[j] = r;
        pixels[j + 1] = g;
        pixels[j + 2] = b;
        if (channels === 4) {
            pixels[j + 3] = a;
        }
    }
    if (channels === 4 && !anyAlpha && opts.treatZeroAlphaAsOpaque) {
        for (let j = 3; j < pixels.length; j += 4) pixels[j] = 255;
    }
    return { width, height, channels, pixels };
}

/** 从行优先的 RGBA（Buffer 常见顺序）取任意像素，越界返回 null */
export function getPixel(
    img: PngImage,
    x: number,
    y: number,
): { r: number; g: number; b: number; a: number } | null {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    const at = (y * img.width + x) * img.channels;
    const r = img.pixels[at];
    const g = img.pixels[at + 1];
    const b = img.pixels[at + 2];
    if (r === undefined || g === undefined || b === undefined) return null;
    const a = img.channels === 4 ? (img.pixels[at + 3] ?? 255) : 255;
    return { r, g, b, a };
}

// ---- 编码 -------------------------------------------------------------------

/**
 * 把图像编码成 PNG 字节。
 *
 * 失败时抛错而不是返回空——调用方要写文件，静默产出 0 字节的 PNG
 * 会让「截图成功了吗」变成不可判定的问题。
 */
export function encodePng(img: PngImage, format: PngFormat): Uint8Array {
    if (img.width <= 0 || img.height <= 0) {
        throw new Error(`invalid PNG dimensions: ${img.width}x${img.height}`);
    }
    const channels = CHANNELS[format];
    if (img.channels !== channels) {
        throw new Error(
            `format ${format} needs ${channels} channels, image has ${img.channels}`,
        );
    }
    const expected = img.width * img.height * channels;
    if (img.pixels.length !== expected) {
        throw new Error(
            `pixel buffer size mismatch: expected ${expected}, got ${img.pixels.length}`,
        );
    }

    // IHDR：width, height, bitDepth=8, colorType, compression=0, filter=0, interlace=0
    const ihdr = new Uint8Array(13);
    ihdr.set(u32be(img.width), 0);
    ihdr.set(u32be(img.height), 4);
    ihdr[8] = 8;
    ihdr[9] = COLOR_TYPE[format];
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    // 扫描行：每行前面一个 filter 字节（0 = None）
    const stride = img.width * channels;
    const raw = new Uint8Array((stride + 1) * img.height);
    for (let y = 0; y < img.height; y++) {
        const dst = y * (stride + 1);
        raw[dst] = 0;
        raw.set(img.pixels.subarray(y * stride, (y + 1) * stride), dst + 1);
    }

    const idat = new Uint8Array(Bun.deflateSync(raw, { level: 9 }));

    const parts = [
        PNG_SIGNATURE,
        chunk("IHDR", ihdr),
        chunk("IDAT", idat),
        chunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** 便捷入口：BGRA → PNG 文件字节 */
export function pngFromBgra(
    bgra: Uint8Array,
    width: number,
    height: number,
    format: PngFormat,
    opts: { treatZeroAlphaAsOpaque?: boolean } = {},
): Uint8Array {
    return encodePng(bgraToPng(bgra, width, height, format, opts), format);
}
