import { describe, expect, test } from "bun:test";

import { PAGE_JS_PATH, assertPageWiring, injectPageErrorRelay, parsePageError } from "@/shell/app";
import { RESERVED_CLIENT_KEYS, connect, createIpcServer, type Channel } from "@/shell/ipc";

/**
 * ADR 0020 的验收断言。
 *
 * 四类失效的共同形态是「调用方动作合法、系统不可用、没有任何一方观察到」。
 * 每一条判据都配一个反向样本：能红的判据才是判据，恒真的判据冒充验收。
 */

// ---- 一、保留名冲突 ---------------------------------------------------------

describe("createIpcServer：服务表保留名校验", () => {
    test("服务表含 close 时创建即抛错", () => {
        expect(() => createIpcServer({ service: { greet: () => "hi", close: () => "x" } })).toThrow(/保留名/);
    });

    test("错误信息指出冲突的名字，而不是只说不合法", () => {
        try {
            createIpcServer({ service: { on: () => 1, off: () => 2 } });
            throw new Error("应当抛错");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            expect(message).toContain("on");
            expect(message).toContain("off");
        }
    });

    test("**反向**：不含保留名的服务表照常创建", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi", winClose: () => "x" } });
        expect(ipc.methods).toEqual(["greet", "winClose"]);
    });

    test("rejectReservedNames: false 时关闭校验", () => {
        const ipc = createIpcServer({
            service: { close: () => "x" },
            rejectReservedNames: false,
        });
        expect(ipc.methods).toEqual(["close"]);
    });
});

describe("RESERVED_CLIENT_KEYS 与客户端拦截分支一致", () => {
    /**
     * 两份清单分叉时，服务端校验会放过一个实际不可调用的名字。
     * 这里逐名验证「该名字解析为客户端成员，不派发为远程调用」，
     * 用发送记录作为判据：一旦被派发，通道上就会出现 ipc:req。
     */
    test("清单中每个名字都不会产生远程请求", async () => {
        const sent: string[] = [];
        const channel: Channel = {
            send: (data) => sent.push(data),
            close: () => {},
            onMessage: () => {},
            onClose: () => {},
        };
        const client = await connect<Record<string, () => unknown>>({ channel });

        for (const key of RESERVED_CLIENT_KEYS) {
            const before = sent.length;
            // `then` 返回 undefined，其余返回客户端成员；两者都不应写成请求
            const value = (client as unknown as Record<string, unknown>)[key];
            if (typeof value === "function") {
                (value as () => unknown)();
            }
            const after = sent.length;
            expect({ key, dispatched: after - before }).toEqual({ key, dispatched: 0 });
        }
    });

    test("**反向**：普通方法名会派发为请求", async () => {
        const sent: string[] = [];
        const channel: Channel = {
            send: (data) => sent.push(data),
            close: () => {},
            onMessage: () => {},
            onClose: () => {},
        };
        const client = await connect<{ greet(): Promise<string> }>({ channel });
        void client.greet();
        expect(sent.length).toBe(1);
        expect(sent[0]).toContain('"m":"greet"');
    });
});

// ---- 二、粘性事件 -----------------------------------------------------------

/** 收集服务端发往某个对端的原始消息 */
function recordingPeer(): { peer: { send(d: string): void }; inbox: string[] } {
    const inbox: string[] = [];
    return { peer: { send: (d) => inbox.push(d) }, inbox };
}

describe("粘性事件", () => {
    test("连接建立时回放最后一次载荷", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("state", { w: 100 }, { sticky: true });

        const { peer, inbox } = recordingPeer();
        ipc.attach(peer);

        expect(inbox).toHaveLength(1);
        expect(JSON.parse(inbox[0]!)).toEqual({ t: "ipc:evt", e: "state", p: { w: 100 } });
    });

    test("**反向**：非粘性事件不回放", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("state", { w: 100 });

        const { peer, inbox } = recordingPeer();
        ipc.attach(peer);

        expect(inbox).toHaveLength(0);
    });

    test("同名事件只保留最后一次，不累计", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("state", { n: 1 }, { sticky: true });
        ipc.emit("state", { n: 2 }, { sticky: true });
        ipc.emit("state", { n: 3 }, { sticky: true });

        const { peer, inbox } = recordingPeer();
        ipc.attach(peer);

        expect(inbox).toHaveLength(1);
        expect(JSON.parse(inbox[0]!).p).toEqual({ n: 3 });
    });

    test("多个粘性事件按首次登记顺序回放", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("a", 1, { sticky: true });
        ipc.emit("b", 2, { sticky: true });

        const { peer, inbox } = recordingPeer();
        ipc.attach(peer);

        expect(inbox.map((s) => JSON.parse(s).e)).toEqual(["a", "b"]);
    });

    test("非粘性事件不影响已登记的粘性状态", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("state", { n: 1 }, { sticky: true });
        ipc.emit("state", { n: 2 });

        const { peer, inbox } = recordingPeer();
        ipc.attach(peer);

        expect(JSON.parse(inbox[0]!).p).toEqual({ n: 1 });
    });

    test("回放对每个新连接各执行一次，互不影响", () => {
        const ipc = createIpcServer({ service: { greet: () => "hi" } });
        ipc.emit("state", { n: 1 }, { sticky: true });

        const first = recordingPeer();
        const second = recordingPeer();
        ipc.attach(first.peer);
        ipc.attach(second.peer);

        expect(first.inbox).toHaveLength(1);
        expect(second.inbox).toHaveLength(1);
    });
});

