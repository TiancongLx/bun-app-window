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
    const showNow = SHELL_CC.slice(SHELL_CC.indexOf("void show_now()"), SHELL_CC.indexOf("void min_track_size"));
    expect(showNow).toContain("SetForegroundWindow");
    expect(showNow).toContain("SetFocus");
});

/**
 * 去掉整行注释后的源码。
 *
 * 为什么需要它：静态断言如果不剔注释，**注释掉一行就能绕过护栏**——
 * 实测过：把 `force_visible();` 改成 `// force_visible();`，原先的
 * `toContain` / 计数断言照样通过，双向验证立刻变红。
 *
 * 只剔「整行注释」（`//`、`*`、`/*` 开头）。行尾注释不动——剥离它需要
 * 处理字符串字面量里的 `//`，代价大于收益，而本次护栏关心的调用都独占一行。
 */
const SHELL_CODE = SHELL_CC.split(/\r?\n/)
    .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

/**
 * 窗口「创建成功但永远不可见」。
 *
 * ShowWindow 的**第一次**调用会被启动方的 STARTUPINFO 覆盖：父进程以
 * `STARTF_USESHOWWINDOW` + `SW_HIDE` 创建我们时（OTT 的 run_command 就是），
 * Windows 用 STARTUPINFO 的 wShowWindow 代替我们传的 nCmdShow，于是
 * `ShowWindow(SW_SHOW)` 实际变成「隐藏」。
 *
 * 可怕之处在于它**不会让任何现有断言变红**：窗口确实存在，几何、命中测试、
 * 最大化、PrintWindow 截图全部正常——只有 IsWindowVisible 为假。自检读的是
 * metrics，看不见这个差别，门禁照样全绿。2026-10-21 实测：
 * `Start-Process -WindowStyle Hidden` 起的进程 12 次采样全是 WS_VISIBLE=False，
 * 去掉该参数 1 秒内变 True；加上 force_visible() 后两者都正常。
 *
 * 所以这里守的不是「有没有调 ShowWindow」，而是「调用之后有没有复核并兜底」。
 */
test("显示窗口后必须复核可见性并兜底（STARTUPINFO 会覆盖第一次 ShowWindow）", () => {
    // 全部断言都跑在剔掉注释的源码上——注释掉的实现不算实现
    expect(SHELL_CODE).toContain("void force_visible()");
    // 判据必须是 IsWindowVisible，不能拿 ShowWindow 的返回值当判据——
    // 它返回的是「之前是否可见」，无论成功与否都可能为假
    expect(SHELL_CODE).toMatch(/if \(IsWindowVisible\(g_hwnd\)\) return;/);
    // 第二层兜底用 SWP_SHOWWINDOW：它不读 nCmdShow，不受 STARTUPINFO 影响
    expect(SHELL_CODE).toContain("SWP_SHOWWINDOW");
});

test("两条显示路径都调用 force_visible（frameless 与带边框同源）", () => {
    // show_now() 里 1 处 + 带边框分支 1 处；只数代码里的调用，不含声明与注释
    const calls = [...SHELL_CODE.matchAll(/force_visible\(\);/g)].length;
    expect(calls).toBeGreaterThanOrEqual(2);

    // show_now 内的调用必须在 ShowWindow 之后
    const showWindowAt = SHELL_CODE.indexOf("ShowWindow(g_hwnd, g_start_maximized ? SW_SHOWMAXIMIZED : SW_SHOW);");
    const callAt = SHELL_CODE.indexOf("force_visible();", showWindowAt);
    expect(showWindowAt).toBeGreaterThan(0);
    expect(callAt).toBeGreaterThan(showWindowAt);
});

/**
 * 首次显示不能跳过变化检测。
 *
 * `ShowWindow` 内部会**同步**触发 `WM_SIZE`，那一次已经走 `push_state(None)`
 * 推过显示后的真实状态。若 `show_now()` 末尾再用 `BypassAll`（跳过变化检测），
 * 就会把同样的内容再推一遍。
 *
 * 实测症状：页面日志里出现两条字段完全相同、时间戳只差 1 ms 的
 * `maximized:false`。判据不是「看着重复」，是 `host.log` 里两条 `win-report`
 * 的毫秒数。
 *
 * 用 `BypassThrottle` 才是对的：万一 `WM_SIZE` 那次被 16 ms 节流吃掉，
 * 这一发补上；已经推过则变化检测拦住。
 */
test("首次显示用 BypassThrottle，不能用 BypassAll", () => {
    const showNowAt = SHELL_CODE.indexOf("void show_now()");
    expect(showNowAt).toBeGreaterThan(0);
    const showNowBody = SHELL_CODE.slice(showNowAt, showNowAt + 1600);
    expect(showNowBody).toContain("push_state(PushMode::BypassThrottle)");
    expect(showNowBody).not.toContain("PushMode::BypassAll");
});
