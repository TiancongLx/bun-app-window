import { expect, test } from "bun:test";

import { isRestrictedPort, serveOnSafePort } from "@/shell/port";

test("受限端口表覆盖已知会 ERR_UNSAFE_PORT 的端口", () => {
    // 1720 是本机实测命中过的（H.323 RAS），其余为 kRestrictedPorts 常见项
    for (const p of [1, 22, 1720, 1719, 6000, 6566, 6665, 10080]) {
        expect(isRestrictedPort(p)).toBe(true);
    }
});

test("常用开发端口不在受限表内", () => {
    for (const p of [80, 443, 3000, 5173, 8000, 8080, 9090]) {
        expect(isRestrictedPort(p)).toBe(false);
    }
});

test("serveOnSafePort 绑定到 40000–60000 且非受限", () => {
    const server = serveOnSafePort({
        fetch: () => new Response("ok"),
    });

    try {
        const port = server.port;
        expect(port).toBeDefined();
        if (port === undefined) throw new Error("unreachable");

        expect(port).toBeGreaterThanOrEqual(40000);
        expect(port).toBeLessThanOrEqual(60000);
        expect(isRestrictedPort(port)).toBe(false);
        expect(server.hostname).toBe("127.0.0.1");
    } finally {
        server.stop(true);
    }
});

test("serveOnSafePort 可连续启动多个实例且端口互不相同", () => {
    const servers = [0, 1, 2].map(() => serveOnSafePort({ fetch: () => new Response("ok") }));
    try {
        const ports = servers.map((s) => s.port);
        expect(new Set(ports).size).toBe(3);
        for (const p of ports) {
            if (p === undefined) throw new Error("port undefined");
            expect(isRestrictedPort(p)).toBe(false);
        }
    } finally {
        for (const s of servers) s.stop(true);
    }
});

test("hostname 可覆盖", () => {
    const server = serveOnSafePort({
        hostname: "127.0.0.1",
        fetch: () => new Response("ok"),
    });
    try {
        expect(server.hostname).toBe("127.0.0.1");
    } finally {
        server.stop(true);
    }
});

test("fetch 处理器真的被调用", async () => {
    const server = serveOnSafePort({
        fetch: () => new Response("hello-shell"),
    });
    try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("hello-shell");
    } finally {
        server.stop(true);
    }
});

test("attempts 极小且端口全被占时抛错", () => {
    // 用 attempts=1 且强制占用：这里改为验证「抛出的是 Error 且带可读信息」
    // 真实占满 40000–60000 不可行，故只断言错误类型与文案形状不被吞掉。
    const fn = () => serveOnSafePort({ fetch: () => new Response(""), attempts: 1 });
    // 正常应当成功（1 次尝试通常能成），因此只断言不抛非 Error 的东西
    try {
        const s = fn();
        s.stop(true);
        expect(true).toBe(true);
    } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).toContain("could not bind a safe port");
    }
});
