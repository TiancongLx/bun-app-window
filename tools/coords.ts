/**
 * coords.ts — 截图坐标 ↔ 窗口 / 客户区 / 屏幕坐标的映射
 *
 * ## 存在理由
 *
 * 一张截图喂给模型，模型回一个点：「点这里 (734, 218)」。那个数字是**图像坐标**，
 * 而 `SendInput` 要的是**屏幕坐标**。中间隔着三层换算，每一层都有一个会让点击整体
 * 偏移的错误写法：
 *
 * ```text
 * image  ──除缩放比─→  裁剪区  ──加裁剪偏移─→  window  ──加窗口屏幕位置─→  screen
 *                          （整窗图像坐标）
 *                                              └─减客户区偏移─→ client
 * ```
 *
 * 三种坐标各自的意义必须分清，混用任意两个都会表现为「点得到，但总是偏一点」：
 *
 * | 名称 | 原点 | 单位 |
 * | --- | --- | --- |
 * | image | 输出图像左上角（模型看到的那张） | 输出图像像素 |
 * | window | 整窗矩形左上角（`PrintWindow` 画出来的那张的坐标基准） | 物理像素 |
 * | client | 客户区左上角（页面内容区的左上角） | 物理像素 |
 * | screen | 虚拟桌面原点（副屏在左侧时可以是负数） | 物理像素 |
 *
 * ## 为什么 `full` 与 `window` 分开存
 *
 * `PrintWindow` 的输出尺寸与 `GetWindowRect` 的宽度理论上相等，但这是**两个 API 的
 * 巧合**，不是契约。把它们视为同一个值，会在任何一处 1px 出入时让整条链静默偏移。
 * 所以 `ShotFrame` 里两者并存，缩放比只从 `full` 与 `crop` 推。
 *
 * ## 取整
 *
 * 所有映射都返回浮点数，不做中间取整——中间取整会累积误差。真正要注入之前调
 * `roundPoint()`，那是唯一该取整的位置。
 */

import { clientOrigin, clientRect, dpiOfWindow, windowRect, type Rect as WinRect } from "../native/win32";

