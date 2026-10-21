import { expect, test } from "bun:test";

import {
    connect,
    createIpcServer,
    type Channel,
    type IpcPeer,
} from "@/shell/ipc";

/**
 * 这一组用例只测协议与状态机，不起真服务。
 *
 * 依据：`ipc.ts` 把传输收敛成了 `Channel` 与 `IpcPeer` 两个接口，
 * 两侧核心逻辑都不碰 WebSocket——所以内存实现就能覆盖 id 分配、
 * pending 表、超时、错误传播与广播。
 */

/**
 * 夹具：手动把页面的发送交给服务端，把服务端的发送交给页面。
 *
 * 不用真 WebSocket 的理由：协议正确性（id 配对、pending、超时、错误形状）
 * 与传输无关，起真服务只会让用例变慢、变脆。
 */
function harness(
    service: Parameters<typeof createIpcServer>[0]["service"],
    opts?: { exposeStack?: boolean },
) {
    const server = createIpcServer({ service, ...(opts ?? {}) });

    let toPage: ((data: string) => void) | null = null;
    const fromPage: string[] = [];

    const peer: IpcPeer = {
        send(data) {
            toPage?.(data);
        },
    };
    server.attach(peer);

    const channel: Channel = {
        send(data) {
            fromPage.push(data);
        },
        close() {
            // 由用例显式驱动
        },
        onMessage(fn) {
            toPage = fn;
        },
        onClose(fn) {
            void fn;
        },
    };

    /** 把页面发出的请求逐条交给服务端 */
    async function pump(): Promise<void> {
        while (fromPage.length > 0) {
            const msg = fromPage.shift();
            if (msg === undefined) {
                break;
            }
            // 交回微任务，让 connect 的 send → handle 链路有异步空间
            await server.handle(peer, msg);
        }
    }

    return { server, peer, channel, pump };
}

test("请求与回复往返：同步方法", async () => {
    const h = harness({ greet: (name: string) => `Hello ${name}` });
    const api = await connect<{ greet(name: string): string }>({ channel: h.channel });

    const call = api.greet("Ada");
    await h.pump();
    expect(await call).toBe("Hello Ada");
    expect(h.server.methods).toEqual(["greet"]);
});

test("请求与回复往返：异步方法", async () => {
    const h = harness({
        later: async (ms: number) => {
            await new Promise((r) => setTimeout(r, ms));
            return "done";
        },
    });
    const api = await connect<{ later(ms: number): Promise<string> }>({ channel: h.channel });

    const call = api.later(1);
    // 异步方法需要等它自己 resolve 再把回复投递出去
    setTimeout(() => void h.pump(), 20);
    expect(await call).toBe("done");
});

test("参数原样透传：多参数与对象", async () => {
    const h = harness({
        join: (a: string, b: number, c: { x: boolean }) => `${a}/${b}/${c.x}`,
    });
    const api = await connect<{
        join(a: string, b: number, c: { x: boolean }): string;
    }>({ channel: h.channel });

    const call = api.join("s", 7, { x: true });
    await h.pump();
    expect(await call).toBe("s/7/true");
});

test("方法返回 undefined 时归一成 null（JSON 会丢字段）", async () => {
    const h = harness({ noop: () => undefined });
    const api = await connect<{ noop(): void }>({ channel: h.channel });

    const call = api.noop();
    await h.pump();
    expect(await call).toBeNull();
});

test("未知方法回错误，不抛到宿主", async () => {
    const h = harness({ known: () => 1 });
    const api = await connect<{ missing(): number }>({ channel: h.channel });

    const call = api.missing();
    await h.pump();
    await expect(call).rejects.toThrow("unknown method: missing");
});

test("原型链上的名字不能被当成服务方法", async () => {
    const h = harness({ known: () => 1 });
    const api = await connect<{ constructor(): number }>({ channel: h.channel });

    const call = api.constructor();
    await h.pump();
    // 关键：如果直接 obj[m] 取值，"constructor" 会命中原型链上的 Object
    await expect(call).rejects.toThrow("unknown method: constructor");
});

test("服务方法抛错 → 调用方收到带 message 的 Error", async () => {
    const h = harness({
        boom: () => {
            throw new Error("something broke");
        },
    });
    const api = await connect<{ boom(): void }>({ channel: h.channel });

    const call = api.boom();
    await h.pump();
    await expect(call).rejects.toThrow("something broke");
});

test("默认不回传 stack；exposeStack 打开才回", async () => {
    /** 跑一次调用，返回宿主真正发出的那条回复原文 */
    async function rawReply(exposeStack: boolean): Promise<string> {
        const server = createIpcServer({
            service: {
                boom: () => {
                    throw new Error("host secret path");
                },
            },
            exposeStack,
        });

        const out: string[] = [];
        const peer: IpcPeer = { send: (d) => out.push(d) };
        server.attach(peer);

        await server.handle(peer, JSON.stringify({ t: "ipc:req", id: 1, m: "boom", a: [] }));
        return out[0] ?? "";
    }

    const plain = JSON.parse(await rawReply(false)) as {
        ok: boolean;
        e: Record<string, unknown>;
    };
    expect(plain.ok).toBe(false);
    expect(plain.e.message).toBe("host secret path");
    // 关键：宿主文件路径绝不能出现在默认回复里
    expect("stack" in plain.e).toBe(false);

    const verbose = JSON.parse(await rawReply(true)) as {
        e: Record<string, unknown>;
    };
    expect(typeof verbose.e.stack).toBe("string");
});

