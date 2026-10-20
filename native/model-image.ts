/**
 * model-image.ts — 把截图转成「模型友好」的格式与尺寸
 *
 * ## 成本模型
 *
 * 两层成本，量级不同：
 *
 *   - 模型侧：每图最多 **1024 tokens**，超过被规范化到约 **1300×1300** 等效
 *   - 宿主侧：OWUI 把历史消息留在后端内存里，图片作为 base64 **在之后每一轮
 *     被反复携带**（base64 再膨胀 4/3）
 *
 * 真正的滚雪球是后者。所以判据是**字节数**，不是 token（`docs/pitfalls.md` 3.12）。
 *
 * ## 为什么这一层只做三件事
 *
 * 实测（3098×1850 全窗 / 800×600 裁剪，5 次取中位数）：
 *
 *     route                    全窗 ms / KiB    裁剪 ms / KiB
 *     自家 encodePng lv6        39.0 / 392       6.0 /  62
 *     Bun.Image png            458.3 / 531      40.0 /  84
 *     Bun.Image palette 256   2590.7 / 180     198.2 /  32
 *     Bun.Image jpeg q85        23.8 / 406       4.0 /  67
 *
 * 自家编码器在 truecolor PNG 上**快 7–12 倍且更小**，所以默认路径根本不经过这里
 * （`tools/capture-window.ts` 直接调 `native/png.ts`）。缩小也不再经过这里——
 * 「缩小 + png」由 `native/resample.ts` 的面积平均降采样承担（见 `pitfalls` 3.16）。
 *
 * 这一层只承担自家做不到的：
 *
 *   1. **放大** —— 需要插值，面积平均做不到
 *   2. **palette** —— 索引色 PNG，字节最小但慢一个数量级，归档才值
 *   3. **jpeg / webp** —— 有损编码
 *
 * ## 为什么用 `Bun.Image`
 *
 * 它从 1.3.14 起内建，静态链接 libspng / libjpeg-turbo / libwebp，SIMD 重采样。
 * API 是「记录设置 → 终结时才算」：
 *
 *     await new Bun.Image(input).resize(w).jpeg({ quality }).bytes()
 *
 * 格式方法是 `jpeg()` / `png()` / `webp()`（返回 this），终结方法是
 * `bytes()` / `buffer()` / `write(dest)`。**没有 `toBuffer(fmt, opts)`** ——
 * 这一条查文档才确认，凭印象写过一版，编译不过。
 *
 * 顺带记一笔：`Bun.Image` 是**严格**解码器。它拒绝过我们自己早期产出的 PNG
 * （IDAT 用了 raw deflate 而非 zlib），那次失败反而成了判据——
 * 见 `docs/pitfalls.md` 3.11 与 `tests/png.test.ts`。
 */

export type ModelImageFormat = "png" | "palette" | "jpeg" | "webp";

export type ModelImageOptions = {
    /** 长边上限（像素）。0 或省略表示不缩 */
    maxEdge?: number;
    /**
     * 输出格式。默认 `png`。
     *
     * 默认保持无损：不指定格式就说明调用方没有「用体积换别的」的意图。
     * 要省字节请显式选 `palette`（体积最小，但慢一个数量级，只适合归档）。
     */
    format?: ModelImageFormat;
    /** jpeg / webp 的质量，1–100 */
    quality?: number;
};

export type ModelImageResult = {
    bytes: Uint8Array;
    width: number;
    height: number;
    format: string;
    /** 相对原始像素数折算的 token 估算（模型上限 1024） */
    estimatedTokens: number;
};

/** 模型侧「等效像素」基准：约 1300×1300 会吃满 1024 tokens */
const TOKEN_BASE_PIXELS = 1300 * 1300;
const TOKEN_CAP = 1024;

/**
 * 估算一张图会花多少 token。
 *
 * 按官方文档的两条规则折算：像素数低于 ~544×544 会被放大，
 * 高于 ~1300×1300 会被缩小并封顶 1024。这里只关心「会不会吃满」，所以线性折算。
 *
 * 纯估算，不是精确值；它的用途是让调用方在「这一张值不值得看」上做判断。
 */
export function estimateImageTokens(width: number, height: number): number {
    const pixels = width * height;
    const capped = Math.min(pixels, TOKEN_BASE_PIXELS);
    return Math.max(1, Math.min(TOKEN_CAP, Math.round((capped / TOKEN_BASE_PIXELS) * TOKEN_CAP)));
}

/** 在 pipeline 上设置格式。返回同一个对象，便于链式继续 */
function applyFormat(img: Bun.Image, format: ModelImageFormat, quality: number): Bun.Image {
    if (format === "jpeg") return img.jpeg({ quality });
    if (format === "webp") return img.webp({ quality });
    if (format === "palette") return img.png({ palette: true, colors: 256, dither: false });
    return img.png();
}

/**
 * 把任意图像压缩到适合送进模型的形态。
 *
 * 失败时抛错而不是回退到原图——静默给出原尺寸会把成本失控伪装成成功。
 */
export async function toModelImage(
    input: Uint8Array | string,
    opts: ModelImageOptions = {},
): Promise<ModelImageResult> {
    const maxEdge = opts.maxEdge ?? 0;
    // 默认无损。要省字节让调用方显式选 palette —— 默认值不替调用方做取舍。
    const format = opts.format ?? "png";
    const quality = opts.quality ?? 85;

    let img = new Bun.Image(input);
    if (maxEdge > 0) {
        // 必须写 `fit: "inside"`，而且两个方向都要给。
        //
        // 文档（`bun-types/docs/runtime/image.mdx`）的语义：
        //
        //     resize(800)                             → 宽 800，保持比例（**只限宽**）
        //     resize(800, 600)                        → 强制 800×600（拉伸）
        //     resize(800, 600, { fit: "inside" })     → 在 800×600 内适配
        //
        // 早先这里写的是 `resize(maxEdge, undefined)`，于是竖长图（高 > 宽）的长边
        // 完全没被限制：300×600 传 maxEdge=100 得到 100×200，像素数是期望的 4 倍。
        // 是 `tests/model-image.test.ts` 那条「estimatedTokens 与尺寸一致」抓到的。
        //
        // `withoutEnlargement`：小图不放大。放大只增加字节，不增加信息。
        img = img.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true });
    }
    img = applyFormat(img, format, quality);

    const bytes = new Uint8Array(await img.bytes());

    // 尺寸从产物读回来，而不是按 maxEdge 推算——`withoutEnlargement`
    // 与长宽比会让实际尺寸小于上限，报告要报真值。
    const meta = await new Bun.Image(bytes).metadata();

    return {
        bytes,
        width: meta.width,
        height: meta.height,
        format: meta.format,
        estimatedTokens: estimateImageTokens(meta.width, meta.height),
    };
}

/** 人类可读的一行摘要，供 CLI 打印 */
export function describeModelImage(r: ModelImageResult): string {
    return `${r.width}x${r.height} ${r.format} ${r.bytes.length.toLocaleString("en-US")} bytes ~${r.estimatedTokens} tokens`;
}
