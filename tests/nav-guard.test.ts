import { expect, test } from "bun:test";

import { resolve } from "node:path";

import {
    FLAG_ACCEPT_DROP,
    FLAG_ALLOW_EXTERNAL_NAV,
    FLAG_CENTER,
    FLAG_DEFER_SHOW,
    FLAG_FRAMELESS,
    FLAG_RESIZABLE,
    FLAG_START_MAXIMIZED,
    FLAG_TOPMOST,
} from "@/shell/types";

/**
 * 外部导航拦截的回归守护。
 *
 * ## 为什么这个文件必须存在
 *
 * 这一层的实现曾经**写完了却从未生效**过：`NavigationGuard` / `NewWindowGuard` /
 * `open_external()` / `install_nav_guard()` 全部就位，但
 *
 *  - `install_nav_guard()` 全仓零调用点；
 *  - `SHELL_FLAG_ALLOW_EXTERNAL_NAV` 枚举有、无任何解析处；
 *  - `g_origin` 注释写着「由 shell_start_ex 从 g_url 算出」，实际从未被赋值。
 *
 * 三者叠加的自然后果是：`install_nav_guard()` 第一行
 * `if (g_allow_external_nav || g_origin.empty()) return;` 因为 `g_origin` 恒空
 * 而必然提前返回 —— 安全债一分未还，而**没有任何断言会红**。
 *
 * 这类失效的形状是「声明了但没接线」：语法正确、编译通过、类型检查通过、
 * 静态 `toContain` 也拿它没办法。所以这里的断言主体不是「某个标识符存在」，
 * 而是**调用点与赋值点的存在性**，外加一条两端取值一致性。
 *
 * 断言一律跑在剔掉整行注释的源码上（同 `first-paint.test.ts` 的教训：
 * 注释掉一行就能绕过 `toContain`）。
 */
const SHELL_CC = await Bun.file(resolve(import.meta.dir, "../native/shell.cc")).text();

const SHELL_CODE = SHELL_CC.split(/\r?\n/)
    .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

/**
 * 两端 flag 取值必须逐位一致。
 *
 * TS 侧和 C++ 侧各写了一份 `FLAG_*` 常量，它们之间唯一的约束就是「数值相同」。
 * 上一轮的半成品正是从这里裂开的：C++ 有 `SHELL_FLAG_ALLOW_EXTERNAL_NAV = 128`，
 * TS 侧压根没有对应常量 —— 于是调用方**无法表达**这个意图，flag 永远传不进来。
 *
 * 两端任一侧新增而另一侧没跟上，这条都会红。
 */
const CPP_FLAGS = new Map<string, number>();
for (const m of SHELL_CODE.matchAll(/SHELL_FLAG_([A-Z_]+)\s*=\s*(\d+)/g)) {
    CPP_FLAGS.set(m[1] as string, Number(m[2]));
}

const TS_FLAGS: Record<string, number> = {
    FRAMELESS: FLAG_FRAMELESS,
    TOPMOST: FLAG_TOPMOST,
    CENTER: FLAG_CENTER,
    RESIZABLE: FLAG_RESIZABLE,
    DEFER_SHOW: FLAG_DEFER_SHOW,
    ACCEPT_DROP: FLAG_ACCEPT_DROP,
    START_MAXIMIZED: FLAG_START_MAXIMIZED,
    ALLOW_EXTERNAL_NAV: FLAG_ALLOW_EXTERNAL_NAV,
};

test("FLAG_* 在 TS 与 C++ 两侧逐位一致", () => {
    for (const [name, tsValue] of Object.entries(TS_FLAGS)) {
        expect({ name, value: CPP_FLAGS.get(name) }).toEqual({ name, value: tsValue });
    }
});

test("C++ 侧的每个 SHELL_FLAG_ 在 TS 侧都有对应常量（反向）", () => {
    // 正向断言（TS 有的 C++ 必须有）抓不到「C++ 新增而 TS 不知道」——
    // 而后者才是这个仓库真正发生过的形态：C++ 先行，TS 侧缺失使 flag 无法传入。
    const missing = [...CPP_FLAGS.keys()].filter((name) => !(name in TS_FLAGS));
    expect(missing).toEqual([]);
});

