import { expect, test } from "bun:test";

/**
 * 导出面测试：验证 package.json 的 exports 映射在「按包名自引用」时可用。
 * 这是消费者真正会走的路径，比相对路径导入更接近真实用法。
 */

test("主入口可按包名解析，并暴露门面 API", async () => {
    const mod = await import("webview-shell");
    expect(typeof mod.createShell).toBe("function");
    expect(typeof mod.openShell).toBe("function");
    expect(typeof mod.serveOnSafePort).toBe("function");
    expect(typeof mod.isRestrictedPort).toBe("function");
    expect(typeof mod.resolveNativeLib).toBe("function");
    expect(typeof mod.isPackedRuntime).toBe("function");
});

test("主入口暴露标志位与常量", async () => {
    const mod = await import("webview-shell");
    expect(mod.FLAG_FRAMELESS).toBe(1);
    expect(mod.FLAG_TOPMOST).toBe(2);
    expect(mod.FLAG_CENTER).toBe(4);
    expect(mod.FLAG_RESIZABLE).toBe(8);
    expect(mod.RESIZE_EDGE.LEFT).toBe(10);
});

test("embedded 子路径可解析，且导出 embeddedDll", async () => {
    const mod = await import("webview-shell/embedded");
    expect(typeof mod.embeddedDll).toBe("function");
});

test("embeddedDll 在非编译产物下返回 null（不抛错）", async () => {
    const mod = await import("webview-shell/embedded");
    // 测试进程不是 bun build --compile 产物，Bun.embeddedFiles 里没有 DLL
    expect(await mod.embeddedDll()).toBeNull();
});

test("package.json 子路径可解析，且 os/cpu 受限", async () => {
    const pkg = await import("webview-shell/package.json");
    const json = (pkg as { default: Record<string, unknown> }).default;
    expect(json["name"]).toBe("webview-shell");
    expect(json["os"]).toEqual(["win32"]);
    expect(json["cpu"]).toEqual(["x64"]);
});

test("cstr / readCStr 往返", async () => {
    const { cstr, readCStr } = await import("webview-shell");
    expect(readCStr(cstr("hello"))).toBe("hello");
    expect(readCStr(cstr("中文与 ascii 混合"))).toBe("中文与 ascii 混合");
    expect(readCStr(null)).toBe("");
});
