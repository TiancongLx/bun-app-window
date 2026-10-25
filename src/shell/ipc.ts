/**
 * ipc.ts — 宿主与页面之间的类型化调用与事件通道
 *
 * 三条设计决定：
 *
 *   1. **不生成代码。** MyGo 用 Go 写宿主，生成 TypeScript 客户端，是因为
 *      Go 类型与 TS 类型是两套系统，必须造一座桥。这里宿主与前端**都是
 *      TypeScript**，共享一份 `type` 声明就够了——生成器只会多出一个
 *      「生成物与源不一致」的故障源，不带来任何类型信息。
 *      类型安全由泛型 `connect<Api>()` 在编译期保证，和生成代码等价。
 *
 *   2. **传输无关。** 服务端只认「能 send 的对端」，客户端只认 `Channel`。
 *      两侧核心逻辑都不碰 WebSocket，因此可以在无窗口环境下完整测试。
 *
 *   3. **不反射校验签名。** 运行时只按方法名分发，参数原样透传。
 *      `bun:ffi` 那条教训同样适用：声明对不对只能靠调用验证，
 *      假装能校验反而会给出错误的信心。
 */

/** 失败时回给调用方的错误形状。`stack` 仅在 `exposeStack` 开启时出现 */
export type IpcErrorPayload = {
    message: string;
    name?: string;
    stack?: string;
};

export type IpcRequestMessage = {
    t: "ipc:req";
    id: number;
    /** 方法名 */
    m: string;
    /** 参数数组。原样透传，不做序列化以外的处理 */
    a: unknown[];
};

export type IpcReplyMessage =
    { t: "ipc:res"; id: number; ok: true; r: unknown } | { t: "ipc:res"; id: number; ok: false; e: IpcErrorPayload };

export type IpcEventMessage = {
    t: "ipc:evt";
    /** 事件名 */
    e: string;
    /** 载荷。缺省为 null，保证字段始终存在 */
    p: unknown;
};

export type IpcMessage = IpcRequestMessage | IpcReplyMessage | IpcEventMessage;

/**
 * 服务方法的宽松约束。
 *
 * 用 `never[]` 而非 `any[]`：任何具体函数 `(name: string) => string` 都能赋给
 * `(...args: never[]) => unknown`（参数逆变，`never` 可赋给 `string`），
 * 但反过来调用时需要断言——这正是我们想要的：定义宽松，调用收窄由泛型负责。
 */
export type ServiceMethods = Record<string, (...args: never[]) => unknown>;

/** 服务端对「一个连接」的最小要求。Bun 的 `ServerWebSocket` 天然满足 */
export type IpcPeer = {
    send(data: string): void;
};

export type IpcServerOptions = {
    service: ServiceMethods;
    /** 错误里是否回传 stack。开发期有用，生产应保持关闭 */
    exposeStack?: boolean;
    /**
     * 服务表出现客户端保留名时报错。默认 `true`。
     *
     * 保留名的表现是：服务端注册成功，客户端调用时解析为客户端自身成员，
     * 请求不会发出，两端都不产生任何错误。默认终止启动的原因见 ADR 0020。
     *
     * 关闭此项仅应在服务表由外部输入动态生成、且已用别的手段校验时使用。
     */
    rejectReservedNames?: boolean;
};

/**
 * IPC 客户端自身占用的属性名。
 *
 * 客户端是一个 Proxy，这些名字在 `get` 陷阱中解析为客户端成员，不会派发为远程调用。
 * 服务表中同名的项因此永远不会被调用，而 `await client.close()` 也不会抛错
 * （`await undefined` 是合法表达式），调用方无法区分「执行完毕」与「未派发」。
 *
 * 这份清单与客户端代理的拦截分支必须一致。`tests/ipc.test.ts` 中有一条断言逐名
 * 验证「该名字不派发为远程调用」，两者分叉时该断言失败。
 */
export const RESERVED_CLIENT_KEYS = ["on", "off", "close", "connected", "pending", "then"] as const;

