import { expect, test } from "bun:test";

import { resolve } from "node:path";

/**
 * 首帧闪屏的回归守护。
 *
 * 三个独立缺陷叠在一起才会闪，每个都必须有对应的源码约束，否则改回去不会报错：
 *
 *  1) 窗口被提前显示：webview 的 set_size_impl 结尾调 window_show()，
 *     必须在 WM_SHOWWINDOW 里压住，且子类化要装在 set_size 之前。
 *  2) 露出的底色是白：WebView2 表面未绘制时是默认白底，
 *     必须设 put_DefaultBackgroundColor。
 *  3) 首帧是半成品：显示时机要由页面 rAF 信号决定，不是固定延时。
 *
 * 第 3 条在页面侧（rAF 之后 POST 一个 ready 信号），这里管住原生侧两条。
 */
const SHELL_CC = await Bun.file(resolve(import.meta.dir, "../native/shell.cc")).text();

test("延迟显示期间，外部显示请求被 WM_SHOWWINDOW 压住", () => {
    expect(SHELL_CC).toContain("case WM_SHOWWINDOW:");
    // 真正的动作是 SWP_HIDEWINDOW + 跳过 UpdateWindow 路径
    expect(SHELL_CC).toContain("SWP_HIDEWINDOW");
    // 我们自己的显示不能被拦：靠 g_shown 放行
    expect(SHELL_CC).toMatch(/wp == TRUE && g_defer_show && !g_shown/);
});

test("子类化必须在 webview_set_size 之前安装", () => {
    const subclassAt = SHELL_CC.indexOf("subclass_toplevel();");
    const setSizeAt = SHELL_CC.indexOf("webview_set_size(g_webview");
    expect(subclassAt).toBeGreaterThan(0);
    expect(setSizeAt).toBeGreaterThan(0);
    expect(subclassAt).toBeLessThan(setSizeAt);
});

test("webview_set_size 不能被绕过（否则会被默认 640x480 覆盖）", () => {
    // 它置位内部 m_is_size_set；少了这一步，webview 会在消息循环里补一次默认尺寸
    expect(SHELL_CC).toContain("webview_set_size(g_webview, g_start_w, g_start_h, WEBVIEW_HINT_NONE)");
});

test("WebView2 默认底色在 navigate 之前设置", () => {
    expect(SHELL_CC).toContain("apply_default_background");
    expect(SHELL_CC).toContain("put_DefaultBackgroundColor");
    // ICoreWebView2Controller2 的 IID（MinGW 无 IID 符号库）
    expect(SHELL_CC).toContain("0xc979903e");
    // 顺序：设底色必须早于导航，否则白底那一帧已经画出去了
    const bgAt = SHELL_CC.indexOf("apply_default_background(g_webview");
    const navAt = SHELL_CC.indexOf("webview_navigate(g_webview");
    expect(bgAt).toBeGreaterThan(0);
    expect(navAt).toBeGreaterThan(0);
    expect(bgAt).toBeLessThan(navAt);
});

test("show_now 会激活窗口（接管显示后必须自己补 SetFocus）", () => {
    const showNow = SHELL_CC.slice(
        SHELL_CC.indexOf("void show_now()"),
        SHELL_CC.indexOf("void min_track_size"),
    );
    expect(showNow).toContain("SetForegroundWindow");
    expect(showNow).toContain("SetFocus");
});
