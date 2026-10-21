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

/**
 * 剔掉整行注释后的源码。
 *
 * 结构性断言必须跑在它上面：否则注释掉一行实现、再在注释里写上那串字，断言照样通过
 * ——那就是在测注释（`pitfalls` 2.9）。既有的几条断言仍跑在原文上，因为其中一条
 * 查的正是「注释里有没有写理由」。
 */
const SHELL_CODE = SHELL_CC.split(/\r?\n/)
    .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

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

/**
 * 光放行 UIPI 还不够：**OLE 拖放会被 WebView2 内部接走**。
 *
 * 两条实测事实（`pitfalls` 2.14 / 2.15）：
 *
 * 1. `DragAcceptFiles` 只设 `WS_EX_ACCEPTFILES`，**不注册** `OleDropTargetInterface`
 *    ——查整条窗口链的 `DropTarget` property 全为 false，现代 Windows 的 OLE 命中
 *    测试不会 fallback 到那条 legacy 路径。
 * 2. `put_AllowExternalDrop(FALSE)` 的语义是「**禁止**外部拖放」，不是「让给父窗口」。
 *    0.5.0 用它换来的结果是用户拖文件进来看到红色拒绝图标。
 *
 * 所以只能走上游给的正路：让 WebView2 接管拖放（它自己已经注册好 `IDropTarget`），
 * 用 `ICoreWebView2WebMessageReceivedEventArgs2::get_AdditionalObjects` 从页面
 * `postMessage` 里取出 `ICoreWebView2File`，`get_Path` 拿绝对路径。
 * **不许自己写 `IDropTarget`**——那要解析 `IDataObject` 的 `CF_HDROP`，还要与
 * WebView2 的命中测试打架。
 *
 * 静态断言抓不到「拖放真的通了」（那是 `scripts/probe-drop.ts` 与真实拖放的事），
 * 但能抓「有人换回 AllowExternalDrop」「有人换回手写 IDropTarget」「注入脚本被删」。
 */
test("拖放走 AdditionalObjects 取真实路径，且禁止再关 WebView2 的 drop target", () => {
    // 上游接口真的被用上：AdditionalObjects → ICoreWebView2File::get_Path
    expect(SHELL_CODE).toContain("get_AdditionalObjects");
    expect(SHELL_CODE).toContain("QueryInterface(IID_ICoreWebView2File");
    expect(SHELL_CODE).toContain("get_Path");
    // 0.5.0 的回归点：这一行会让用户看到红色拒绝图标
    expect(SHELL_CODE).not.toContain("AllowExternalDrop");
    // MinGW 无 IID 符号库：必须走 IID_* 常量 + QueryInterface（pitfalls 3.2）
    expect(SHELL_CODE).not.toContain("__uuidof");

    // 订阅必须在 enable_drop 里发生——否则开关打开也白搭
    const enableAt = SHELL_CODE.indexOf("void enable_drop(HWND hwnd)");
    expect(enableAt).toBeGreaterThan(0);
    const enableEnd = SHELL_CODE.indexOf("\n}", enableAt);
    const enableBody = SHELL_CODE.slice(enableAt, enableEnd);
    expect(enableBody).toContain("install_drop_handler()");

    // 老运行时没有 EventArgs2：QueryInterface 失败时必须静默放过，不能阻断其它消息
    expect(SHELL_CODE).toContain(
        "FAILED(args->QueryInterface(IID_ICoreWebView2WebMessageReceivedEventArgs2,",
    );

    // 反注册必须在 destroy 之前，否则处理器挂在已死的 core 上
    const runAt = SHELL_CODE.indexOf("webview_run(g_webview)");
    const uninstallAt = SHELL_CODE.indexOf("uninstall_drop_handler();");
    expect(runAt).toBeGreaterThan(0);
    expect(uninstallAt).toBeGreaterThan(runAt);
});

/**
 * 注入脚本是主路的前半段：页面 drop 不转发到宿主，`AdditionalObjects` 永远是空的。
 *
 * 四条都是「缺了就完全没反应」，且四条的现象一模一样。逐条钉住：
 *
 * 1. `dragenter` / `dragover` 都要 `preventDefault()` —— 落点不被接受时 `drop` 不来。
 * 2. `dataTransfer.dropEffect = 'copy'` —— `preventDefault()` 只表态「可能接受」，
 *    `dropEffect` 才是给用户看的结论。默认 `none` 时实测 `dragenter=1 dragover=72
 *    drop=0`（`pitfalls` 2.16）。
 * 3. 投递必须是 `postMessageWithAdditionalObjects`，**不是 `postMessage`** ——
 *    后者把 `File` 序列化成 `{}`，`get_Count` 恒 0，而调用照样成功返回。
 * 4. `__shellDropReady` 标记 —— 没有它，「没反应」分不清是脚本没注入还是 OS 挡了。
 */
