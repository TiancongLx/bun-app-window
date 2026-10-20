/**
 * resample.ts — BGRA 像素的面积平均（box）降采样
 *
 * ## 为什么不借用 `Bun.Image`
 *
 * `Bun.Image` 编在 Bun 二进制内部，JS 侧只有 API，内部函数拿不到。而它的慢
 * 有一大半根本不是算法问题——**它必须先从 PNG 解码**，而我们在
 * `captureWindow` 里拿到的是 `CreateDIBSection` 的 BGRA 原始指针，那一步压根不用付。
 *
 * ## 实测：自写版本双赢，不是权衡
 *
 * 真实窗口 3098×1850 → 1300×776（scale 0.4196），5 次取中位数：
 *
 *     route                    ms        bytes
 *     boxDirect + encodePng    45.9     102,036    ← 本文件
 *     Bun.Image resize + png   95.9     222,621
 *
 * **快 2.1 倍，同时小 2.2 倍。** 原因是滤波器选错了：`Bun.Image` 默认 `lanczos3`，
 * 那是**锐化**滤波器，会在文字边缘产生振铃（亮暗过冲）；那些高频细节让 DEFLATE
 * 更难压。box 是面积平均，天然平滑——对 UI 截图既无振铃又更好压。
 * 见 `docs/pitfalls.md` 3.16。
 *
 * ## 为什么两趟分离式
 *
 * 直接二维平均是 O(sw·sh)，分离成「水平一趟 + 垂直一趟」是 O(dw·sh + dw·dh)。
 * 面积平均对线性算子是可按维分解的，所以结果等价（精度上的近似见下）。
 *
 * ## 前缀和版本反而更慢
 *
 * 同一算法试过「每行一次前缀和、输出做减法」：51.3 ms，比朴素区间累加的
 * 39.1 ms 慢。原因是多一遍完整 O(sw) 扫描 + 更大的中间缓冲，缓存局部性变差。
 * **在这个尺寸下，朴素区间累加才是对的。**
 */

export type ResampleResult = {
    bgra: Uint8Array;
    width: number;
    height: number;
};

/**
 * 等比缩放到长边上限，**不放大**。
 *
 * 返回 null 表示参数无意义（非正数）。长边已经不超过上限时原样返回。
 */