test("每个 flag 都是单一二进制位且互不重叠", () => {
    const values = Object.values(TS_FLAGS);
    expect(new Set(values).size).toBe(values.length);
    for (const f of values) {
        expect(f & (f - 1)).toBe(0);
    }
});

/**
 * 「声明了但没接线」是这一层唯一的真实失效形态，逐项钉住。
 */
test("install_nav_guard 有调用点，且在 webview_navigate 之前", () => {
    // 只看调用（`install_nav_guard();`），定义（`void install_nav_guard() {`）不算
    const calls = [...SHELL_CODE.matchAll(/^\s*install_nav_guard\(\);/gm)];
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const defAt = SHELL_CODE.indexOf("void install_nav_guard()");
    expect(defAt).toBeGreaterThan(0);

    const navAt = SHELL_CODE.indexOf("webview_navigate(g_webview");
    expect(navAt).toBeGreaterThan(0);

    // 注册必须早于首次导航：NavigationStarting 只对注册之后发起的导航生效，
    // 晚一步的话最先加载的那一次（也是最可能被入口带偏的一次）完全不受保护。
    const firstCallAt = SHELL_CODE.search(/^\s*install_nav_guard\(\);/m);
    expect(firstCallAt).toBeGreaterThan(defAt);
    expect(firstCallAt).toBeLessThan(navAt);
});

test("uninstall_nav_guard 有调用点，且在 webview_destroy 之前", () => {
    const calls = [...SHELL_CODE.matchAll(/^\s*uninstall_nav_guard\(\);/gm)];
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const callAt = SHELL_CODE.search(/^\s*uninstall_nav_guard\(\);/m);
    const destroyAt = SHELL_CODE.indexOf("webview_destroy(g_webview)");
    expect(callAt).toBeGreaterThan(0);
    expect(destroyAt).toBeGreaterThan(0);
    // destroy 之后 core_webview() 返回 nullptr，remove_ 无从谈起，
    // 守卫对象会一直挂在已死的 core 上（释放时崩）
    expect(callAt).toBeLessThan(destroyAt);
});

test("SHELL_FLAG_ALLOW_EXTERNAL_NAV 在 shell_start_ex 里真的被解析", () => {
    // 枚举定义处不算解析：必须是 `g_allow_external_nav = (flags & ...)` 这种形态
    expect(SHELL_CODE).toMatch(
        /g_allow_external_nav\s*=\s*\(flags\s*&\s*SHELL_FLAG_ALLOW_EXTERNAL_NAV\)\s*!=\s*0/,
    );
});