test("拖放注入脚本覆盖四道关，且只在开关打开时注入", () => {
    expect(SHELL_CC).toContain("kDropInit");
    expect(SHELL_CC).toContain("'dragenter', allow, true");
    expect(SHELL_CC).toContain("'dragover', allow, true");
    expect(SHELL_CC).toContain("dropEffect = 'copy'");
    expect(SHELL_CC).toContain("postMessageWithAdditionalObjects");
    expect(SHELL_CC).toContain("window.__shellDropReady = 1");

    // 只有会序列化失败的那个 API 不该再出现（注释里保留说明是允许的，
    // 所以判据跑在剔掉整行注释的 SHELL_CODE 上）
    expect(SHELL_CODE).not.toContain("webview.postMessage(");

    // 注入是条件性的：没开 FLAG_ACCEPT_DROP 的窗口不该背这段脚本
    const appendAt = SHELL_CC.indexOf("initScript += kDropInit");
    expect(appendAt).toBeGreaterThan(0);
    expect(SHELL_CC.slice(appendAt - 120, appendAt)).toContain("g_accept_drop");
});

/**
 * 目录拖放走的是**另一条通路**，而且必须两条一起传。
 *
 * 实测（`pitfalls` 2.17）：`getAsFileSystemHandle()` 的产物到宿主时两个 QI 全失败
 * （`nHandle=0`、`nNoPath=1`），而目录在 `dataTransfer.files` 里会以一个 `File`
 * 出现、`get_Path` 给得出正确路径。所以：
 *
 * - 注入脚本必须 `handles.concat(files)` 一起投；只传 handles 会一个路径都拿不到；
 * - 判定「是不是目录」不能用 `get_Kind`（`File` 没有 kind），必须落到
 *   `GetFileAttributesW` + `FILE_ATTRIBUTE_DIRECTORY`；
 * - `shell-msg` 必须带 `dirs`，否则消费者分不出文件与文件夹。
 */
test("拖放同时传 handles 与 files，目录靠文件系统属性判定", () => {
    // 两条一起投
    expect(SHELL_CC).toContain("handles.concat(files)");
    // 有超时兜底：handle 不兑现时仍要把 files 发出去
    expect(SHELL_CC).toContain("files-timeout");

    // 目录判定不能只靠 get_Kind
    expect(SHELL_CODE).toContain("FILE_ATTRIBUTE_DIRECTORY");
    // 主路与兜底路各一处
    const attrCalls = SHELL_CODE.split("GetFileAttributesW(").length - 1;
    expect(attrCalls).toBe(2);

    // shell-msg 必须带 dirs 字段
    expect(SHELL_CODE).toContain('\\"dirs\\":[');

    // 宿主无论如何都要回报：取不到路径也要发一条带 ok/err 的消息
    expect(SHELL_CODE).toContain('\\"ok\\":');
    expect(SHELL_CODE).toContain("AdditionalObjects is empty");

    // 去重：handles+files 会给同一载体两条相同路径
    expect(SHELL_CODE).toContain("seen.push_back(path)");
});

test("键盘处理挂在两个窗口过程的共用前置，不各写一份", () => {
    // 两份会漂移：无边框模式能用、带边框模式不能用（或反之）
    const calls = SHELL_CC.split("handle_input_message(hwnd, msg, wp, lp, &handled)").length - 1;
    expect(calls).toBe(2);
    expect(SHELL_CC).toContain("case VK_F11:");
    expect(SHELL_CC).toContain("case VK_F12:");
    expect(SHELL_CC).toContain("MK_CONTROL");
});

/**
 * 真实按键必须走 WebView2 的 AcceleratorKeyPressed。
 *
 * `WM_KEYDOWN` 只投递给**焦点窗口**，而焦点在 WebView2 的渲染子窗口上——它不把
 * 未处理的按键转发给父窗口。于是挂在两个 WndProc 上的处理对真实按键永远不触发，
 * 而 `PostMessage(WM_KEYDOWN)` 又能正常全屏：判定逻辑完全正确，断的是消息路由。
 *
 * 只断言「调用点 === 2」抓不到这个 bug，因为那两条调用点一直都在、也都能被
 * PostMessage 走到。这条断言守的是「订阅点存在且在消息循环之前」。
 */