/** 广播事件的选项 */
export type EmitOptions = {
    /**
     * 保留最后一次载荷，在连接建立时向该连接回放一次。
     *
     * 用途是状态同步。宿主通常在 `createApp` 返回后立即广播一次窗口状态，而此刻
     * 页面仍在加载、WebSocket 尚未建立，广播投递给零个连接且不回放，页面据此
     * 获取的初始状态将永远为空。粘性事件使新连接在 `attach` 时立即获得当前值。
     *
     * 默认关闭。逐条通知类的事件若开启粘性，新连接会额外收到一条历史消息，
     * 与「只推变化」的预期不符。
     */
    sticky?: boolean;
};

export type IpcServer = {
    /** 处理一条来自连接的原始消息。非 IPC 消息会被静默忽略 */
    handle(peer: IpcPeer, raw: string | Buffer | Uint8Array): Promise<void>;
    /** 登记连接，`emit` 才会送到它。粘性事件在此同步回放 */
    attach(peer: IpcPeer): void;
    /** 注销连接。close 时必须调，否则 emit 会向死连接写入 */
    detach(peer: IpcPeer): void;
    /** 广播事件给所有已登记连接。返回实际投递数 */
    emit(event: string, payload?: unknown, options?: EmitOptions): number;
    /** 服务暴露的方法名（创建时的快照）。用于自检与文档 */
    readonly methods: readonly string[];
    /** 当前登记连接数 */
    readonly peers: number;
};

function isRequest(v: unknown): v is IpcRequestMessage {
    if (!v || typeof v !== "object") {
        return false;
    }
    const o = v as Record<string, unknown>;
    return o.t === "ipc:req" && typeof o.id === "number" && typeof o.m === "string" && Array.isArray(o.a);
}

/**
 * 建立 IPC 服务端。
 *
 * ```ts
 * const ipc = createIpcServer({
 *     service: {
 *         greet: (name: string) => `Hello ${name}`,
 *         pickFolder: () => shell.pickFolder(),
 *     },
 * });
 *
 * Bun.serve({
 *     websocket: {
 *         open: (ws) => ipc.attach(ws),
 *         message: (ws, raw) => ipc.handle(ws, raw),
 *         close: (ws) => ipc.detach(ws),
 *     },
 *     // ...
 * });
 * ```
 */
