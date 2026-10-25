import { expect, test } from "bun:test";
import { join } from "node:path";

import { createShell } from "@/shell/index";
import { parseSize, type WindowSize } from "@/shell/types";

/**
 * 三个 setter 的读回值（ADR 0023）。
 *
 * 这份文件守的是**判据本身**，不是「功能好用」——成功路径（窗口真开着时读回标题）
 * 需要真起一个 WebView2 窗口，属于 `bun run demo` 那一层的人工验证面。
 *
 * 分两类断言：
 *
 * 1) **行为**：未启动态返回 `null` / `null` / `0`。这一条同时验证了 FFI 声明正确
 *    ——参数数量或类型写错时，同样的调用会崩或者返回垃圾值，而不是老实给 null。
 * 2) **静态**：实现必须经过对应的原生符号，且不能读「输入缓存」。这三条各自可红，
 *    且红的点不同（见每条注释）。
 */

const SOURCE = join(import.meta.dir, "..", "src", "shell");
const NATIVE_CC = join(import.meta.dir, "..", "native", "shell.cc");

// ---- parseSize：原生 "w,h" → 结构 ----

test("parseSize 解析原生两字段", () => {
    expect(parseSize("320,200")).toEqual({ width: 320, height: 200 });
});

test("parseSize 容忍两端空白", () => {
    expect(parseSize("  1024 , 768 \n")).toEqual({ width: 1024, height: 768 });
});

test("parseSize 拒绝残缺、非数字与非正尺寸", () => {
    expect(parseSize("")).toBeNull();
    expect(parseSize("320")).toBeNull();
    expect(parseSize("320,200,96")).toBeNull();
    expect(parseSize("a,b")).toBeNull();
    // set_min_size 对非正值是「忽略」，所以真读到 0 说明数据来自别处，不算合法约束
    expect(parseSize("0,200")).toBeNull();
    expect(parseSize("320,0")).toBeNull();
    expect(parseSize("-320,200")).toBeNull();
});

test("WindowSize 的字段是小写的 width / height（与 WindowRect 一致）", () => {
    const s: WindowSize = { width: 800, height: 600 };
    expect(Object.keys(s).sort()).toEqual(["height", "width"]);
});

// ---- 未启动态：三个 getter 各自的失败语义 ----

test("窗口未启动时 getTitle() / getMinSize() 返回 null，getBrowserUi() 返回 0", async () => {
    const shell = await createShell({ url: "http://127.0.0.1:1" });
    try {
        // 这两个在无窗口时给不出有意义的字符串 → null
        expect(shell.getTitle()).toBeNull();
        expect(shell.getMinSize()).toBeNull();
        // 而 0 是一个准确的答案：没有窗口，没有任何行为被关。不是「读不到」。
        expect(shell.getBrowserUi()).toBe(0);
    } finally {
        shell.stop();
    }
});

test("getBrowserUi() 返回的是数字而不是 -1（未启动不是错误）", async () => {
    const shell = await createShell({ url: "http://127.0.0.1:1" });
    try {
        // -1 在这个 API 里是「失败」的惯用值（setter 们用它）。若 getter 也回 -1，
        // 调用方就无法区分「窗口没开」与「什么都没关」。
        expect(shell.getBrowserUi()).not.toBe(-1);
        expect(typeof shell.getBrowserUi()).toBe("number");
    } finally {
        shell.stop();
    }
});

// ---- 静态：实现必须真的读原生，不能退回输入缓存 ----

/** 取 `shell.cc` 里某个导出函数的完整函数体（按大括号配平） */
function nativeBody(src: string, symbol: string): string {
    const at = src.indexOf(`int ${symbol}(`);
    if (at < 0) return "";
    const open = src.indexOf("{", at);
    if (open < 0) return "";
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return "";
}