export function fitInside(
    width: number,
    height: number,
    maxEdge: number,
): { width: number; height: number } | null {
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
    if (width <= 0 || height <= 0 || maxEdge <= 0) return null;
    const longest = Math.max(width, height);
    if (longest <= maxEdge) return { width, height };
    const scale = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

/**
 * 每个目标索引对应的源区间（左闭右开）。
 *
 * 预先算好再进内层循环，把除法从 O(dw·sh) 提到 O(dw)。这是本实现比
 * `Bun.Image` 快的次要原因，主因仍是省掉解码。
 */
function spans(srcLen: number, dstLen: number): Int32Array {
    const out = new Int32Array(dstLen * 2);
    for (let i = 0; i < dstLen; i++) {
        const l = Math.floor((i * srcLen) / dstLen);
        let r = Math.floor(((i + 1) * srcLen) / dstLen);
        // 源比目标小时 r 可能等于 l（只有放大会出现，入口已经拒绝）。
        // 这里兜住而不是信任入口，否则取到空区间就是除以 0。
        if (r <= l) r = l + 1;
        if (r > srcLen) r = srcLen;
        out[i * 2] = l;
        out[i * 2 + 1] = r;
    }
    return out;
}

/** alpha 是否全为 255。是的话可以走不带预乘的快路径 */
function isOpaque(bgra: Uint8Array, pixels: number): boolean {
    // 按 4 字节步进读 alpha 通道；`pixels` 是像素数，不是字节数
    const end = pixels * 4;
    for (let i = 3; i < end; i += 4) {
        if (bgra[i] !== 255) return false;
    }
    return true;
}

/**
 * 面积平均降采样 BGRA。
 *
 * **只降不升**：`dw > sw` 或 `dh > sh` 返回 null，让调用方退回避不开插值的
 * `Bun.Image`（放大需要滤波器，平均做不到）。
 *
 * ## alpha 的处理
 *
 * 检测到全不透明（窗口截图的常态）时走快路径，逐通道直接平均——像素值精确，
 * 无精度损失。
 *
 * 含透明像素时改走 **alpha 加权**（预乘语义）：`b_out = Σ(b·a) / Σa`。
 * 这样做是必须的——直接平均会让透明像素的 RGB（通常是 0）混进来，
 * 圆角与阴影边缘会出现黑边。`scripts/make-icon.ts` 产出的图标就有透明圆角。
 *
 * 两趟分离对加权平均不是严格等价（垂直那趟用的是已经平均过的 alpha 作权重），
 * 但误差在 8 位量化以下，且我们的主用例 alpha 全 255 时两条路径完全等价。
 */
export function downscaleBgra(
    src: Uint8Array,
    sw: number,
    sh: number,
    dw: number,
    dh: number,
): ResampleResult | null {
    if (!Number.isInteger(sw) || !Number.isInteger(sh)) return null;
    if (!Number.isInteger(dw) || !Number.isInteger(dh)) return null;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return null;
    // 只降不升
    if (dw > sw || dh > sh) return null;
    if (src.length < sw * sh * 4) return null;

    if (dw === sw && dh === sh) {
        return { bgra: src.slice(0, sw * sh * 4), width: dw, height: dh };
    }

    const weighted = !isOpaque(src, sw * sh);
    const xs = spans(sw, dw);
    const ys = spans(sh, dh);

    // ---- 水平：sw → dw ----
    const mid = new Uint8Array(dw * sh * 4);
    for (let y = 0; y < sh; y++) {
        const sRow = y * sw * 4;
        const dRow = y * dw * 4;
        for (let x = 0; x < dw; x++) {
            const l = xs[x * 2]!;
            const r = xs[x * 2 + 1]!;
            const n = r - l;
            let b = 0;
            let g = 0;
            let red = 0;
            let aSum = 0;
            for (let i = l; i < r; i++) {
                const p = sRow + i * 4;
                const av = src[p + 3]!;
                if (weighted) {
                    b += src[p]! * av;
                    g += src[p + 1]! * av;
                    red += src[p + 2]! * av;
                } else {
                    b += src[p]!;
                    g += src[p + 1]!;
                    red += src[p + 2]!;
                }
                aSum += av;
            }
            const q = dRow + x * 4;
            if (weighted) {
                // 反预乘：除以 alpha 之和，而不是除以像素数
                if (aSum > 0) {
                    mid[q] = (b / aSum) | 0;
                    mid[q + 1] = (g / aSum) | 0;
                    mid[q + 2] = (red / aSum) | 0;
                }
                mid[q + 3] = (aSum / n) | 0;
            } else {
                mid[q] = (b / n) | 0;
                mid[q + 1] = (g / n) | 0;
                mid[q + 2] = (red / n) | 0;
                mid[q + 3] = (aSum / n) | 0;
            }
        }
    }

    // ---- 垂直：sh → dh ----
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const l = ys[y * 2]!;
        const r = ys[y * 2 + 1]!;
        const n = r - l;
        const dRow = y * dw * 4;
        for (let x = 0; x < dw; x++) {
            let b = 0;
            let g = 0;
            let red = 0;
            let aSum = 0;
            for (let i = l; i < r; i++) {
                const p = (i * dw + x) * 4;
                const av = mid[p + 3]!;
                if (weighted) {
                    b += mid[p]! * av;
                    g += mid[p + 1]! * av;
                    red += mid[p + 2]! * av;
                } else {
                    b += mid[p]!;
                    g += mid[p + 1]!;
                    red += mid[p + 2]!;
                }
                aSum += av;
            }
            const q = dRow + x * 4;
            if (weighted) {
                if (aSum > 0) {
                    out[q] = (b / aSum) | 0;
                    out[q + 1] = (g / aSum) | 0;
                    out[q + 2] = (red / aSum) | 0;
                }
                out[q + 3] = (aSum / n) | 0;
            } else {
                out[q] = (b / n) | 0;
                out[q + 1] = (g / n) | 0;
                out[q + 2] = (red / n) | 0;
                out[q + 3] = (aSum / n) | 0;
            }
        }
    }

    return { bgra: out, width: dw, height: dh };
}