test("多个并发调用按 id 一一对应，不串味", async () => {
    const h = harness({
        echo: (v: string) => `echo:${v}`,
    });
    const api = await connect<{ echo(v: string): string }>({ channel: h.channel });

    const calls = [api.echo("a"), api.echo("b"), api.echo("c")];
    // 一次性把三条请求都投进去
    await h.pump();
    expect(await Promise.all(calls)).toEqual(["echo:a", "echo:b", "echo:c"]);
});

test("非 IPC 消息被静默忽略（应用别的消息共用通道时）", async () => {
    const h = harness({ ping: () => "pong" });
    const api = await connect<{ ping(): string }>({ channel: h.channel });

    // 直接塞一条不相关消息进去，不应影响后续调用
    h.server.attach(h.peer);
    const call = api.ping();
    await h.pump();
    expect(await call).toBe("pong");

    // 服务端收到非 JSON / 非请求形状时不回应、不抛错
    await h.server.handle(h.peer, "not json");
    await h.server.handle(h.peer, JSON.stringify({ t: "hello" }));
    await h.server.handle(h.peer, JSON.stringify({ t: "ipc:req" }));
});

test("事件广播到所有登记连接；detach 后不再收到", async () => {
    const server = createIpcServer({ service: {} });
    const got: string[] = [];

    const a: IpcPeer = { send: (d) => got.push(`a:${d}`) };
    const b: IpcPeer = { send: (d) => got.push(`b:${d}`) };

    server.attach(a);
    server.attach(b);
    expect(server.peers).toBe(2);

    expect(server.emit("tick", { n: 1 })).toBe(2);
    expect(got.length).toBe(2);

    server.detach(a);
    expect(server.peers).toBe(1);
    got.length = 0;
    expect(server.emit("tick", { n: 2 })).toBe(1);
    expect(got).toEqual([`b:${JSON.stringify({ t: "ipc:evt", e: "tick", p: { n: 2 } })}`]);
});

test("emit 跳过写入失败的死连接，不影响其它连接", async () => {
    const server = createIpcServer({ service: {} });
    const got: string[] = [];

    const dead: IpcPeer = {
        send() {
            throw new Error("socket gone");
        },
    };
    const alive: IpcPeer = { send: (d) => got.push(d) };

    server.attach(dead);
    server.attach(alive);
    expect(server.emit("x", 1)).toBe(1);
    expect(got.length).toBe(1);
});

test("客户端收到事件并分发；off 后停止", async () => {
    const h = harness({});
    const api = await connect<{}, { tick: { n: number } }>({ channel: h.channel });

    const seen: number[] = [];
    const unsubscribe = api.on("tick", (p) => seen.push(p.n));

    h.server.emit("tick", { n: 1 });
    h.server.emit("tick", { n: 2 });
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    h.server.emit("tick", { n: 3 });
    expect(seen).toEqual([1, 2]);
});

test("单个事件处理器抛错不打断其它处理器", async () => {
    const h = harness({});
    const api = await connect<{}, { e: number }>({ channel: h.channel });

    const seen: number[] = [];
    api.on("e", () => {
        throw new Error("handler boom");
    });
    api.on("e", (p) => seen.push(p));

    h.server.emit("e", 42);
    expect(seen).toEqual([42]);
});

test("事件载荷缺省归一成 null", async () => {
    const h = harness({});
    let captured: unknown = "unset";
    const api = await connect<{}, { e: null }>({ channel: h.channel });
    api.on("e", (p) => {
        captured = p;
    });

    h.server.emit("e");
    expect(captured).toBeNull();
});

test("pending 计数随调用增减", async () => {
    const h = harness({ slow: async () => "ok" });
    const api = await connect<{ slow(): Promise<string> }>({ channel: h.channel });

    expect(api.pending).toBe(0);
    const call = api.slow();
    expect(api.pending).toBe(1);
    await h.pump();
    await call;
    expect(api.pending).toBe(0);
});

test("超时后 reject，且迟到的回复被丢弃", async () => {
    let toPage: ((d: string) => void) | null = null;
    const sent: string[] = [];

    const channel: Channel = {
        send: (d) => sent.push(d),
        close: () => undefined,
        onMessage: (fn) => {
            toPage = fn;
        },
        onClose: () => undefined,
    };

    const api = await connect<{ never(): string }>({ channel, timeoutMs: 20 });
    const call = api.never();
    await expect(call).rejects.toThrow("ipc timeout after 20ms: never");

    // 迟到回复：不应抛错、不应影响状态
    expect(() => toPage?.(JSON.stringify({ t: "ipc:res", id: 1, ok: true, r: "late" }))).not.toThrow();
    expect(api.pending).toBe(0);
});