// ---- 三、html 与 page 的一致性 ----------------------------------------------

describe("assertPageWiring", () => {
    const withRef = `<html><head><script type="module" src="${PAGE_JS_PATH}"></script></head></html>`;
    const withoutRef = `<html><head></head><body></body></html>`;

    test("给了 page 但 html 未引用 → 抛错", () => {
        expect(() => assertPageWiring(withoutRef, "code")).toThrow(/未引用/);
    });

    test("html 引用了但未给 page → 抛错", () => {
        expect(() => assertPageWiring(withRef, undefined)).toThrow(/未提供 page/);
    });

    test("**反向**：两者都有且写法正确 → 通过", () => {
        expect(() => assertPageWiring(withRef, "code")).not.toThrow();
    });

    test("**反向**：两者都没有 → 通过", () => {
        expect(() => assertPageWiring(withoutRef, undefined)).not.toThrow();
    });

    test("引用存在但缺少 type=module → 只警告，不阻断", () => {
        // 捕获 console.warn：判据是「产生了警告」且「没有抛错」
        const original = console.warn;
        const warned: string[] = [];
        console.warn = (msg?: unknown) => {
            warned.push(String(msg));
        };
        try {
            expect(() => assertPageWiring(`<script src="${PAGE_JS_PATH}"></script>`, "code")).not.toThrow();
        } finally {
            console.warn = original;
        }
        expect(warned.join("\n")).toContain('type="module"');
    });

    test("**反向**：写法正确时不产生警告", () => {
        const original = console.warn;
        const warned: string[] = [];
        console.warn = (msg?: unknown) => {
            warned.push(String(msg));
        };
        try {
            assertPageWiring(withRef, "code");
        } finally {
            console.warn = original;
        }
        expect(warned).toEqual([]);
    });
});

// ---- 四、页面异常回传 -------------------------------------------------------

describe("injectPageErrorRelay", () => {
    test("脚本插入在 <head> 之后，早于页面自身的任何脚本", () => {
        const html = `<html><head><script src="/page.js"></script></head><body></body></html>`;
        const out = injectPageErrorRelay(html);
        expect(out.indexOf('addEventListener("error"')).toBeLessThan(out.indexOf("/page.js"));
    });

    test("**反向**：没有 <head> 时退到 <html> 之后", () => {
        const out = injectPageErrorRelay(`<html><body></body></html>`);
        expect(out.startsWith("<html>")).toBe(true);
        expect(out).toContain("unhandledrejection");
    });

    test("**反向**：既无 head 也无 html 时置于最前", () => {
        const out = injectPageErrorRelay(`<div>hi</div>`);
        expect(out.startsWith("<script>")).toBe(true);
    });

    test("注入不改变原有内容", () => {
        const html = `<html><head></head><body>原文</body></html>`;
        const out = injectPageErrorRelay(html);
        expect(out).toContain("<body>原文</body>");
        expect(out.replace(/<script>[\s\S]*?<\/script>/, "")).toBe(html);
    });

    test("注入的脚本是普通脚本而非模块 —— 模块的执行时机晚于解析", () => {
        const out = injectPageErrorRelay(`<html><head></head></html>`);
        expect(out).toContain("<script>");
        expect(out).not.toContain(`<script type="module">`);
    });
});

describe("parsePageError", () => {
    test("完整载荷原样归一", () => {
        const got = parsePageError({
            kind: "error",
            message: "boom",
            source: "http://x/page.js",
            line: 3,
            column: 7,
            stack: "at ...",
        });
        expect(got).toEqual({
            kind: "error",
            message: "boom",
            source: "http://x/page.js",
            line: 3,
            column: 7,
            stack: "at ...",
        });
    });

    test("kind 缺失时归为 error", () => {
        expect(parsePageError({ message: "x" })?.kind).toBe("error");
    });

    test("kind 为 unhandledrejection 时保留", () => {
        expect(parsePageError({ kind: "unhandledrejection", message: "x" })?.kind).toBe("unhandledrejection");
    });

    test("**反向**：message 缺失时给固定占位，不返回空串", () => {
        const got = parsePageError({ kind: "error" });
        expect(got?.message).toBe("(no message)");
        expect(got?.message.length).toBeGreaterThan(0);
    });

    test("**反向**：类型不符的字段被丢弃而不是透传", () => {
        const got = parsePageError({
            message: "x",
            source: 123,
            line: "not-a-number",
            column: null,
            stack: {},
        });
        expect(got).toEqual({ kind: "error", message: "x" });
    });

    test("非对象的输入返回 null", () => {
        expect(parsePageError(null)).toBeNull();
        expect(parsePageError("text")).toBeNull();
        expect(parsePageError(42)).toBeNull();
    });
});
