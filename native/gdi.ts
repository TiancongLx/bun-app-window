/**
 * gdi.ts — **图标**生成与提取用的 GDI 位图操作
 *
 * 取代 `.ps1` 版里的 `System.Drawing.Bitmap` + `Icon.ToBitmap()`。核心手法只有一个：
 * **`CreateDIBSection` 拿到自己的像素指针**，之后所有读写都是普通内存操作，
 * 不再经过任何托管图像类型。
 *
 * 这样做的额外好处：`DrawIconEx` 的目标 HDC 直接就是我们能读的那块内存，
 * 省掉「先画到 Bitmap 再 Save」这一层，也就不需要 PNG 之外的任何编码器。
 *
 * ## 能力边界（ADR 0017）
 *
 * 这里只留**图标提取的完整闭包**：`makeBitmapInfo` → `createDib` → `readDibPixels`
 * → `releaseDib`，加上 `extractIcon` / `closeGdi`。它服务的是一次构建链自证：
 * `scripts/extract-icon.ts` 从编译产物里把图标挖出来，证明 `--windows-icon` 生效。
 *
 * **窗口截图（`PrintWindow`）、裁剪、非黑像素占比都不在这里**——那是
 * `echoes-of-the-eye` 的职责（它要观察任意窗口）。历史上有过一份，迁走之后留下了
 * 142 行只有测试在用的残骸，2026-10-21 按 ADR 0017 清掉了。
 *
 * 所有函数都返回显式结果（`null` / `false` / 抛错），不返回「看起来像成功的空值」。
 */

import { FFIType, dlopen, toArrayBuffer } from "bun:ffi";

import { api, toHandle } from "./win32";

const gdi32 = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: [FFIType.u64_fast], returns: FFIType.u64_fast },
    CreateDIBSection: {
        args: [FFIType.u64_fast, "buffer", "u32", "buffer", FFIType.u64_fast, "u32"],
        returns: FFIType.u64_fast,
    },
    SelectObject: { args: [FFIType.u64_fast, FFIType.u64_fast], returns: FFIType.u64_fast },
    DeleteObject: { args: [FFIType.u64_fast], returns: "bool" },
    DeleteDC: { args: [FFIType.u64_fast], returns: "bool" },
    GetObjectW: { args: [FFIType.u64_fast, "i32", "buffer"], returns: "i32" },
});

const shell32 = dlopen("shell32.dll", {
    ExtractIconExW: {
        args: ["buffer", "i32", "buffer", "buffer", "u32"],
        returns: "u32",
    },
});

// ---- BITMAPINFOHEADER ------------------------------------------------------

const BI_RGB = 0;
const DIB_RGB_COLORS = 0;
const BITMAPINFOHEADER_SIZE = 40;

/**
 * 拼一个 top-down 32bpp 的 `BITMAPINFOHEADER`。
 *
 * `biHeight` 取**负值**表示 top-down：扫描行从上到下，与 PNG 的行序一致，
 * 省掉一次翻转。正数会得到 bottom-up，读出来是上下颠倒的图——
 * 这个错误不会报错，只会让截图看起来「像被镜像过」。
 */
