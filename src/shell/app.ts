/**
 * app.ts — 应用骨架：把「起服务 → 开窗 → 接线 → 等退出」收成一次调用
 *
 * ## 为什么需要它
 *
 * 用这个包做第一个应用时，真正要写的业务代码可能只有 30 行，但**宿主样板**是
 * 另外 180 行：挑安全端口、生成鉴权 token、处理 WebSocket 升级、把 HTML 当字符串
 * 吐出去、把 `createIpcServer` 接到 Bun 的 websocket 回调上、拿窗口 flags、
 * 处理 `openShell` 失败、轮询 `isAlive()` 等窗口关闭、按顺序 `stop()` 两次。
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
import { openShell, type Shell } from "./index";
import { serveOnSafePort } from "./port";
import { FLAG_CENTER, FLAG_RESIZABLE, type ShellOptions } from "./types";

/** 骨架起出来的东西。`shell` 是完整的内核对象，骨架只是帮它把周边接好 */
export type App = {
    /** 内核对象。标题、缩放、全屏、原生菜单、位置持久化都从这里拿 */
    readonly shell: Shell;
    /** 本地服务实际绑定的端口（已避开浏览器受限端口表） */
    readonly port: number;
    /** 页面 URL：带鉴权 token 的查询参数，直接交给 `openShell` 用的就是它 */
    readonly url: string;
    /** 页面 URL 里的 token。页面侧 `connect()` 默认从这里取 */
    readonly token: string;
    /** 给了 `service` 才有；否则为 null */
    readonly ipc: IpcServer | null;
    /**
     * 停止窗口与本地服务。
     *
     * 顺序是有意的：先 `shell.stop()`，再**轮询等窗口真的销毁**，最后才关服务。
     * 原生层是进程级单例，`shell_stop()` 只是投了一个 `WM_QUIT`，UI 线程真正退出
     * 约需 50 ms；抢在前面关服务或重新 start，会撞上「shell already started」
     * （详见 `pitfalls` 2.4g / 7.1）。
     *
     * 幂等：重复调用立即返回。
     */
    stop(): Promise<void>;
    /**
     * 等窗口被关闭（用户点 X，或调用了 `stop()`）。
     *
     * 宿主进程不会因为窗口没了就自动退出——它自己起的本地服务还在跑。所以
     * 「应用该结束了」的判据是 `isAlive()` 变假，不是任何信号。
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

/** 默认端口关掉时最多等多久。50 ms × 100 = 5 s，远大于实测的 50 ms */
const STOP_POLL_MS = 50;
const STOP_POLL_MAX = 100;

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

    const app: App = {
        shell,
        port,
        url,
        token,
        ipc,
        async stop(): Promise<void> {
            if (stopped) {
                return;
            }
            stopped = true;
            shell.stop();
            // 必须等窗口真的销毁：原生层是进程级单例，WM_QUIT 投出去不等于已退出
            for (let i = 0; i < STOP_POLL_MAX && shell.isAlive(); i++) {
                await Bun.sleep(STOP_POLL_MS);
            }
            server.stop(true);
        },
        async wait(): Promise<void> {
            while (!stopped && shell.isAlive()) {
                await Bun.sleep(STOP_POLL_MS);
            }
        },
    };

    opts.onReady?.(app);
    return app;
}
