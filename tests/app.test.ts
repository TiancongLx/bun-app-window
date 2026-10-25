import { expect, test } from "bun:test";

import { resolve } from "node:path";

import { DEFAULT_APP_FLAGS, PAGE_JS_PATH, buildAppUrl, decideWs } from "@/shell/app";
import { FLAG_CENTER, FLAG_FRAMELESS, FLAG_RESIZABLE } from "@/shell/types";

/**
 * 应用骨架的守护。
 *
 * 这个模块是纯编排，主体（起服务 + 开窗）需要交互式桌面，测不了。所以断言集中在
 * 两处**真会写错**的地方：
 *
 *  1. `/ws` 的处置判据 —— 三个分支的顺序与状态码都有陷阱（`ipc` 没开该是 404 不是 403；
 *     token 必须在升级**之前**拒绝，升级之后就没有机会说不了）。
 *  2. 默认 flags —— 上一版的直觉是「无边框才配得上这个包」，但无边框窗口没有系统
 *     标题栏就**拖不动**，必须由页面先挂 `mountTitleBar`。默认值若选错，「只写了
 *     HTML」的应用一上来就无法拖动。
 *
 * 另外两条静态断言守住顺序与卫生——它们在运行时才出错，而运行时出错得靠人盯着窗口看。
 */
const APP_TS = await Bun.file(resolve(import.meta.dir, "../src/shell/app.ts")).text();

/** 剔掉整行注释后的源码（同 `first-paint.test.ts`：注释掉的实现不算实现） */
const APP_CODE = APP_TS.split(/\r?\n/)
    .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const TOKEN = "11111111-2222-3333-4444-555555555555";

test("默认 flags 不含 FLAG_FRAMELESS", () => {
    // 这不是偏好问题：无边框 = 没有系统标题栏 = 拖不动，
    // 而那要求页面先 mountTitleBar。默认值必须选「页面什么都不做也能用」的那一侧。
    expect(DEFAULT_APP_FLAGS & FLAG_FRAMELESS).toBe(0);
});

test("默认 flags 含可缩放与居中", () => {
    expect(DEFAULT_APP_FLAGS & FLAG_RESIZABLE).toBe(FLAG_RESIZABLE);
    expect(DEFAULT_APP_FLAGS & FLAG_CENTER).toBe(FLAG_CENTER);
});

test("buildAppUrl 把 token 放进查询参数，且端口落在安全区间", () => {
    const url = buildAppUrl(51234, TOKEN);
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("127.0.0.1");
    expect(parsed.port).toBe("51234");
    expect(parsed.pathname).toBe("/");
    // 页面侧 connect() 默认从 ?t= 取 token；键名改了等于改协议
    expect(parsed.searchParams.get("t")).toBe(TOKEN);
});

test("buildAppUrl 不会拼出 undefined 端口", () => {
    // `Bun.serve` 的 port 是 `number | undefined`，顺手断言会让这里变成
    // "http://127.0.0.1:undefined/?t=..." —— WebView2 会把它当合法 URL 打开一个空白窗
    const url = buildAppUrl(40000, TOKEN);
    expect(url).not.toContain("undefined");
});

test("decideWs：非 /ws 一律交回默认处理", () => {
    expect(decideWs("/", TOKEN, TOKEN, true)).toBe("not-ws");
    expect(decideWs("/index.html", TOKEN, TOKEN, true)).toBe("not-ws");
    // 前缀相同但不是 /ws 的路径不能被当成通道
    expect(decideWs("/wsx", TOKEN, TOKEN, true)).toBe("not-ws");
    expect(decideWs("/api/ws", TOKEN, TOKEN, true)).toBe("not-ws");
});

test("decideWs：没开 ipc 时是 404 而不是 403", () => {
    // 差别不只是状态码：403 等于告诉扫描者「这里有通道，只是你没钥匙」
    expect(decideWs("/ws", TOKEN, TOKEN, false)).toBe("ipc-disabled");
    // 即便 token 对也一样——通道压根不存在
    expect(decideWs("/ws", null, TOKEN, false)).toBe("ipc-disabled");
});

test("decideWs：token 不符必须拒绝", () => {
    expect(decideWs("/ws", null, TOKEN, true)).toBe("forbidden");
    expect(decideWs("/ws", "", TOKEN, true)).toBe("forbidden");
    expect(decideWs("/ws", "wrong", TOKEN, true)).toBe("forbidden");
    // 前缀匹配不算通过
    expect(decideWs("/ws", TOKEN.slice(0, -1), TOKEN, true)).toBe("forbidden");
    expect(decideWs("/ws", `${TOKEN}x`, TOKEN, true)).toBe("forbidden");
});