/** 左闭右开的矩形（`x + width` 是右边界，不在矩形内） */
export type Box = { x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

/**
 * 一张截图的几何真相：从图像坐标回到屏幕坐标所需的全部信息。
 *
 * 由 `frameFor()` 采集，之后所有映射都是它上面的纯函数——可以脱离真窗口做单测。
 */
export type ShotFrame = {
    /** 模型看到的输出图像尺寸 */
    image: { width: number; height: number };
    /**
     * 未裁剪、未缩放时的整窗图像尺寸（物理像素）。
     *
     * 与 `window` 的宽高通常相等，但**不假设相等**：前者是 `PrintWindow` 实际画出来的
     * 尺寸，后者是 `GetWindowRect` 报的尺寸，两个 API 各自独立。
     */
    full: { width: number; height: number };
    /** 截图整窗在屏幕上的矩形（物理像素） */
    window: Box;
    /** 客户区左上角在屏幕上的位置（物理像素） */
    clientOrigin: Point;
    /**
     * 客户区尺寸（物理像素）。
     *
     * 不能从 `full - clientShift` 推：那只减掉了左边与上边，右边框还留着。
     * 无边框窗口两者相等，带边框窗口会差出一整条右边框——正好是「点最右侧元素总是
     * 差几像素」的成因。
     */
    client: { width: number; height: number };
    /** 裁剪区域（整窗图像坐标）；`null` 表示未裁剪 */
    crop: Box | null;
    /** 采集时的窗口 DPI（96 = 100%） */
    dpi: number;
};

/** Win32 的 `{left,top,right,bottom}` → `{x,y,width,height}` */
export function boxFromRect(r: WinRect): Box {
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/** 采集一张截图的几何真相；窗口已消失或 `ClientToScreen` 失败时返回 `null` */
export function frameFor(
    hwnd: bigint,
    opts: {
        /** 输出图像尺寸（模型看到的那张） */
        image: { width: number; height: number };
        /** 未裁剪、未缩放时的整窗图像尺寸；省略时用窗口矩形尺寸 */
        full?: { width: number; height: number };
        /** 裁剪区域（整窗图像坐标）；省略或 `null` 表示未裁剪 */
        crop?: Box | null;
    },
): ShotFrame | null {
    const origin = clientOrigin(hwnd);
    if (!origin) {
        return null;
    }
    const win = boxFromRect(windowRect(hwnd));
    const cli = clientRect(hwnd);
    return {
        image: { width: opts.image.width, height: opts.image.height },
        full: opts.full
            ? { width: opts.full.width, height: opts.full.height }
            : { width: win.width, height: win.height },
        window: win,
        clientOrigin: origin,
        client: { width: cli.right - cli.left, height: cli.bottom - cli.top },
        crop: opts.crop ?? null,
        dpi: dpiOfWindow(hwnd),
    };
}

/**
 * 图像坐标 → 整窗图像坐标的缩放比。
 *
 * 分母取「裁剪区宽度」而不是 `full.width`：裁剪之后剩下的那块才是输出图像的来源。
 * 两者任一为 0（还没截图 / 裁剪参数写歪）时返回 1，让映射退化为恒等而不是 `Infinity`。
 */
export function scaleOf(frame: ShotFrame): { x: number; y: number } {
    const srcW = frame.crop ? frame.crop.width : frame.full.width;
    const srcH = frame.crop ? frame.crop.height : frame.full.height;
    const sx = srcW > 0 ? frame.image.width / srcW : 1;
    const sy = srcH > 0 ? frame.image.height / srcH : 1;
    return { x: sx > 0 ? sx : 1, y: sy > 0 ? sy : 1 };
}

/** 客户区左上角相对整窗图像左上角的偏移 */
export function clientShift(frame: ShotFrame): Point {
    return {
        x: frame.clientOrigin.x - frame.window.x,
        y: frame.clientOrigin.y - frame.window.y,
    };
}

// ---- 图像 ↔ 整窗 -----------------------------------------------------------

/** 输出图像坐标 → 整窗图像坐标（物理像素） */
export function imageToWindow(frame: ShotFrame, p: Point): Point {
    const s = scaleOf(frame);
    return {
        x: (frame.crop ? frame.crop.x : 0) + p.x / s.x,
        y: (frame.crop ? frame.crop.y : 0) + p.y / s.y,
    };
}

/** 整窗图像坐标 → 输出图像坐标 */
export function windowToImage(frame: ShotFrame, p: Point): Point {
    const s = scaleOf(frame);
    return {
        x: (p.x - (frame.crop ? frame.crop.x : 0)) * s.x,
        y: (p.y - (frame.crop ? frame.crop.y : 0)) * s.y,
    };
}

// ---- 整窗 ↔ 屏幕 -----------------------------------------------------------

/** 整窗图像坐标 → 屏幕坐标 */
export function windowToScreen(frame: ShotFrame, p: Point): Point {
    return { x: frame.window.x + p.x, y: frame.window.y + p.y };
}

/** 屏幕坐标 → 整窗图像坐标 */
export function screenToWindow(frame: ShotFrame, p: Point): Point {
    return { x: p.x - frame.window.x, y: p.y - frame.window.y };
}

// ---- 整窗 ↔ 客户区 ---------------------------------------------------------

/** 整窗图像坐标 → 客户区坐标 */
export function windowToClient(frame: ShotFrame, p: Point): Point {
    const d = clientShift(frame);
    return { x: p.x - d.x, y: p.y - d.y };
}

/** 客户区坐标 → 整窗图像坐标 */
export function clientToWindow(frame: ShotFrame, p: Point): Point {
    const d = clientShift(frame);
    return { x: p.x + d.x, y: p.y + d.y };
}

// ---- 复合：图像 ↔ 屏幕 / 客户区 ---------------------------------------------

/** **模型给的坐标 → `SendInput` 要的坐标**。这条是 Computer Use 的主路径 */
export function imageToScreen(frame: ShotFrame, p: Point): Point {
    return windowToScreen(frame, imageToWindow(frame, p));
}

/** 屏幕坐标 → 输出图像坐标（回读某点落在图上的哪个位置时用） */
export function screenToImage(frame: ShotFrame, p: Point): Point {
    return windowToImage(frame, screenToWindow(frame, p));
}

/** 输出图像坐标 → 客户区坐标（想知道「点的是页面的哪个位置」时用） */
export function imageToClient(frame: ShotFrame, p: Point): Point {
    return windowToClient(frame, imageToWindow(frame, p));
}

/** 客户区坐标 → 输出图像坐标 */
export function clientToImage(frame: ShotFrame, p: Point): Point {
    return windowToImage(frame, clientToWindow(frame, p));
}

// ---- 有效性 ---------------------------------------------------------------

/** 点是否落在输出图像内（左闭右开） */
export function insideImage(frame: ShotFrame, p: Point): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < frame.image.width && p.y < frame.image.height;
}

/**
 * 输出图像坐标对应的点是否落在客户区内（左闭右开）。
 *
 * 客户区尺寸用 `frame.client`，不用 `full - shift` 反推：反推会把右边框与下边框
 * 一起算进客户区，于是「点最右边一列元素」看起来总在范围内，实际已经点到边框上了。
 */
export function insideClient(frame: ShotFrame, p: Point): boolean {
    const c = imageToClient(frame, p);
    return c.x >= 0 && c.y >= 0 && c.x < frame.client.width && c.y < frame.client.height;
}

/**
 * 取整到整数像素。
 *
 * **只在真正要注入输入之前调**。中间环节取整会累积误差：一次 `imageToScreen` 已经
 * 做了「除缩放 + 加偏移」两步，若每步都 `Math.round`，在 0.5 附近来回挪一格，
 * 几百像素之外就能差出一个控件。
 *
 * 用 `Math.round` 而不是 `Math.floor`：`floor` 会让所有点系统性偏左上半个像素。
 */
export function roundPoint(p: Point): Point {
    return { x: Math.round(p.x), y: Math.round(p.y) };
}