test("快捷键订阅走 AcceleratorKeyPressed，且订阅点早于消息循环", () => {
    // 上游接口真的被用上了（vendor SDK 1.0.4258.31 里就有，不需要升级）
    expect(SHELL_CC).toContain("add_AcceleratorKeyPressed");
    expect(SHELL_CC).toContain("COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN");
    expect(SHELL_CC).toContain("COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN");
    // 处理过的必须吃掉，否则页面同时也会收到这个按键
    expect(SHELL_CC).toContain("put_Handled(TRUE)");

    // 订阅点必须在 webview_run **之前**：消息循环一起来，键盘就已经可能落在页面上
    const installAt = SHELL_CODE.indexOf("install_accelerator_handler();");
    const runAt = SHELL_CODE.indexOf("webview_run(g_webview)");
    expect(installAt).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(0);
    expect(installAt).toBeLessThan(runAt);

    // 反注册必须在 destroy 之前：destroy 之后拿不到 controller
    const uninstallAt = SHELL_CODE.indexOf("uninstall_accelerator_handler();");
    const destroyAt = SHELL_CODE.indexOf("webview_destroy(g_webview)");
    expect(uninstallAt).toBeGreaterThan(0);
    expect(uninstallAt).toBeLessThan(destroyAt);

    // 判定只有一处：定义 1 次 + 两个调用点（accelerator 回调 / WM_KEYDOWN 残余）
    const calls = SHELL_CODE.split("handle_accelerator_key(").length - 1;
    expect(calls).toBe(3);
});

/**
 * 首次显示的宿主事件：**兜底**，不是唯一来源。
 *
 * 2026-10-21 对照实验（摘掉 `show_now()` 末尾的 `emit_state_event()` 重编译后跑
 * `scripts/probe-window-events.ts`）：21 条检查**全部仍然通过**，带边框与无边框
 * 都还是有「启动后收到 STATE 事件」。也就是说首帧事件本来就有别的来源——
 * 带边框模式的 `WM_SIZE` / `WM_ACTIVATE` 经 `toplevel_proc` 已经入队。
 *
 * 所以这条断言守的只是「兜底那一次调用还在」，**不要**把它当成
 * 「启动后没有事件」这个 bug 的判据；那个判据是探针里的行为断言。
 * 同时这也说明：判断某行代码是不是根因，必须做单变量对照，不能看到绿就归因。
 */