test("decideWs：token 相符才升级", () => {
    expect(decideWs("/ws", TOKEN, TOKEN, true)).toBe("upgrade");
});

/**
 * `/ws` 必须在 `routes` 之前处理。
 *
 * 反过来写会让调用方的 catch-all 路由（SPA fallback 常写成「总是返回 index.html」）
 * 把 WebSocket 升级请求吃掉，表现为页面连不上 IPC、而 HTTP 一切正常。
 */
test("handle 里 /ws 的判定早于 routes 回调", () => {
    const wsAt = APP_CODE.indexOf("decideWs(");
    const routesAt = APP_CODE.indexOf("opts.routes?.(");
    expect(wsAt).toBeGreaterThan(0);
    expect(routesAt).toBeGreaterThan(0);
    expect(wsAt).toBeLessThan(routesAt);
});

/**
 * `/page.js` 的三条顺序约束。
 *
 * 这是 `AppOptions.page` 的全部接线，而它有三个容易写反的次序：
 *
 * 1. 必须在 `routes` **之后**——调用方要能覆盖它（与 `/` 的处理同一原则）；
 * 2. 必须在 `"/"` 判断**之前或之后都行**，但不能落进 404；
 * 3. `content-type` 必须是 `text/javascript`，否则 `<script type="module">`
 *    拒绝执行且不报语法错，表现是白屏加一条 MIME 警告。
 *
 * 三条都是「跑起来才知道」的错误，所以钉在静态形状上。
 */
test("handle 里 /page.js 的处理在 routes 之后、404 之前", () => {
    const routesAt = APP_CODE.indexOf("opts.routes?.(");
    const pageAt = APP_CODE.indexOf("url.pathname === PAGE_JS_PATH");
    const notFoundAt = APP_CODE.lastIndexOf('new Response("not found"');

    expect(routesAt).toBeGreaterThan(0);
    expect(pageAt).toBeGreaterThan(0);
    expect(notFoundAt).toBeGreaterThan(0);

    expect(pageAt).toBeGreaterThan(routesAt);
    expect(pageAt).toBeLessThan(notFoundAt);
});

test("/page.js 的 content-type 是 text/javascript", () => {
    // 浏览器对 module 脚本做严格 MIME 检查。写错不报语法错，只是不执行。
    expect(APP_CODE).toContain('const PAGE_JS_CONTENT_TYPE = "text/javascript; charset=utf-8"');
    // 且这条常量必须真的用在 page 分支上，不能只是定义着
    expect(APP_CODE).toContain("PAGE_JS_CONTENT_TYPE");
});

/**
 * `assets` 的位置约束（ADR 0021）。
 *
 * 顺序上只有一条要求：**在 `routes` 之后**。`assets` 是便利设施，调用方的显式路由
 * 必须能覆盖它——反过来会让「我写了路由却被 assets 抢先」变成一条难查的规则。
 *
 * 与 `/page.js` 的先后不构成契约：`/page.js` 只由 `page` 参数提供，正常配置下
 * `assets` 里不会出现该路径。
 */
test("handle 里 assets 的处理在 routes 之后", () => {
    const routesAt = APP_CODE.indexOf("opts.routes?.(");
    const assetsAt = APP_CODE.indexOf("opts.assets?.[");

    expect(routesAt).toBeGreaterThan(0);
    expect(assetsAt).toBeGreaterThan(0);
    expect(assetsAt).toBeGreaterThan(routesAt);
});

test("assets 的 content-type 来自扩展名推断，不是写死的 text/plain", () => {
    // 写死会让样式表以错误 MIME 送达，浏览器静默不应用——正是 assets 要消除的那类问题
    expect(APP_CODE).toContain("contentTypeFor(url.pathname)");
});

test("PAGE_JS_PATH 固定为 /page.js", () => {
    // 路径与调用方 HTML 里的 `<script src>` 必须一致，所以不给它留配置项。
    expect(PAGE_JS_PATH).toBe("/page.js");
});

test("没给 page 时该路径不被占用 —— 行为与引入本项之前一致", () => {
    // `opts.page !== undefined &&` 这半句是「不给就不生效」的唯一保证。
    // 少了它，`page` 未定义时会返回一个内容为 "undefined" 的脚本响应。
    expect(APP_CODE).toContain("opts.page !== undefined && url.pathname === PAGE_JS_PATH");
});

/**
 * `stop()` 必须先等窗口销毁再关服务。
 *
 * 原生层是进程级单例，`shell_stop()` 只是投一个 `WM_QUIT`。抢在前面关服务，
 * 或紧接着再 `start()`，会撞上「shell already started」（`pitfalls` 2.4g / 7.1）。
 *
 * 等的判据是 `EVENT_CLOSED`，不是 `isAlive()`：CLOSED 由原生侧在 teardown
 * 全部做完、`g_webview` 已置空之后写进队列，它出现的时刻才等于「单例已释放」。
 */