test("shell_get_title 读窗口（GetWindowTextW），不读 g_title 缓存", async () => {
    const src = await Bun.file(NATIVE_CC).text();
    const body = nativeBody(src, "shell_get_title");
    // 防止空转：函数体取不到就等于没检查
    expect(body.length).toBeGreaterThan(50);

    expect(body).toContain("GetWindowTextW");
    // **这条是核心**：`shell_title()` 从不更新 `g_title`（只在 shell_start_ex 里赋过一次），
    // 所以读它等于把「输入」当成「结果」——一个 echo，不是 getter。
    expect(body).not.toContain("g_title");
});

test("shell_get_min_size 读的就是 WM_GETMINMAXINFO 用的那两个全局", async () => {
    const src = await Bun.file(NATIVE_CC).text();
    const body = nativeBody(src, "shell_get_min_size");
    expect(body.length).toBeGreaterThan(50);
    expect(body).toContain("g_min_w");
    expect(body).toContain("g_min_h");

    // 反过来确认「缓存即真相」这个前提没被破坏：min_track_size 必须还在用它们。
    // 若哪天最小尺寸改由别的机制生效，这条判据会红，提醒去改 getter 的数据源。
    const track = src.indexOf("void min_track_size(");
    expect(track).toBeGreaterThan(-1);
    const trackBody = src.slice(track, track + 400);
    expect(trackBody).toContain("g_min_w");
    expect(trackBody).toContain("g_min_h");
});

test("**反向**：g_browser_ui 必须累加，不能记最后一次", async () => {
    const src = await Bun.file(NATIVE_CC).text();
    // 只看 shell_set_browser_ui 的函数体：整文件断言在失败时会把 137 KB 源码
    // 全打印出来，而答案就在这几十行里。
    const body = nativeBody(src, "shell_set_browser_ui");
    expect(body.length).toBeGreaterThan(50);
    // 若这里写成 `g_browser_ui = mask`，「先关菜单、再关快捷键」之后 getter 会报
    // 只剩快捷键，读者会理解成菜单又开了。apply_browser_ui 只有关闭方向、没有恢复
    // 分支，所以累积才是那个被消费的真实状态。
    expect(body).toContain("g_browser_ui |= mask");
    expect(body).not.toContain("g_browser_ui = mask");
});

test("g_browser_ui 在 shell_start_ex 里归零（不跨窗口继承）", async () => {
    const src = await Bun.file(NATIVE_CC).text();
    const at = src.indexOf("int shell_start_ex(");
    expect(at).toBeGreaterThan(-1);
    // 只看启动函数的前 4000 字符：重置段在全局赋值区，不会跑到线程创建之后
    const head = src.slice(at, at + 4000);
    expect(head).toContain("g_browser_ui = 0");
    // 同一条理由也适用于最小尺寸——它此前是跨窗口泄漏的
    expect(head).toContain("g_min_w = 320");
    expect(head).toContain("g_min_h = 200");
});

// ---- 静态：TS 侧必须经过对应符号 ----

test("三个 getter 的实现都经过各自的原生符号", async () => {
    const src = await Bun.file(join(SOURCE, "index.ts")).text();
    for (const symbol of ["shell_get_title", "shell_get_min_size", "shell_get_browser_ui"]) {
        expect(src).toContain(`symbols.${symbol}`);
    }
});

test("**反向**：getTitle 不读任何 TS 侧镜像", async () => {
    const src = await Bun.file(join(SOURCE, "index.ts")).text();
    const at = src.indexOf("getTitle(): string | null {");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    // 只留实现到下一个方法声明之前
    const end = body.indexOf("minimize:");
    const impl = end > 0 ? body.slice(0, end) : body;
    expect(impl).toContain("shell_get_title");
    // 任何 `this.` / 模块级变量缓存都会让 getter 变成 echo。实现里只有局部 buf。
    expect(impl).not.toContain("g_title");
});

test("parseSize 放进了零依赖的 types.ts（与 parseBounds 同处）", async () => {
    const src = await Bun.file(join(SOURCE, "types.ts")).text();
    expect(src).toContain("export function parseSize(");
    // types.ts 的零 import 不变量由 tests/types-purity.test.ts 统一守，
    // 这里只确认新函数没有把它挪到别的模块（那样主入口就要 import 两个地方）。
    expect(src).toContain("export function parseBounds(");
});