test("g_origin 从启动地址算出，不是只声明不使用", () => {
    // 注释曾声称「由 shell_start_ex 从 g_url 算出」，而赋值一句都没有。
    // 判据是赋值形态本身，不是标识符存在。
    expect(SHELL_CODE).toMatch(/g_origin\s*=\s*url_origin\(/);
    // 同时要求同文档基准也被赋值——它是 file:// 应用的唯一判据来历
    expect(SHELL_CODE).toMatch(/g_app_doc\s*=\s*strip_fragment\(/);
});

/**
 * 两个守卫的门槛**不同**，这不是疏漏。
 *
 * `FLAG_ALLOW_EXTERNAL_NAV` 的语义是「本应用就是个浏览器」，跳过顶层导航拦截是
 * 本意。但拦住 `window.open` 是能力边界而非安全策略：壳只支持一个顶层窗口
 * （原生层是进程级单例），开出来的新窗口没有任何宿主 API 能管它——关不掉、
 * 读不到、收不到 shell-msg。
 *
 * 所以 `NewWindowGuard` 的注册条件里**不许**出现 `g_allow_external_nav`。
 */
test("NewWindowGuard 不受 ALLOW_EXTERNAL_NAV 控制（能力边界，不是安全策略）", () => {
    const installAt = SHELL_CODE.indexOf("void install_nav_guard()");
    expect(installAt).toBeGreaterThan(0);
    const body = SHELL_CODE.slice(installAt, installAt + 900);

    expect(body).toContain("add_NavigationStarting");
    expect(body).toContain("add_NewWindowRequested");

    // NavigationGuard 的分支必须被 g_allow_external_nav 控住……
    expect(body).toMatch(/if\s*\(!g_allow_external_nav\s*&&\s*!g_nav_guard\)/);

    // ……而 NewWindowGuard 的分支不能
    const newWindowAt = body.indexOf("if (!g_new_window_guard) {");
    expect(newWindowAt).toBeGreaterThan(0);
    const newWindowGuard = body.slice(newWindowAt, newWindowAt + 220);
    expect(newWindowGuard).not.toContain("g_allow_external_nav");
});

/**
 * scheme 白名单。`ShellExecuteW(L"open", url)` 按协议名找注册的处理程序，
 * 对任意 scheme 调用等于把「触发任意协议处理器」交给页面。
 * `mailto:` / `tel:` 也**不在**白名单里（2026-10-21 明确决定：宁可死链）。
 */
test("只有 http/https 会被交给系统浏览器", () => {
    const originAt = SHELL_CODE.indexOf("static std::wstring url_origin(");
    expect(originAt).toBeGreaterThan(0);
    const body = SHELL_CODE.slice(originAt, originAt + 700);
    expect(body).toContain('scheme != L"http"');
    expect(body).toContain('scheme != L"https"');

    // 反向：白名单里不许混进别的 scheme
    expect(body).not.toContain('L"mailto"');
    expect(body).not.toContain('L"tel"');
    expect(body).not.toContain('L"file"');
});

/**
 * `g_origin` 为空（`file://`、`about:blank`、自定义 scheme）时**不能退化成全放行**。
 *
 * 旧实现里 `is_same_origin()` 在 `g_origin` 为空时直接 `return true`，
 * 于是判据恒真、什么也不拦——而 `file://` 恰恰是桌面应用最常见的形态，
 * 等于给最需要的场景开了后门。现在退化为「同文档」：比去掉 `#fragment`
 * 之后与启动地址是否相同。
 */
test("origin 为空时退化为同文档判据，而不是全放行", () => {
    const classifyAt = SHELL_CODE.indexOf("static NavVerdict classify_nav(");
    expect(classifyAt).toBeGreaterThan(0);
    const body = SHELL_CODE.slice(classifyAt, classifyAt + 600);

    // 退化判据的两个组成部分：同文档基准 + 剥掉 fragment 才比较
    expect(body).toContain("g_app_doc");
    expect(body).toContain("strip_fragment(url)");

    // 兜底方向必须是 External。判据写反（退化分支落回 Allow）就等于没拦，
    // 而 `return Allow` 与 `return External` 在 toContain 层面长得差不多，
    // 所以必须钉住最后一条 return 的取值。
    const tail = body.slice(body.lastIndexOf("return NavVerdict::"));
    expect(tail).toContain("NavVerdict::External");
});

/**
 * 旧实现的反向守护：`is_same_origin()` 那个「空 origin 一律判同源」的写法
 * 不许回来。它不是被删掉就完事的——只要有人觉得「解析失败时别拦」，
 * 最省事的写法就是把它加回来。
 */
test("不存在「空 origin 一律放行」的判据", () => {
    expect(SHELL_CODE).not.toContain("is_same_origin");
    // 退化分支里不许把 empty 当成通行证
    const classifyAt = SHELL_CODE.indexOf("static NavVerdict classify_nav(");
    const body = SHELL_CODE.slice(classifyAt, classifyAt + 600);
    expect(body).not.toMatch(/if\s*\(\s*g_origin\.empty\(\)\s*\)\s*\{\s*return\s+NavVerdict::Allow/);
});
