/**
 * app.ts — 应用骨架：把「起服务 → 开窗 → 接线 → 等退出」收成一次调用
 *
 * ## 为什么需要它
 *
 * 用这个包做第一个应用时，真正要写的业务代码可能只有 30 行，但**宿主样板**是
 * 另外 180 行：挑安全端口、生成鉴权 token、处理 WebSocket 升级、把 HTML 当字符串
 * 吐出去、把 `createIpcServer` 接到 Bun 的 websocket 回调上、拿窗口 flags、
 * 处理 `openShell` 失败、等窗口关闭（`EVENT_CLOSED`）、按顺序 `stop()` 两次。
 *
 * 每一段单看都不难，但它们**必须按特定顺序且互相依赖**——`stop()` 不先等窗口
 * 销毁就去关服务，下次启动会撞上「进程级单例还在」；WS 升级不在 `fetch` 里做，
 * 鉴权就没有落点。这些顺序关系在 `src/host.ts` 里被验证过一遍，但没有沉淀成
 * 可复用的东西，所以每个消费者都要再踩一次。
 *
 * ## 两个设计选择
 *
 * **不导出到主入口。** 它和 `./state`、`./ipc`、`./titlebar` 一样是可选件，
 * 走独立子路径 `bun-app-window/app`。好处不只是「按需引入」——`app.ts` 从
 * `./index` 导入 `openShell`，如果 `index.ts` 反过来导出 `app`，就成了循环。
 * 单向依赖比运行时安全的循环更值得要。
 *
 * **静态资源只吃内联字符串。** 用 `import html from "./index.html" with { type: "text" }`
 * 得到的是编译期常量：不碰文件系统、不产生临时文件、`bun build --compile` 后仍然成立。
 * 从目录读则要处理 `import.meta.dir` 在打包后指向 `B:\~BUN\root` 的问题
 * （`src/host.ts` 里那段 `PACKED` 判断就是为它存在的）。那 5 行留给消费者自己写，
 * 用 `routes` 就能接。
 */

import { createIpcServer, type IpcServer, type ServiceMethods } from "./ipc";
import { EVENT_CLOSED, attachEventPump, type EventPump } from "./events";
import { openShell, type Shell } from "./index";
import { serveOnSafePort } from "./port";
import { FLAG_CENTER, FLAG_RESIZABLE, type ShellOptions } from "./types";
import { debugOf, type ShellDebug } from "./debug";
import { attachPlacementStore, type PlacementStore } from "./state";