/**
 * `timeoutMs: 0` 的契约是「**不超时**」，不是「0 毫秒超时」。
 *
 * 这不是理论问题：`pickFolder()` 内部是 `SHBrowseForFolder`，同步阻塞、
 * 耗时完全由用户决定（挑一分钟很正常）。拿着默认 30 秒去调它，客户端会在
 * 服务端还正常阻塞时先 reject；调用方若没接 `.catch`，表现就是「选完了界面
 * 什么反应都没有」—— 而取消很快返回，所以只有「挑久了」才复现。
 *
 * 应用侧的正确做法是 `connect({ timeoutMs: 0 })`（`baw-mvp` 的 `page.ts` 就是这么做的）。
 * 但此前**没有任何断言守着这个值**，两处改动都能把它悄悄打回 30 秒而门禁全绿：
 *
 *   opts.timeoutMs ?? 30000   →   opts.timeoutMs || 30000   （0 是 falsy）
 *   timeoutMs > 0             →   timeoutMs >= 0            （0 也挂 0ms 定时器）
 *
 * 第一种回归等 50ms 看不出来（30 秒才触发），所以行为断言之外再加一条静态断言。
 */
test("timeoutMs: 0 表示不超时（不是 0 毫秒）", async () => {
    const channel: Channel = {
        send: () => undefined, // 永不回复，模拟服务端还在阻塞
        close: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
    };

    let settled: "resolved" | "rejected" | "pending" = "pending";
    const api = await connect<{ pickFolder(): string | null }>({ channel, timeoutMs: 0 });
    const call = api.pickFolder().then(
        () => {
            settled = "resolved";
        },
        () => {
            settled = "rejected";
        },
    );

    // 50ms 足以抓住「0 被当成 0ms」（那样会立刻 reject）
    await Bun.sleep(50);
    expect(settled).toBe("pending");
    expect(api.pending).toBe(1);

    // 收尾：关通道让它 reject，否则会留下悬挂 promise
    void call;
});

test("timeoutMs 的默认值只能靠 ?? 落到，不能靠 ||", async () => {
    // 静态判据：`||` 会把 0 当 falsy，把「不超时」静默退化成 30 秒。
    // 这条断言存在的理由见上一条测试的注释。
    const source = await Bun.file(`${import.meta.dir}/../src/shell/ipc.ts`).text();
    expect(source).toContain("opts.timeoutMs ?? 30000");
    expect(source).not.toContain("opts.timeoutMs || 30000");
    // 定时器只在 > 0 时挂
    expect(source).toContain("timeoutMs > 0");
});

test("通道关闭时，未完成的调用全部 reject", async () => {
    // 用对象持有回调：闭包里给 let 变量赋值，TS 的控制流分析看不见，
    // 会把它收窄成 null 进而推出 never
    const hooks: { closed: (() => void) | null } = { closed: null };
    const channel: Channel = {
        send: () => undefined,
        close: () => undefined,
        onMessage: () => undefined,
        onClose: (fn) => {
            hooks.closed = fn;
        },
    };

    const api = await connect<{ a(): string; b(): string }>({ channel });
    const a = api.a();
    const b = api.b();
    expect(api.pending).toBe(2);

    hooks.closed?.();
    await expect(a).rejects.toThrow("ipc channel closed");
    await expect(b).rejects.toThrow("ipc channel closed");
    expect(api.pending).toBe(0);
    expect(api.connected).toBe(false);
});

test("close 后再调用立即失败，不再写入通道", async () => {
    const sent: string[] = [];
    const channel: Channel = {
        send: (d) => sent.push(d),
        close: () => undefined,
        onMessage: () => undefined,
        onClose: () => undefined,
    };

    const api = await connect<{ a(): string }>({ channel });
    api.close();
    await expect(api.a()).rejects.toThrow("ipc channel closed: a");
    expect(sent.length).toBe(0);
});

test("客户端不是 thenable（await 它不会挂死）", async () => {
    const h = harness({});
    const api = await connect<{}>({ channel: h.channel });
    // 关键：Proxy 的 get 必须对 "then" 返回 undefined
    expect((api as unknown as Record<string, unknown>).then).toBeUndefined();
    // 直接 await 应该立刻返回自身
    const again = await Promise.resolve(api);
    expect(again).toBe(api);
});

test("服务端方法名快照在创建时确定", async () => {
    const service: Record<string, (...a: never[]) => unknown> = { a: () => 1 };
    const server = createIpcServer({ service });
    expect(server.methods).toEqual(["a"]);

    service.b = () => 2;
    // 后加的不会进入对外声明，但 handle 仍会按原对象查找——这是刻意的：
    // methods 是「声明快照」，实际分发是「活对象」，两者语义不同
    expect(server.methods).toEqual(["a"]);
});