test("stop 里 shell.stop 早于 server.stop，中间等 EVENT_CLOSED", () => {
    const stopAt = APP_CODE.indexOf("async stop()");
    expect(stopAt).toBeGreaterThan(0);
    const body = APP_CODE.slice(stopAt, stopAt + 900);

    const shellStopAt = body.indexOf("shell.stop()");
    const awaitClosedAt = body.indexOf("closed.promise");
    const serverStopAt = body.indexOf("server.stop(");

    expect(shellStopAt).toBeGreaterThan(0);
    expect(serverStopAt).toBeGreaterThan(0);
    // 缺了这段等待，关服务的时机就退化成「投完 WM_QUIT 立刻关」——顺序对了也不够
    expect(awaitClosedAt).toBeGreaterThan(shellStopAt);
    expect(serverStopAt).toBeGreaterThan(shellStopAt);
});

/**
 * 等 CLOSED 必须有超时上限。
 *
 * 事件通道若因故失效（原生库被替换、pump 提前停），`closed.promise` 永不兑现，
 * 宿主会被永久挂住——那比「关得慢」严重得多。
 */
test("等 CLOSED 与超时赛跑，且超时后也 resolve 一次", () => {
    const stopAt = APP_CODE.indexOf("async stop()");
    const waitAt = APP_CODE.indexOf("async wait()");
    expect(stopAt).toBeGreaterThan(0);
    expect(waitAt).toBeGreaterThan(stopAt);
    const body = APP_CODE.slice(stopAt, waitAt);
    expect(body).toContain("Promise.race(");
    // 超时分支若不 resolve，wait() 会永远挂着
    expect(body.indexOf("closed.resolve()")).toBeGreaterThan(body.indexOf("Promise.race("));
});

/**
 * 超时定时器必须可取消。
 *
 * `Promise.race` 只取先兑现的，**不取消输掉的那个**。早先用 `Bun.sleep(CLOSE_TIMEOUT_MS)`，
 * 正常关窗路径下它变成一个没人等的、未 unref 的 5 秒定时器，把 Bun 的事件循环撑满：
 * 实测 `race returned @ 9ms`，进程到 5010 ms 才退出，真实关窗 5043 ms。
 */
test("关窗超时用可取消定时器，且清理在 finally 里", () => {
    const stopAt = APP_CODE.indexOf("async stop()");
    const waitAt = APP_CODE.indexOf("async wait()");
    const body = APP_CODE.slice(stopAt, waitAt);

    // Bun.sleep 不可取消，正是本 bug 的成因
    expect(body).not.toContain("Bun.sleep");
    expect(body).toContain("clearTimeout");

    // 清理必须落在 finally：超时/异常路径同样不能留悬挂定时器
    const finallyAt = body.indexOf("} finally {");
    expect(finallyAt).toBeGreaterThan(0);
    const cleanup = body.slice(finallyAt, finallyAt + 200);
    expect(cleanup).toContain("cancelTimeout()");
});

/**
 * pump 必须 keepAlive。
 *
 * unref 的定时器不撑事件循环，而「等一个永不兑现的 promise」也撑不住——
 * 两者叠加会让宿主在窗口还开着的时候直接退出。
 */
test("app 的事件泵不 unref（wait 靠它撑住事件循环）", () => {
    expect(APP_CODE).toContain("keepAlive: true");
});

test("openShell 失败时必须关掉本地服务，不留半启动状态", () => {
    const shellAt = APP_CODE.indexOf("shell = await openShell(");
    expect(shellAt).toBeGreaterThan(0);
    // 失败分支里要有 server.stop；否则端口被占着，「重试一次」也会失败
    const catchAt = APP_CODE.indexOf("} catch (err) {", shellAt);
    expect(catchAt).toBeGreaterThan(shellAt);
    const catchBody = APP_CODE.slice(catchAt, catchAt + 200);
    expect(catchBody).toContain("server.stop(");
});

/**
 * 模块卫生。`app.ts` 从 `./index` 导入 `openShell`，如果 `index.ts` 反过来导出
 * `app`，就成循环。本仓 `src/shell/index.ts` 有一条「零顶层副作用」的硬约束，
 * 循环会让评估顺序变得不可推理。
 */
test("app 不被主入口导出（避免 app → index → app 循环）", async () => {
    const indexPath = resolve(import.meta.dir, "../src/shell/index.ts");
    const index = await Bun.file(indexPath).text();
    expect(index).not.toContain('from "./app"');
    expect(index).not.toContain('export * from "./app"');
});
