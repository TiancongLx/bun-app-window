import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * 导出面测试：验证 package.json 的 exports 映射在「按包名自引用」时可用。
 * 这是消费者真正会走的路径，比相对路径导入更接近真实用法。
 */

test("主入口可按包名解析，并暴露门面 API", async () => {
    const mod = await import("bun-app-window");
    expect(typeof mod.createShell).toBe("function");
    expect(typeof mod.openShell).toBe("function");
    expect(typeof mod.serveOnSafePort).toBe("function");
    expect(typeof mod.isRestrictedPort).toBe("function");
    expect(typeof mod.resolveNativeLib).toBe("function");
    expect(typeof mod.isPackedRuntime).toBe("function");
});

test("主入口暴露标志位与常量", async () => {
    const mod = await import("bun-app-window");
    expect(mod.FLAG_FRAMELESS).toBe(1);
    expect(mod.FLAG_TOPMOST).toBe(2);
    expect(mod.FLAG_CENTER).toBe(4);
    expect(mod.FLAG_RESIZABLE).toBe(8);
    expect(mod.RESIZE_EDGE.LEFT).toBe(10);
});

test("embedded 子路径可解析，且导出 embeddedDll", async () => {
    const mod = await import("bun-app-window/embedded");
    expect(typeof mod.embeddedDll).toBe("function");
});

test("embeddedDll 在非编译产物下返回 null（不抛错）", async () => {
    const mod = await import("bun-app-window/embedded");
    // 测试进程不是 bun build --compile 产物，Bun.embeddedFiles 里没有 DLL
    expect(await mod.embeddedDll()).toBeNull();
});

test("package.json 子路径可解析，且 os/cpu 受限", async () => {
    const pkg = await import("bun-app-window/package.json");
    const json = (pkg as { default: Record<string, unknown> }).default;
    expect(json["name"]).toBe("bun-app-window");
    expect(json["os"]).toEqual(["win32"]);
    expect(json["cpu"]).toEqual(["x64"]);
});

test("cstr / readCStr 往返", async () => {
    const { cstr, readCStr } = await import("bun-app-window");
    expect(readCStr(cstr("hello"))).toBe("hello");
    expect(readCStr(cstr("中文与 ascii 混合"))).toBe("中文与 ascii 混合");
    expect(readCStr(null)).toBe("");
});

test("ipc 子路径可解析，且导出服务端与客户端", async () => {
    const mod = await import("bun-app-window/ipc");
    expect(typeof mod.createIpcServer).toBe("function");
    expect(typeof mod.connect).toBe("function");
    expect(typeof mod.webSocketChannel).toBe("function");
});

test("ipc 子路径不引入副作用（导入即可用，不碰 DOM 与网络）", async () => {
    // 服务端侧构造不需要连接；这条同时守住「import 不触发任何 I/O」
    const { createIpcServer } = await import("bun-app-window/ipc");
    const server = createIpcServer({ service: { a: () => 1 } });
    expect(server.methods).toEqual(["a"]);
    expect(server.peers).toBe(0);
});

test("titlebar 子路径可解析，且导出组件与纯函数", async () => {
    const mod = await import("bun-app-window/titlebar");
    expect(typeof mod.mountTitleBar).toBe("function");
    expect(typeof mod.glyphFor).toBe("function");
    expect(typeof mod.labelFor).toBe("function");
    expect(typeof mod.titleBarCss).toBe("function");
    expect(typeof mod.bridgeFromWindowService).toBe("function");
    // 字形表是常量，导出后应可直接读
    expect(mod.TITLEBAR_GLYPHS.unicode.maximize).toBe("\u25A1");
});

/**
 * `./types` 子路径的存在理由：页面侧要 import `BROWSER_UI_*` / `ZOOM_LADDER`
 * 这类常量，而主入口会拖进 `bun:ffi`，浏览器 bundle 解析不了。
 *
 * 所以除了「能解析」，还要证明它**确实不含** `bun:ffi` —— 否则这个子路径
 * 一点意义也没有，消费者又会退回手抄常量（那正是它要消灭的漂移源）。
 */
test("types 子路径可解析，且暴露全部常量面", async () => {
    const mod = await import("bun-app-window/types");

    // 标志位
    expect(mod.FLAG_FRAMELESS).toBe(1);
    expect(mod.FLAG_ACCEPT_DROP).toBe(32);
    expect(mod.FLAG_ALLOW_EXTERNAL_NAV).toBe(128);

    // 浏览器 UI 位（页面侧最需要的一份）
    expect(mod.BROWSER_UI_MENU).toBe(1);
    expect(mod.BROWSER_UI_KEYS).toBe(2);
    expect(mod.BROWSER_UI_STATUSBAR).toBe(4);
    expect(mod.BROWSER_UI_SWIPE).toBe(8);
    expect(mod.BROWSER_UI_AUTOFILL).toBe(16);
    expect(mod.BROWSER_UI_ALL).toBe(31);

    // 缩放阶梯与边框映射（过去只能手抄的两份表）
    expect(mod.ZOOM_LADDER.length).toBe(14);
    expect(mod.ZOOM_MIN).toBe(0.25);
    expect(mod.ZOOM_MAX).toBe(3.0);
    expect(mod.RESIZE_EDGE.LEFT).toBe(10);
    expect(mod.resizeIndex(mod.RESIZE_EDGE.LEFT)).toBe(0);

    // 状态掩码
    expect(mod.STATE_MAXIMIZED).toBe(1);
    expect(mod.STATE_FOCUSED).toBe(4);
});

test("types 子路径不含 bun:ffi —— 消费者能把它打进浏览器 bundle 的前提", async () => {
    // 「能解析」不等于「浏览器安全」：如果 `types.ts` 牵连进 `./index`，
    // `bun:ffi` 会在模块求值期就 dlopen，浏览器 bundle 直接解析失败。
    //
    // 判据不在这里另写一份正则——纯净性由 `tests/types-purity.test.ts` 统一守，
    // 两处各写一份必然漂移。这里只做一件事：确认那份判据覆盖的文件就是
    // `./types` 指向的文件，两边不会指向不同路径。
    //
    // 从磁盘读再收窄，而不是 `import "bun-app-window/package.json"` 后断言：
    // 后者会拿到完整的 JSON 模块类型，`exports` 里 `./native` 是条件对象而不是
    // 字符串，写成 `Record<string, string>` 会触发 `TS2352`（第一版就这么红的）。
    const raw = await Bun.file(join(import.meta.dir, "..", "package.json")).text();
    const pkg: unknown = JSON.parse(raw);
    const field = (pkg as { exports?: Record<string, unknown> }).exports;

    expect(field?.["./types"]).toBe("./src/shell/types.ts");
});
