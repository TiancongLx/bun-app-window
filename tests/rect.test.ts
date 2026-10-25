import { expect, test } from "bun:test";
import { join } from "node:path";

import { createShell } from "@/shell/index";
import { parseBounds as parseBoundsFromState, type WindowPlacement } from "@/shell/state";
import { parseBounds, type WindowRect } from "@/shell/types";

/**
 * `Shell.getRect()`：把原生那一行 `"x,y,w,h,maximized,dpi"` 提升成正式的结构化读数。
 *
 * 这个文件存在的理由与判据一一对应：
 *
 * 1) **别把字符串当契约**。0.8.0 之前宿主只能拿到 `getBounds()` 的原文，
 *    每个消费方各写一遍 `split(",")` —— 抄漏 `dpi` 不会有任何信号。
 * 2) **判据必须能红**。把实现改成 `getRect: readBounds`（原样返回字符串），
 *    本文件必须红；红的点不能是「类型检查顺手拦住了」，因为 `bun test` 与
 *    `bun check` 是两个独立阶段，测试自己得站得住。
 * 3) **类型不能各抄一份**。`WindowPlacement` 与 `WindowRect` 若各自定义成
 *    结构相同的两份类型，`savePlacement(file, shell.getRect())` 会在字段漂移时
 *    静默丢字段（宽结构能赋给窄的）。这里用「可互换」把它钉住。
 *
 * 成功路径（窗口真开着时读出矩形）没有放进 `bun test`：那要真起一个 WebView2
 * 窗口，依赖交互式桌面会话，与 `bun run demo` 同属人工验证面。这里守的是
 * **结构性判据**——文本怎么变结构、失败怎么表达、实现有没有绕过解析。
 */

test("WindowPlacement 与 WindowRect 可互换（同一份读数，不许各抄一份）", () => {
    const rect: WindowRect = { x: 10, y: 20, width: 900, height: 700, maximized: false, dpi: 96 };
    // 赋值本身就是判据：形状漂移时 `bun check` 会在这一行红
    const placement: WindowPlacement = rect;
    expect(placement).toEqual(rect);

    // 反方向同样要成立，否则 `savePlacement(file, shell.getRect())` 编译不过
    const back: WindowRect = placement;
    expect(back).toEqual(rect);
});

test("parseBounds 在 types 与 state 两个入口是同一个函数对象", () => {
    // `./state` 只是转出。若哪天有人在 state.ts 里复制一份实现，两者就不再相等，
    // 两条读路会各自漂移——而它们判的是同一对哨兵阈值。
    expect(parseBoundsFromState).toBe(parseBounds);
});

test("窗口未启动时 getRect() 返回 null，而 getBounds() 是空串", async () => {
    const shell = await createShell({ url: "http://127.0.0.1:1" });
    try {
        // 原生 `format_bounds` 在 !g_hwnd 时直接返回 0 长度，这是既有契约
        expect(shell.getBounds()).toBe("");
        // 结构化出口对同一份「读不到」的表达是 null，不是空对象、不是全零矩形
        expect(shell.getRect()).toBeNull();
    } finally {
        shell.stop();
    }
});

test("**反向**：getRect() 不能退化成 getBounds() 的直传", async () => {
    // 变异验证：把实现改成 `getRect: readBounds`，本断言必红。
    //
    // 取 `typeof` 而不是 `toEqual(null)` 是有意的：后者在「实现返回了字符串但恰好
    // 是空串」时也能红，可一旦窗口真的开着（手工复跑探针时）空串就不再出现，
    // 判据会随环境变绿。`typeof` 与窗口状态无关——直传永远是 string。
    const shell = await createShell({ url: "http://127.0.0.1:1" });
    try {
        expect(typeof shell.getRect()).not.toBe("string");
    } finally {
        shell.stop();
    }
});

test("getRect 的实现确实经过 parseBounds（判据锚在调用链上）", async () => {
    // 上一条测的是外部行为，这一条测的是「有没有绕过解析」。
    // 两者不可互相替代：实现若写成手搓的 `{ x: Number(p[0]), ... }`，
    // typeof 那条照样绿，而这里会红。
    const src = await Bun.file(join(import.meta.dir, "..", "src", "shell", "index.ts")).text();
    const at = src.lastIndexOf("getRect:");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 120)).toContain("parseBounds(");
});