/** 骨架起出来的东西。`shell` 是完整的内核对象，骨架只是帮它把周边接好 */
export type App = {
    /** 内核对象。标题、缩放、全屏、原生菜单、位置持久化都从这里拿 */
    readonly shell: Shell;
    /**
     * 窗口生命周期事件流。骨架替你起的**唯一**一个消费者。
     *
     * `shell.pollEvents()` 是消费式的，一个窗口只能有一个消费者。要用
     * `attachPlacementStore` 时传 `{ events: app.events }`，别再自己 attach
     * 一个泵——两个泵会各自拿到一部分事件。
     *
     * 定时器是 keepAlive 的（不 unref）：`wait()` 靠它让进程活到窗口关闭。
     */
    readonly events: EventPump;
    /** 本地服务实际绑定的端口（已避开浏览器受限端口表） */
    readonly port: number;
    /** 页面 URL：带鉴权 token 的查询参数，直接交给 `openShell` 用的就是它 */
    readonly url: string;
    /** 页面 URL 里的 token。页面侧 `connect()` 默认从这里取 */
    readonly token: string;
    /** 给了 `service` 才有；否则为 null */
    readonly ipc: IpcServer | null;
    /**
     * 排障接口（`hittest` / `metrics` / `dpi` / `selfBase` / `selfPath`）。
     *
     * 等价于 `debugOf(app.shell)`，只是省掉一次调用和一条子路径依赖。
     * 排障面的稳定性承诺与 `bun-app-window/debug` 相同：**随时可能变化，生产代码
     * 不应依赖**。骨架把它挂上来不改变这个定位，只是让它更好拿。
     */
    readonly debug: ShellDebug;
    /**
     * 把窗口位置持久化挂到这个 App 上。
     *
     * 与直接调 `attachPlacementStore(shell, file, { events })` 的差别只有一件事：
     * **事件泵由骨架提供**，不可能忘。那条 `{ events }` 参数漏掉的后果是
     * `attachPlacementStore` 自建第二个泵，而 `shell.pollEvents()` 是消费式的——
     * 两个泵各自拿到一部分事件，窗口位置会**随机漏掉**一些变化，且两端都不报错。
     * 这是本库里最容易静默出错的接线点，所以收进骨架。
     *
     * ```ts
     * const store = app.attachPlacement(join(dataDir, "window.json"));
     * // 关闭前：await store.flush(); store.dispose();
     * ```
     */
    attachPlacement(file: string, opts?: { debounceMs?: number }): PlacementStore;
    /**
     * 停止窗口与本地服务。
     *
     * 顺序是有意的：先 `shell.stop()`，再**等 `EVENT_CLOSED`**，最后才关服务。
     * 原生层是进程级单例，`shell_stop()` 只是投了一个 `WM_QUIT`；抢在前面关服务
     * 或重新 start，会撞上「shell already started」（详见 `pitfalls` 2.4g / 7.1）。
     *
     * 等的是事件不是 `isAlive()`：`CLOSED` 由原生侧在 teardown 全部做完、
     * `g_webview` 已置空之后写进队列，它出现的时刻就等于「单例已释放」。
     * 仍然保留超时上限——事件通道若因故失效，宿主不能被永久挂住。
     *
     * 幂等：重复调用立即返回。
     */
    stop(): Promise<void>;
    /**
     * 等窗口被关闭（用户点 X，或调用了 `stop()`）。
     *
     * 宿主进程不会因为窗口没了就自动退出——它自己起的本地服务还在跑。所以
     * 「应用该结束了」的判据是收到 `EVENT_CLOSED`，不是任何信号。
     *
     * 这个 promise 靠 `events` 的 keepAlive 定时器撑住事件循环；别在等它的同时
     * 把 `events.stop()` 掉，那样两边都收不到关闭信号。
     */
    wait(): Promise<void>;
};

export type AppOptions = {
    /**
     * 页面 HTML，用 `with { type: "text" }` 内联。
     *
     * ```ts
     * import html from "./index.html" with { type: "text" };
     * ```
     */
    html: string;
    title?: string;
    width?: number;
    height?: number;
    /**
     * 窗口 flags。缺省 `FLAG_RESIZABLE | FLAG_CENTER`（带边框）。
     *
     * 想要自绘标题栏时显式加 `FLAG_FRAMELESS`——骨架不默认它，因为无边框窗口
     * 没有系统标题栏就**拖不动**，而那需要页面先挂上 `mountTitleBar`。
     * 默认值选「即使页面什么都不做也能用」的那一侧。
     */
    flags?: number;
    minWidth?: number;
    minHeight?: number;
    /** 关掉哪些浏览器行为，取 `BROWSER_UI_*` 的按位或 */
    browserUi?: number;
    appName?: string;
    nativeLibPath?: string;
    embedded?: () => Promise<Uint8Array | null>;
    /**
     * 页面脚本（已打包的单文件 ESM 源码）。给了就自动在 `{@link PAGE_JS_PATH}`
     * 提供它，`content-type` 固定为 `text/javascript; charset=utf-8`。
     *
     * 传的是**字符串**，不是路径：构建期由 `bun-app-window/pack` 打好后内联进来，
     * 运行期不碰磁盘。写成路径会在 `bun build --compile` 之后失效，
     * 因为那时 `import.meta.dir` 指向 `B:\~BUN\root`。
     *
     * ```ts
     * import pageCode from "./ui/page.bundle.txt" with { type: "text" };
     * const app = await createApp({ html, page: pageCode as unknown as string });
     * ```
     *
     * 不给时该路径交回 `routes` 与默认处理（即 404），行为与引入本项之前一致。
     *
     * 调用方的 `routes` 仍然优于此项：返回非 `undefined` 就能覆盖它。
     */
    page?: string;
    /**
     * IPC 服务方法表。给了就自动挂 `/ws`（含 token 校验）。
     *
     * 页面侧：
     *
     * ```ts
     * import { connect } from "bun-app-window/ipc";
     * const api = await connect();   // 自动从 ?t= 取 token
     * ```
     */
    service?: ServiceMethods;
    /** IPC 错误里是否回传 stack。默认关闭 */
    exposeStack?: boolean;
    /**
     * 额外路由。返回 `undefined` 表示「不归我管」，交回骨架的默认处理
     * （`/` 吐 HTML、`/ws` 处理升级、其余 404）。
     *
     * 从磁盘读静态资源、代理上游 API 这类事情写在这里。
     */
    routes?: (req: Request) => Response | undefined | Promise<Response | undefined>;
    /** 窗口建好、服务就绪后调用一次 */
    onReady?: (app: App) => void;
};