export function createIpcServer(opts: IpcServerOptions): IpcServer {
    const service = opts.service;
    const exposeStack = opts.exposeStack === true;
    const connected = new Set<IpcPeer>();
    // 创建时快照：之后往 service 上挂东西不会改变对外声明
    const methods = Object.keys(service);

    // 保留名冲突在创建时终止，而不是留到首次调用。
    // 该冲突的既有表现是「调用成功、返回 undefined、服务端未执行」，
    // 既无异常也无日志，只能靠阅读客户端实现才能定位（ADR 0020）。
    if (opts.rejectReservedNames !== false) {
        const conflicts = methods.filter((m) => (RESERVED_CLIENT_KEYS as readonly string[]).includes(m));
        if (conflicts.length > 0) {
            throw new Error(
                `IPC 服务表包含客户端保留名：${conflicts.join(", ")}。\n` +
                    `这些名字由 bun-app-window/ipc 的客户端自身占用，同名服务方法永远不会被调用，` +
                    `且调用方不会收到任何错误。请改用其他名字（例如 close 改为 winClose）。\n` +
                    `若服务表由外部输入生成且已另行校验，可传入 { rejectReservedNames: false } 关闭本检查。`,
            );
        }
    }

    /**
     * 粘性事件的最后一次载荷。
     *
     * 每个事件名只保留一条，不累计：粘性的语义是「当前值」，不是「历史」。
     */
    const stickyEvents = new Map<string, IpcEventMessage>();

    const send = (peer: IpcPeer, msg: IpcMessage): void => {
        try {
            peer.send(JSON.stringify(msg));
        } catch {
            // 对端已断开。它会在 close 回调里被 detach，这里不必额外处理
        }
    };

    const toPayload = (err: unknown): IpcErrorPayload => {
        const e = err instanceof Error ? err : new Error(String(err));
        const payload: IpcErrorPayload = { message: e.message };
        if (e.name && e.name !== "Error") {
            payload.name = e.name;
        }
        if (exposeStack && e.stack) {
            payload.stack = e.stack;
        }
        return payload;
    };

    return {
        async handle(peer, raw): Promise<void> {
            const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);

            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                // 不是 JSON：这条通道只吃 JSON，别的消息归应用自己处理
                return;
            }

            if (!isRequest(parsed)) {
                return;
            }

            // hasOwnProperty 而非 `service[m]` 直接取：否则 "constructor" /
            // "__proto__" / "toString" 这类名字会命中原型链上的函数，
            // 等于把一个未知形状的东西当服务方法调用。
            const fn = Object.prototype.hasOwnProperty.call(service, parsed.m) ? service[parsed.m] : undefined;

            if (!fn) {
                send(peer, {
                    t: "ipc:res",
                    id: parsed.id,
                    ok: false,
                    e: { message: `unknown method: ${parsed.m}` },
                });
                return;
            }

            try {
                const result = await fn(...(parsed.a as never[]));
                // JSON 里 undefined 会被省略成一个缺 r 字段的回复，显式归一成 null
                send(peer, { t: "ipc:res", id: parsed.id, ok: true, r: result ?? null });
            } catch (err) {
                send(peer, { t: "ipc:res", id: parsed.id, ok: false, e: toPayload(err) });
            }
        },

        attach(peer): void {
            connected.add(peer);
            // 粘性事件在登记后同步回放：`attach` 返回时，新连接已收到全部当前值。
            // 不引入定时器，避免「回放尚未到达」这一中间态。
            for (const msg of stickyEvents.values()) {
                try {
                    peer.send(JSON.stringify(msg));
                } catch {
                    // 与 emit 一致：写入失败不中断其余回放
                }
            }
        },

        detach(peer): void {
            connected.delete(peer);
        },

        emit(event, payload, options): number {
            const msg: IpcEventMessage = { t: "ipc:evt", e: event, p: payload ?? null };
            if (options?.sticky === true) {
                // 同名事件覆盖上一次：粘性表示「当前值」，不是历史队列
                stickyEvents.set(event, msg);
            }
            const body = JSON.stringify(msg);
            let delivered = 0;
            for (const peer of connected) {
                try {
                    peer.send(body);
                    delivered++;
                } catch {
                    // 死连接不计入
                }
            }
            return delivered;
        },

        get methods(): readonly string[] {
            return methods;
        },

        get peers(): number {
            return connected.size;
        },
    };
}

/**
 * 客户端的最小传输面。
 *
 * 只有四个动作——发一条、关掉、收消息、收关闭。测试里换成一个内存实现就能
 * 完整覆盖客户端的 id 分配、pending 表、超时与错误传播，不需要起真服务。
 */
export type Channel = {
    send(data: string): void;
    close(): void;
    /** 注册消息回调。只调一次；重复调用以最后一次为准 */
    onMessage(fn: (data: string) => void): void;
    /** 通道关闭（对端断开或本地 close）时触发 */
    onClose(fn: () => void): void;
};

/** 把方法表映射成「返回 Promise 的同名方法」 */
export type ClientMethods<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

export type IpcClient<T, E extends Record<string, unknown> = Record<string, never>> = ClientMethods<T> & {
    /** 订阅宿主推送的事件。返回取消订阅函数 */
    on<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): () => void;
    /** 取消订阅 */
    off(event: string, handler: (payload: unknown) => void): void;
    /** 关闭通道。未完成的调用会被 reject */
    close(): void;
    /** 通道当前是否可用 */
    readonly connected: boolean;
    /** 尚未收到回复的调用数 */
    readonly pending: number;
};