test("首次显示路径仍保留一条宿主 STATE 兜底", () => {
    const showAt = SHELL_CODE.indexOf("void show_now()");
    expect(showAt).toBeGreaterThan(0);
    const showEnd = SHELL_CODE.indexOf("\n}", showAt);
    expect(showEnd).toBeGreaterThan(showAt);
    const body = SHELL_CODE.slice(showAt, showEnd);

    // 推给页面的是 shell-msg，推给宿主的是事件环，两条通道不能互相顶替
    expect(body).toContain("push_state(");
    expect(body).toContain("emit_state_event()");
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
    const hitBody = SHELL_CC.slice(hitAt - 900, hitAt + 1600);

    // 判据取「IsZoomed 出现在缩放判定的返回 HTCLIENT 分支里」，**不绑表达式形状**。
    //
    // 最初这里匹配的是合并写法 `!g_frameless || !g_resizable || IsZoomed(hwnd)`。
    // 2026-10-21 引入 caption button 命中后，前置条件被拆成两段
    // （caption button 先判、且不受 resizable / zoomed 影响；缩放边框仍跳过最大化），
    // 精确表达式不再存在 —— 但**语义一点没变**。绑定形状的断言在重构面前必然假红，
    // 而它真正要守的是「最大化不进缩放分支」，所以改成行为意图。
    expect(hitBody).toMatch(/if \(!g_resizable \|\| IsZoomed\(hwnd\)\) \{\s*return HTCLIENT;/);

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

// ---- G2 窗口生命周期事件 ----

/**
 * 这一节守的三件事都属于「写错了门禁也不会红」：
 *
 * 1. **带边框模式的事件入队点**。那个窗口由 webview 库创建，`shell_wnd_proc`
 *    根本不在它的消息链上——只有 `toplevel_proc` 在。只改一处的话，默认
 *    （带边框）配置下宿主永远收不到尺寸与最大化事件，而所有测试照样绿。
 * 2. **环容量与满时策略**。丢最旧还是丢最新决定了宿主会不会看到「冻结的旧状态」。
 * 3. **`CLOSED` 的位置**。它必须发生在 teardown 全部做完之后，否则
 *    「看到 CLOSED 就能 restart」这条等式不成立。
 */
test("两个窗口过程都给宿主事件留了入队点", () => {
    const shellProcAt = SHELL_CODE.indexOf("LRESULT CALLBACK shell_wnd_proc");
    const toplevelProcAt = SHELL_CODE.indexOf("LRESULT CALLBACK toplevel_proc");
    expect(shellProcAt).toBeGreaterThan(0);
    expect(toplevelProcAt).toBeGreaterThan(0);

    const shellBody = SHELL_CODE.slice(shellProcAt, toplevelProcAt);
    const toplevelBody = SHELL_CODE.slice(toplevelProcAt);
    expect(shellBody).toContain("emit_state_event()");
    expect(toplevelBody).toContain("emit_state_event()");

    // 带边框分支不许顺手调 push_state()：页面推送的 16 ms 节流是给跨进程
    // webview_eval 设计的，新开一条会让页面突然收到以前没有的 win 消息。
    // 切片到 `case WM_TIMER:` 之前——再往后就跨到下一个分支了，
    // 而那个分支里正好有 `flush_push_state()`（判据写到那里就成了测别人的代码）。
    const sizeAt = toplevelBody.indexOf("case WM_SIZE:");
    const timerAt = toplevelBody.indexOf("case WM_TIMER:", sizeAt);
    expect(sizeAt).toBeGreaterThan(0);
    expect(timerAt).toBeGreaterThan(sizeAt);
    const sizeBlock = toplevelBody.slice(sizeAt, timerAt);
    expect(sizeBlock).toContain("emit_state_event()");
    expect(sizeBlock).not.toContain("push_state(");
});

test("事件环容量 128，满时丢最旧", () => {
    expect(SHELL_CODE).toContain("kEventCapacity = 128");
    const emitAt = SHELL_CODE.indexOf("void emit_event(");
    expect(emitAt).toBeGreaterThan(0);
    const body = SHELL_CODE.slice(emitAt, emitAt + 900);
    // 满时推进读游标（丢最旧）。拒收最新会让环冻结在旧状态上，
    // 宿主看到的是「窗口一直没变」——比丢历史危险得多
    expect(body).toContain("++g_ev_tail;");
    expect(body).toContain("kEventCapacity");
});

test("记录布局由编译期断言钉住", () => {
    expect(SHELL_CODE).toContain("static_assert(sizeof(EventRecord) == 32");
    // 容量必须是 2 的幂：入队用位与取模
    expect(SHELL_CODE).toContain("kEventCapacity & (kEventCapacity - 1)");
});

test("CLOSED 在 teardown 之后发，且轮询不因 g_webview 为空而早退", () => {
    const nullAt = SHELL_CODE.indexOf("g_webview = nullptr;");
    const closedAt = SHELL_CODE.indexOf("emit_closed_event();");
    expect(nullAt).toBeGreaterThan(0);
    expect(closedAt).toBeGreaterThan(nullAt);

    // 早退成 -1 会让 CLOSED 永远读不到——它恰恰产生于 g_webview 为空之后
    const pollAt = SHELL_CODE.indexOf("int shell_poll_events(void *buf, int capacity)");
    expect(pollAt).toBeGreaterThan(0);
    const pollBody = SHELL_CODE.slice(pollAt, pollAt + 800);
    expect(pollBody).not.toContain("!g_webview");
});

test("事件类型与位掩码在两侧逐值一致", async () => {
    const ev = await import("@/shell/events");
    expect(SHELL_CODE).toContain("SHELL_EVENT_STATE = 1");
    expect(SHELL_CODE).toContain("SHELL_EVENT_CLOSED = 2");
    expect(SHELL_CODE).toContain("SHELL_EV_MAXIMIZED = 1");
    expect(SHELL_CODE).toContain("SHELL_EV_MINIMIZED = 2");
    expect(SHELL_CODE).toContain("SHELL_EV_FOCUSED = 4");
    expect(SHELL_CODE).toContain("SHELL_EV_DARK = 8");

    expect(ev.EVENT_STATE).toBe(1);
    expect(ev.EVENT_CLOSED).toBe(2);
    expect(ev.EV_MAXIMIZED).toBe(1);
    expect(ev.EV_MINIMIZED).toBe(2);
    expect(ev.EV_FOCUSED).toBe(4);
    expect(ev.EV_DARK).toBe(8);
});

test("两侧的环容量与记录长度同一个数", async () => {
    const ev = await import("@/shell/events");
    expect(ev.EVENT_QUEUE_CAPACITY).toBe(128);
    expect(ev.EVENT_RECORD_BYTES).toBe(32);
    expect(SHELL_CODE).toContain("kEventCapacity = 128");
});

test("事件环用自己的锁，不与生命周期锁 / 命令锁嵌套", () => {
    // 锁序表里它是孤点：合并进 g_life_mu 或 g_queue_mu 都会在销毁期带来死锁风险
    expect(SHELL_CODE).toContain("SRWLOCK g_ev_mu = SRWLOCK_INIT;");
    const emitAt = SHELL_CODE.indexOf("void emit_event(");
    const body = SHELL_CODE.slice(emitAt, emitAt + 900);
    expect(body).not.toContain("g_life_mu");
    expect(body).not.toContain("g_queue_mu");
});