export function makeBitmapInfo(width: number, height: number): Uint8Array {
    const buf = new Uint8Array(BITMAPINFOHEADER_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint32(0, BITMAPINFOHEADER_SIZE, true); // biSize
    view.setInt32(4, width, true); // biWidth
    view.setInt32(8, -height, true); // biHeight（负数 = top-down）
    view.setUint16(12, 1, true); // biPlanes
    view.setUint16(14, 32, true); // biBitCount
    view.setUint32(16, BI_RGB, true); // biCompression
    view.setUint32(20, width * height * 4, true); // biSizeImage
    view.setInt32(24, 2835, true); // biXPelsPerMeter ≈72dpi
    view.setInt32(28, 2835, true); // biYPelsPerMeter
    view.setUint32(32, 0, true); // biClrUsed
    view.setUint32(36, 0, true); // biClrImportant
    return buf;
}

// ---- DIB 生命周期 -----------------------------------------------------------

export type Dib = {
    /** 内存 DC；用完 `releaseDib` */
    hdc: bigint;
    /** 位图句柄；`SelectObject` 选进 hdc 的那个 */
    hBitmap: bigint;
    /** `SelectObject` 之前的旧对象，还原时必须选回去 */
    hOld: bigint;
    width: number;
    height: number;
    /** 像素指针（BGRA，top-down） */
    bits: bigint;
};

/**
 * 建一块可以直接读写的 32bpp DIB。
 *
 * 失败时返回 null 并清理已创建的部分——Windows 句柄泄漏在诊断脚本里尤其讨厌，
 * 因为它们会被反复调用。
 */
export function createDib(width: number, height: number): Dib | null {
    if (width <= 0 || height <= 0) return null;

    // 全部走 toHandle：`u64_fast` 的返回值在 number 与 bigint 之间**不确定**
    // （同一个 API 两次调用可能给出不同类型，实测 CreateCompatibleDC 两种都出现过）。
    // 手写 `typeof x === "number"` 判空会把 bigint 句柄误判成 0，
    // 那就是 extract-icon 最初失败的原因。见 docs/pitfalls.md 3.7。
    const hdc = toHandle(gdi32.symbols.CreateCompatibleDC(0n));
    if (hdc === 0n) return null;

    const info = makeBitmapInfo(width, height);
    const bitsOut = new BigUint64Array(1);
    const hBitmap = toHandle(gdi32.symbols.CreateDIBSection(hdc, info, DIB_RGB_COLORS, bitsOut, 0n, 0));
    if (hBitmap === 0n) {
        gdi32.symbols.DeleteDC(hdc);
        return null;
    }

    const hOld = toHandle(gdi32.symbols.SelectObject(hdc, hBitmap));

    return {
        hdc,
        hBitmap,
        hOld,
        width,
        height,
        bits: bitsOut[0] ?? 0n,
    };
}

/** 还原选中的对象并释放 DC/位图 */
export function releaseDib(dib: Dib): void {
    if (dib.hOld !== 0n) gdi32.symbols.SelectObject(dib.hdc, dib.hOld);
    if (dib.hBitmap !== 0n) gdi32.symbols.DeleteObject(dib.hBitmap);
    if (dib.hdc !== 0n) gdi32.symbols.DeleteDC(dib.hdc);
}

/** 读 DIB 的像素（BGRA 连续内存的副本） */
export function readDibPixels(dib: Dib): Uint8Array {
    const len = dib.width * dib.height * 4;
    if (dib.bits === 0n) return new Uint8Array(len);
    const buf = toArrayBuffer(Number(dib.bits), 0, len);
    return new Uint8Array(buf.slice(0));
}

// ---- 图标 -------------------------------------------------------------------

export type ExtractedIcon = {
    /** 提取到的图标数量（`ExtractIconExW` 的返回值） */
    count: number;
    width: number;
    height: number;
    /** BGRA，top-down */
    bgra: Uint8Array;
};

/**
 * 从可执行文件/图标文件里提取第 `index` 个图标，渲染成 BGRA。
 *
 * 链路：`ExtractIconExW` → HICON → `GetIconInfo` 拿 hbmColor →
 * `GetObjectW` 问尺寸 → 建同尺寸 DIB → `DrawIconEx` 画进去 → 读像素。
 *
 * 走 `DrawIconEx` 而不是直接 `GetDIBits(hbmColor)`：图标位图的格式不固定
 * （可能是 1/4/8/32bpp 或带掩码），`DrawIconEx` 由系统负责转换和合成 alpha。
 */
export function extractIcon(exePath: Uint8Array, index = 0): ExtractedIcon | null {
    const large = new BigUint64Array(1);
    const small = new BigUint64Array(1);
    const count = shell32.symbols.ExtractIconExW(exePath, index, large, small, 1);
    if (typeof count !== "number" || count < 1) return null;

    const hIcon = toHandle(large[0]);
    if (hIcon === 0n) return null;

    try {
        const info = new Uint8Array(32);
        if (api.user32.symbols.GetIconInfo(hIcon, info) !== true) return null;
        const view = new DataView(info.buffer);
        const hbmMask = toHandle(view.getBigUint64(16, true));
        const hbmColor = toHandle(view.getBigUint64(24, true));

        try {
            const size = hbmColor !== 0n ? bitmapSize(hbmColor) : hbmMask !== 0n ? bitmapSize(hbmMask) : null;
            if (!size) return null;

            const dib = createDib(size.width, size.height);
            if (!dib) return null;
            try {
                // DI_NORMAL = 0x0003：画图像 + 用掩码做透明
                // 九个参数：hdc, x, y, hIcon, cx, cy, istep, hbrFlickerFree, diFlags
                const ok = api.user32.symbols.DrawIconEx(dib.hdc, 0, 0, hIcon, size.width, size.height, 0, 0n, 0x0003);
                if (ok !== true) return null;
                return {
                    count,
                    width: size.width,
                    height: size.height,
                    bgra: readDibPixels(dib),
                };
            } finally {
                releaseDib(dib);
            }
        } finally {
            if (hbmColor !== 0n) gdi32.symbols.DeleteObject(hbmColor);
            if (hbmMask !== 0n) gdi32.symbols.DeleteObject(hbmMask);
        }
    } finally {
        api.user32.symbols.DestroyIcon(hIcon);
        const hSmall = small[0] ?? 0n;
        if (hSmall !== 0n) api.user32.symbols.DestroyIcon(hSmall);
    }
}

/** `GetObjectW(hbm, sizeof(BITMAP), &bmp)` 取位图尺寸 */
function bitmapSize(hBitmap: bigint): { width: number; height: number } | null {
    const buf = new Uint8Array(32);
    const n = gdi32.symbols.GetObjectW(hBitmap, buf.length, buf);
    if (typeof n !== "number" || n === 0) return null;
    const view = new DataView(buf.buffer);
    const width = view.getInt32(4, true);
    const height = view.getInt32(8, true);
    if (width <= 0 || height <= 0) return null;
    // 图标位图的 height 可能是两倍（图像 + 掩码），取一半
    return { width, height: Math.abs(height) };
}

/** 释放模块级 dlopen 句柄 */
export function closeGdi(): void {
    for (const lib of [gdi32, shell32]) {
        try {
            lib.close();
        } catch {
            // 已关闭，不影响判定
        }
    }
}
