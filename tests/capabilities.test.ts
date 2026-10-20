import { expect, test } from "bun:test";

import { FLAG_ACCEPT_DROP, FLAG_CENTER, FLAG_DEFER_SHOW, FLAG_FRAMELESS } from "@/shell/types";

/**
 * 0.4.0 新增能力与 API 分层的守护。
 *
 * 这些断言锁的是「顺序 / 位数 / 入口隔离」，不是行为——行为靠真机验收。
 * 改回去不会报错，只会静默退化，所以必须有静态守护。
 */
const SHELL_CC = await Bun.file(
    `${import.meta.dir}/../native/shell.cc`,
).text();

test("FLAG_ACCEPT_DROP 是独立位，不与既有标志冲突", () => {
    expect(FLAG_ACCEPT_DROP).toBe(32);
    for (const f of [FLAG_FRAMELESS, FLAG_CENTER, FLAG_DEFER_SHOW, FLAG_ACCEPT_DROP]) {
        expect(f & (f - 1)).toBe(0);
    }
    expect(FLAG_ACCEPT_DROP & FLAG_FRAMELESS).toBe(0);
});

test("拖放需要在提权场景下放行 UIPI", () => {
    // 只 DragAcceptFiles 不够：High 完整性进程收不到 Medium 发来的 WM_DROPFILES
    expect(SHELL_CC).toContain("DragAcceptFiles");
    expect(SHELL_CC).toContain("ChangeWindowMessageFilterEx");
    expect(SHELL_CC).toContain("WM_DROPFILES, MSGFLT_ALLOW");
});

test("键盘处理挂在两个窗口过程的共用前置，不各写一份", () => {
    // 两份会漂移：无边框模式能用、带边框模式不能用（或反之）
    const calls = SHELL_CC.split("handle_input_message(hwnd, msg, wp, lp, &handled)").length - 1;
    expect(calls).toBe(2);
    expect(SHELL_CC).toContain("case VK_F11:");
    expect(SHELL_CC).toContain("case VK_F12:");
    expect(SHELL_CC).toContain("MK_CONTROL");
});

test("缩放走 COM，且钳制在阶梯范围内", () => {
    expect(SHELL_CC).toContain("put_ZoomFactor");
    expect(SHELL_CC).toContain("kZoomLadder");
    // Ctrl+0 复位到 1.0
    expect(SHELL_CC).toContain("apply_zoom(1.0)");
});

test("状态推送带变化检测与节流尾随补齐", () => {
    expect(SHELL_CC).toContain("g_pushed.px_w");
    expect(SHELL_CC).toContain("flush_push_state");
    // 被节流时必须挂定时器补发，否则最后一次状态会永久丢失
    expect(SHELL_CC).toContain("SetTimer(g_hwnd, kPushTimerId");
    expect(SHELL_CC).toContain("case WM_TIMER:");
});

/**
 * 「跳过节流」与「跳过变化检测」是两个不同的意图。
 *
 * 它们曾经是同一个 `bool force`：`flush_push_state()` 复用它，结果在状态其实
 * 没变时也补发一条一模一样的消息。实测启动时页面连续收到两条
 * `maximized:false`（2026-10-21 截图确认）。
 *
 * 现在分成三级 `PushMode`，这条断言守的是「谁可以用最宽松的那一级」。
 */
test("尾随补齐只跳过节流，仍要过变化检测", () => {
    // 三级都在
    expect(SHELL_CC).toContain("enum class PushMode { None, BypassThrottle, BypassAll }");
    // 变化检测只放过 BypassAll
    expect(SHELL_CC).toMatch(/if \(same && mode != PushMode::BypassAll\)/);
    // 节流只拦 None
    expect(SHELL_CC).toMatch(/mode == PushMode::None && now - g_pushed\.at/);

    // flush 必须用中间那一级——用 BypassAll 就会重复推送
    const flushAt = SHELL_CC.indexOf("void flush_push_state()");
    const flushBody = SHELL_CC.slice(flushAt, flushAt + 400);
    expect(flushBody).toContain("push_state(PushMode::BypassThrottle)");
    expect(flushBody).not.toContain("PushMode::BypassAll");
});

test("最大化状态下不做边框命中（Windows 语义：最大化窗口不能拖边缩放）", () => {
    // 这条守的是「判断必须写在代码里且带理由」——
    // 缺理由的有意判断，下一个人会当成 bug 重新排查一遍。
    // 理由写在函数**上方**的注释里，所以切片要从定义处往前多取一段
    const hitAt = SHELL_CC.indexOf("LRESULT hit_test_client(HWND hwnd, POINT pt)");
    expect(hitAt).toBeGreaterThan(0);
    const hitBody = SHELL_CC.slice(hitAt - 900, hitAt + 1200);
    expect(hitBody).toMatch(/!g_frameless \|\| !g_resizable \|\| IsZoomed\(hwnd\)/);
    // 理由必须在注释里写清楚，否则这条断言就只是形式
    expect(hitBody).toContain("最大化的窗口本来");
});

test("错误槽是互斥写 + 拷贝读出", () => {
    expect(SHELL_CC).toContain("g_err_mu");
    expect(SHELL_CC).toContain("shell_error_text");
    // 启动前清空，避免读到上一次的残留
    expect(SHELL_CC).toContain("clear_err()");
});

test("生命周期锁让「检查 webview 非空」与「投递」成为原子对", () => {
    expect(SHELL_CC).toContain("g_life_mu");
    // enqueue 必须持锁后再 dispatch
    const enqueueAt = SHELL_CC.indexOf("void enqueue(cmd_kind kind");
    const body = SHELL_CC.slice(enqueueAt, enqueueAt + 600);
    expect(body).toContain("std::lock_guard<std::mutex> life(g_life_mu)");
    expect(body).toContain("webview_dispatch");
});

test("shell_stop 必须把 terminate 分发到 UI 线程", () => {
    // vendor 的 terminate_impl 是 PostQuitMessage(0)：只投给调用线程的队列。
    // 从宿主线程直接调 = 静默无效（窗口还在、is_alive 仍为真、再 start 报
    // 「shell already started」）。实测踩过，见 pitfalls 2.4g。
    expect(SHELL_CC).toContain("terminate_on_ui");
    const stopAt = SHELL_CC.indexOf("void shell_stop(void)");
    expect(stopAt).toBeGreaterThan(0);
    const body = SHELL_CC.slice(stopAt, stopAt + 400);
    expect(body).toContain("webview_dispatch(g_webview, terminate_on_ui");
    // 不允许直接调
    expect(body).not.toMatch(/webview_terminate\(g_webview\)/);
});

test("窗口位置：读的是还原矩形，且对外部坐标做屏幕校验", () => {
    // 最大化时用 WINDOWPLACEMENT.rcNormalPosition，而不是 GetWindowRect 的整屏尺寸
    expect(SHELL_CC).toContain("rcNormalPosition");
    // 屏外坐标要能救回来：按与工作区的交叠面积判断
    expect(SHELL_CC).toContain("intersect_area");
    expect(SHELL_CC).toContain("EnumDisplayMonitors");
    // DPI 变化要按比例换算
    expect(SHELL_CC).toContain("MulDiv(w, static_cast<int>(dpi), saved_dpi)");
});