export type ConnectOptions = {
    /** 已建立的通道。给了就不再自己连 */
    channel?: Channel;
    /** 未给 channel 时的连接地址 */
    url?: string;
    /**
     * 鉴权 token。缺省从页面 URL 的 `?t=` 读取——
     * 与 `src/host.ts` 里本地服务的约定一致。
     */
    token?: string;
    /** 单次调用超时，毫秒。0 表示不超时。默认 30000 */
    timeoutMs?: number;
};

type NativeSocket = {
    send(data: string): void;
    close(): void;
    readonly readyState: number;
    addEventListener(type: string, listener: (event: unknown) => void): void;
};

/**
 * 把一条 WebSocket 包成 `Channel`。
 *
 * open 之前到达的消息会先缓冲，`onMessage` 注册时补发——否则
 * `await webSocketChannel()` 与 `client.onMessage()` 之间那条消息会丢。
 */
export function webSocketChannel(url: string): Promise<Channel> {
    const Ctor = (globalThis as { WebSocket?: new (u: string) => NativeSocket }).WebSocket;
    if (!Ctor) {
        throw new Error("webSocketChannel: this runtime has no global WebSocket");
    }

    const socket = new Ctor(url);
    const buffer: string[] = [];
    let sink: ((data: string) => void) | null = null;
    let onClosed: (() => void) | null = null;

    socket.addEventListener("message", (ev) => {
        const data = (ev as { data?: unknown }).data;
        if (typeof data !== "string") {
            return;
        }
        if (sink) {
            sink(data);
        } else {
            buffer.push(data);
        }
    });

    socket.addEventListener("close", () => {
        if (onClosed) {
            onClosed();
        }
    });

    return new Promise<Channel>((resolve, reject) => {
        let settled = false;

        socket.addEventListener("error", () => {
            if (!settled) {
                settled = true;
                reject(new Error(`webSocketChannel: connection failed (${url})`));
            }
        });

        socket.addEventListener("open", () => {
            if (settled) {
                return;
            }
            settled = true;
            resolve({
                send: (data) => socket.send(data),
                close: () => socket.close(),
                onMessage: (fn) => {
                    sink = fn;
                    for (const pending of buffer.splice(0)) {
                        fn(pending);
                    }
                },
                onClose: (fn) => {
                    onClosed = fn;
                },
            });
        });
    });
}

function toError(payload: unknown): Error {
    if (payload && typeof payload === "object") {
        const o = payload as Record<string, unknown>;
        const message = typeof o.message === "string" ? o.message : "ipc call failed";
        const err = new Error(message);
        if (typeof o.name === "string" && o.name) {
            err.name = o.name;
        }
        if (typeof o.stack === "string" && o.stack) {
            err.stack = o.stack;
        }
        return err;
    }
    return new Error("ipc call failed");
}

type Pending = {
    resolve(value: unknown): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout> | null;
};

/**
 * 连接宿主侧的 IPC 服务。
 *
 * ```ts
 * // api.ts —— 宿主与页面共享这一份声明，不需要任何生成步骤
 * export type Api = {
 *     greet(name: string): string;
 *     pickFolder(title?: string): Promise<string | null>;
 * };
 * export type Events = {
 *     windowState: { width: number; height: number; maximized: boolean };
 * };
 *
 * // 页面
 * const api = await connect<Api, Events>();
 * const hello = await api.greet("Ada");   // string
 * api.on("windowState", (s) => console.log(s.maximized));
 * ```
 */