/** 事件拉取节奏，约一帧 */
const EVENT_POLL_MS = 16;
/**
 * 等 `EVENT_CLOSED` 的上限。
 *
 * 实测关闭约 50 ms，5 s 是三个数量级的余量。存在的理由不是「怕关得慢」，
 * 而是「事件通道若因故失效，宿主不能被永久挂住」——超时后照旧关服务。
 */
const CLOSE_TIMEOUT_MS = 5000;

/** 一个只能 resolve 一次的 promise。等窗口关闭用它，比轮询一个布尔值清楚 */
function defer(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * 不给 `flags` 时用的默认值：**带边框** + 可缩放 + 居中。
 *
 * 刻意不默认 `FLAG_FRAMELESS`。无边框窗口没有系统标题栏就拖不动，必须由页面先挂上
 * `mountTitleBar` 才能用；把它设成默认值会让「只写了 HTML」的应用一上来就无法拖动。
 * 默认值应当选「页面什么都不做也能用」的那一侧。
 */
export const DEFAULT_APP_FLAGS = FLAG_RESIZABLE | FLAG_CENTER;

/** 页面 URL。token 放查询参数里，页面侧 `connect()` 默认从这里取 */
export function buildAppUrl(port: number, token: string): string {
    return `http://127.0.0.1:${port}/?t=${token}`;
}

/**
 * `AppOptions.page` 的服务路径。
 *
 * 固定为 `/page.js` 而不是可配置：页面 HTML 里写的是
 * `<script type="module" src="/page.js">`，两侧必须一致。留一个可配置项意味着
 * 多一处「配置与 HTML 对不上」的失败方式，而它换不来任何能力——路径本身没有人关心。
 *
 * 导出是为了让调用方的 HTML 与 `routes` 都能引用同一个常量，而不是各写一份字符串。
 */
export const PAGE_JS_PATH = "/page.js";

/**
 * 页面脚本响应的 `content-type`。
 *
 * 必须是 `text/javascript`。写成 `application/javascript` 浏览器也接受，但写成
 * `text/plain` 或漏掉时，`<script type="module">` 会**拒绝执行**且不报语法错——
 * 表现是页面白屏、控制台只有一条 MIME 类型警告，很容易被当成「脚本逻辑有问题」。
 */
const PAGE_JS_CONTENT_TYPE = "text/javascript; charset=utf-8";

/**
 * `/ws` 请求的处置结论。
 *
 * 抽成纯函数是因为这是整个骨架里**唯一有分支的判据**，而它有三个容易写反的点：
 * 路径要先比、`ipc` 没开时不能当 403（那是 404）、token 不匹配必须在**升级之前**
 * 拒绝——升级之后就没有机会说不了。
 *
 * token 用普通 `!==` 比较而不是恒定时间比较：它是一次性的本地回环随机值，
 * 不是长期凭据，时序侧信道在这里没有可换取的东西。
 */
export type WsDecision = "not-ws" | "ipc-disabled" | "forbidden" | "upgrade";

export function decideWs(
    pathname: string,
    presented: string | null,
    expected: string,
    ipcEnabled: boolean,
): WsDecision {
    if (pathname !== "/ws") {
        return "not-ws";
    }
    if (!ipcEnabled) {
        return "ipc-disabled";
    }
    return presented === expected ? "upgrade" : "forbidden";
}

/**
 * 起服务、开窗、接线，返回一个可以 `wait()` 的 App。
 *
 * 失败时抛错，且**不留下半启动状态**——本地服务会被关掉。理由是调用方拿到异常后
 * 唯一合理的动作是退出，而一个已经绑好的端口会让「重试一次」也失败。
 */
export async function createApp(opts: AppOptions): Promise<App> {
    if (!opts.html || typeof opts.html !== "string") {
        throw new Error("createApp: html is required (import it with { type: \"text\" })");
    }

    const token = crypto.randomUUID();
    const ipc = opts.service
        ? createIpcServer({
              service: opts.service,
              ...(opts.exposeStack === undefined ? {} : { exposeStack: opts.exposeStack }),
          })
        : null;

    const server = serveOnSafePort({
        fetch(req, srv) {
            return handle(req, srv);
        },
        websocket: {
            open(ws: unknown) {
                ipc?.attach(ws as { send(d: string): void });
            },
            message(ws: unknown, raw: string | Buffer) {
                void ipc?.handle(ws as { send(d: string): void }, raw);
            },
            close(ws: unknown) {
                ipc?.detach(ws as { send(d: string): void });
            },
        } as never,
    });

    async function handle(req: Request, srv: unknown): Promise<Response | undefined> {
        const url = new URL(req.url);

        // IPC 通道。校验必须在这里做——升级之后就没有机会拒绝了
        switch (decideWs(url.pathname, url.searchParams.get("t"), token, ipc !== null)) {
            case "ipc-disabled":
                return new Response("ipc not enabled", { status: 404 });
            case "forbidden":
                return new Response(null, { status: 403 });
            case "upgrade": {
                const upgrade = (srv as { upgrade(r: Request, o: unknown): boolean }).upgrade;
                if (upgrade.call(srv, req, { data: {} })) {
                    return undefined; // 已升级，不要再返回 Response
                }
                return new Response(null, { status: 400 });
            }
            default:
                break;
        }

        // 调用方的路由优先，能覆盖 `/`（自绘入口页、SPA fallback 都靠这条）
        const custom = await opts.routes?.(req);
        if (custom) {
            return custom;
        }

        // 页面脚本。给了 `page` 才有这一条；不给时该路径落到底部的 404，
        // 与引入本项之前的行为一致。
        if (opts.page !== undefined && url.pathname === PAGE_JS_PATH) {
            return new Response(opts.page, {
                headers: { "content-type": PAGE_JS_CONTENT_TYPE },
            });
        }

        if (url.pathname === "/") {
            return new Response(opts.html, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }

        return new Response("not found", { status: 404 });
    }

    // `Bun.serve` 的 `port` 类型是 `number | undefined`。`serveOnSafePort` 已经
    // 确认绑定成功，但这里不能顺手断言：一旦为 undefined，拼出来的 URL 会是
    // `http://127.0.0.1:undefined/?t=...`，而 `openShell` 会把它当合法 URL 交给
    // WebView2，表现为一个空白窗口——比抛错难查得多。
    const port = server.port;
    if (port === undefined) {
        server.stop(true);
        throw new Error("createApp: local server did not report a bound port");
    }
    const url = buildAppUrl(port, token);

    const shellOpts: ShellOptions = {
        url,
        title: opts.title ?? "bun-app-window",
        width: opts.width ?? 1000,
        height: opts.height ?? 680,
        flags: opts.flags ?? DEFAULT_APP_FLAGS,
        ...(opts.minWidth === undefined ? {} : { minWidth: opts.minWidth }),
        ...(opts.minHeight === undefined ? {} : { minHeight: opts.minHeight }),
        ...(opts.browserUi === undefined ? {} : { browserUi: opts.browserUi }),
        ...(opts.appName === undefined ? {} : { appName: opts.appName }),
        ...(opts.nativeLibPath === undefined ? {} : { nativeLibPath: opts.nativeLibPath }),
        ...(opts.embedded === undefined ? {} : { embedded: opts.embedded }),
    };

    let shell: Shell;
    try {
        shell = await openShell(shellOpts);
    } catch (err) {
        // 不留半启动状态：窗口没起来，端口也不该继续占着
        server.stop(true);
        throw err;
    }

    let stopped = false;

    // 窗口事件的唯一消费者。`keepAlive: true` 是 `wait()` 成立的前提：
    // unref 的定时器不撑事件循环，而「等一个永不兑现的 promise」也撑不住——
    // 宿主会在窗口还开着的时候直接退出。
    const events = attachEventPump(shell, { intervalMs: EVENT_POLL_MS, keepAlive: true });
    const closed = defer();
    events.on((e) => {
        if (e.type === EVENT_CLOSED) {
            closed.resolve();
        }
    });

    const app: App = {
        shell,
        events,
        port,
        url,
        token,
        ipc,
        debug: debugOf(shell),
        attachPlacement(file: string, opts2?: { debounceMs?: number }): PlacementStore {
            // 事件泵用骨架这一个：`shell.pollEvents()` 是消费式的，再起一个就分票。
            // 这里不给调用方传 `events` 的机会，正是这个方法存在的全部理由。
            return attachPlacementStore(shell, file, {
                events,
                ...(opts2?.debounceMs === undefined ? {} : { debounceMs: opts2.debounceMs }),
            });
        },
        async stop(): Promise<void> {
            if (stopped) {
                return;
            }
            stopped = true;
            shell.stop();
            // 等 `EVENT_CLOSED` 而不是轮询 `isAlive()`：CLOSED 由原生侧在 teardown
            // 全部做完、g_webview 已置空之后写进队列，它出现的时刻就等于「单例已释放」。
            // 超时上限保留，且超时后也 resolve 一次——否则 `wait()` 会永远挂着。
            //
            // 定时器必须可取消：`Promise.race` 只取先兑现的，**不取消输掉的那个**。
            // 早先这里写的是 `Bun.sleep(CLOSE_TIMEOUT_MS)`，正常关窗路径下它就变成一个
            // 没人等的、未 unref 的 5 秒定时器，把 Bun 的事件循环撑满——实测
            // `race returned @ 9ms` 之后进程到 5010 ms 才退出，真实关窗 5043 ms。
            // 不用 `Bun.sleep` + `AbortSignal`：Bun 当前版本不支持。
            let cancelTimeout: () => void = () => {};
            const timeout = new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
                cancelTimeout = () => clearTimeout(timer);
            });
            try {
                await Promise.race([closed.promise, timeout]);
            } finally {
                // 判据要落在「进程何时退出」，不是「stop() 何时返回」：
                // 摘掉这一行时 stop() 仍然 42 ms 就返回了，但进程要 5.9 s 才退。
                cancelTimeout();
            }
            closed.resolve();
            events.stop();
            server.stop(true);
        },
        async wait(): Promise<void> {
            if (stopped) {
                return;
            }
            await closed.promise;
        },
    };

    opts.onReady?.(app);
    return app;
}