export async function connect<T, E extends Record<string, unknown> = Record<string, never>>(
    opts: ConnectOptions = {},
): Promise<IpcClient<T, E>> {
    const timeoutMs = opts.timeoutMs ?? 30000;

    const channel = opts.channel ?? (await webSocketChannel(opts.url ?? deriveUrl(opts.token)));

    const pending = new Map<number, Pending>();
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    let nextId = 1;
    let open = true;

    const failAll = (message: string): void => {
        for (const entry of pending.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            entry.reject(new Error(message));
        }
        pending.clear();
    };

    const call = (method: string, args: unknown[]): Promise<unknown> => {
        if (!open) {
            return Promise.reject(new Error(`ipc channel closed: ${method}`));
        }

        const id = nextId++;
        nextId = nextId > Number.MAX_SAFE_INTEGER ? 1 : nextId;

        const promise = new Promise<unknown>((resolve, reject) => {
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          // 超时后从表里摘掉，迟到的回复会被当成未知 id 丢弃
                          pending.delete(id);
                          reject(new Error(`ipc timeout after ${timeoutMs}ms: ${method}`));
                      }, timeoutMs)
                    : null;
            pending.set(id, { resolve, reject, timer });
        });

        try {
            channel.send(JSON.stringify({ t: "ipc:req", id, m: method, a: args }));
        } catch (err) {
            const entry = pending.get(id);
            pending.delete(id);
            if (entry?.timer) {
                clearTimeout(entry.timer);
            }
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }

        return promise;
    };

    channel.onMessage((text) => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            return;
        }
        if (!parsed || typeof parsed !== "object") {
            return;
        }
        const o = parsed as Record<string, unknown>;

        if (o.t === "ipc:res" && typeof o.id === "number") {
            const entry = pending.get(o.id);
            if (!entry) {
                return;
            }
            pending.delete(o.id);
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            if (o.ok === true) {
                entry.resolve(o.r);
            } else {
                entry.reject(toError(o.e));
            }
            return;
        }

        if (o.t === "ipc:evt" && typeof o.e === "string") {
            const handlers = listeners.get(o.e);
            if (!handlers) {
                return;
            }
            // 复制一份：处理器里调用 off() 不应打乱本次遍历
            for (const handler of [...handlers]) {
                try {
                    handler(o.p);
                } catch {
                    // 单个处理器抛错不该打断整条事件通道
                }
            }
        }
    });

    channel.onClose(() => {
        open = false;
        failAll("ipc channel closed");
    });

    const on = (event: string, handler: (payload: unknown) => void): (() => void) => {
        let set = listeners.get(event);
        if (!set) {
            set = new Set();
            listeners.set(event, set);
        }
        set.add(handler);
        return () => {
            set.delete(handler);
        };
    };

    const off = (event: string, handler: (payload: unknown) => void): void => {
        listeners.get(event)?.delete(handler);
    };

    const close = (): void => {
        if (!open) {
            return;
        }
        open = false;
        try {
            channel.close();
        } catch {
            // 已经关掉的情况忽略
        }
        failAll("ipc client closed");
    };

    // 用 Proxy 按方法名动态派发——这样客户端不需要知道任何方法清单，
    // 方法集合完全由调用方传入的泛型 `T` 在编译期约束。
    const proxy = new Proxy({} as Record<string | symbol, unknown>, {
        get(_target, prop) {
            if (prop === "on") {
                return on;
            }
            if (prop === "off") {
                return off;
            }
            if (prop === "close") {
                return close;
            }
            if (prop === "connected") {
                return open;
            }
            if (prop === "pending") {
                return pending.size;
            }
            // `then` 必须返回 undefined：否则 `await client` 会把它当 thenable
            // 无限等待下去。Symbol 同理（Symbol.toPrimitive 等）
            if (prop === "then" || typeof prop === "symbol") {
                return undefined;
            }
            return (...args: unknown[]) => call(prop, args);
        },
    });

    return proxy as unknown as IpcClient<T, E>;
}

/** 从页面 URL 推导 ws 地址。与服务端 `src/host.ts` 的约定一致 */
function deriveUrl(token?: string): string {
    const loc = (
        globalThis as {
            location?: { search: string; protocol: string; host: string };
        }
    ).location;

    if (!loc) {
        throw new Error("connect: no url given and no global location to derive one from");
    }

    const t = token ?? new URLSearchParams(loc.search).get("t") ?? "";
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc.host}/ws?t=${encodeURIComponent(t)}`;
}
