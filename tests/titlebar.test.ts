import { expect, test } from "bun:test";

import { resolve } from "node:path";

import {
    bridgeFromWindowService,
    detectIconSet,
    glyphFor,
    labelFor,
    mountTitleBar,
    TITLEBAR_GLYPHS,
    TITLEBAR_ICON_FONT_STACK,
    titleBarCss,
    type TitleBarBridge,
    type TitleBarDocument,
    type TitleBarElement,
} from "@/ui/titlebar";

/**
 * 源码级判据：`resolveDocument` 的全局访问必须是双层断言。
 *
 * 这一条只能落在写法上。消费者 tsconfig 的 `lib` 含 `DOM` 时，
 * `globalThis.document` 是完整的 `Document`，与组件的极简结构不重叠，
 * 单层 `as` 被判成 TS2352；而本仓 `lib` 只有 `ESNext`，这个错在本仓
 * 永远复现不出来。`unknown` 一旦被当成冗余清理掉，消费者全炸而门禁全绿。
 *
 * 断言跑在剔掉整行注释的源码上（同 `nav-guard.test.ts`：注释掉一行就能绕过 `toContain`）。
 */
const TITLEBAR_TS = await Bun.file(resolve(import.meta.dir, "../src/ui/titlebar.ts")).text();

const TITLEBAR_CODE = TITLEBAR_TS.split(/\r?\n/)
    .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

/**
 * 组件不依赖 DOM 类型声明（`tsconfig` 的 lib 只有 ESNext），
 * 所以这里用一个最小的假 DOM 就能完整驱动挂载逻辑。
 */

type FakeElement = TitleBarElement & {
    tag: string;
    parent: FakeElement | null;
    children: FakeElement[];
    attrs: Map<string, string>;
    listeners: Map<string, ((ev: unknown) => void)[]>;
    fire(type: string, ev: unknown): void;
};

function fakeElement(tag: string): FakeElement {
    const attrs = new Map<string, string>();
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const children: FakeElement[] = [];

    const el: FakeElement = {
        tag,
        className: "",
        textContent: null,
        parent: null,
        children,
        attrs,
        listeners,
        style: { setProperty: () => undefined },
        append(...nodes: FakeElement[]): void {
            for (const n of nodes) {
                el.appendChild(n);
            }
        },
        appendChild(child: FakeElement): FakeElement {
            children.push(child);
            child.parent = el;
            return child;
        },
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        getAttribute(name: string): string | null {
            return attrs.get(name) ?? null;
        },
        addEventListener(type: string, fn: (ev: never) => void): void {
            const list = listeners.get(type) ?? [];
            list.push(fn as unknown as (ev: unknown) => void);
            listeners.set(type, list);
        },
        removeEventListener(type: string, fn: (ev: never) => void): void {
            const list = listeners.get(type);
            if (!list) {
                return;
            }
            const i = list.indexOf(fn as unknown as (ev: unknown) => void);
            if (i >= 0) {
                list.splice(i, 1);
            }
        },
        remove(): void {
            if (!el.parent) {
                return;
            }
            const i = el.parent.children.indexOf(el);
            if (i >= 0) {
                el.parent.children.splice(i, 1);
            }
            el.parent = null;
        },
        fire(type: string, ev: unknown): void {
            // 复制一份：处理器里可能 removeEventListener
            for (const fn of [...(listeners.get(type) ?? [])]) {
                fn(ev);
            }
        },
    };

    return el;
}

function walk(node: FakeElement, visit: (n: FakeElement) => void): void {
    visit(node);
    for (const c of node.children) {
        walk(c, visit);
    }
}

function fakeDocument(): TitleBarDocument & { body: FakeElement } {
    const body = fakeElement("body");

    return {
        body,
        createElement: (tag: string) => fakeElement(tag) as unknown as TitleBarElement,
        getElementById: (id: string) => {
            let hit: FakeElement | null = null;
            walk(body, (n) => {
                if (hit === null && n.getAttribute("id") === id) {
                    hit = n;
                }
            });
            return hit as unknown as TitleBarElement | null;
        },
        querySelector: () => null,
    };
}

function recordingBridge(): TitleBarBridge & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        minimize: () => calls.push("minimize"),
        toggleMaximize: () => calls.push("toggleMaximize"),
        close: () => calls.push("close"),
        drag: () => calls.push("drag"),
    };
}

// ---------- 纯函数 ----------

test("字形表：unicode 与 fluent 两套都能给出四个动作", () => {
    for (const set of ["unicode", "fluent"] as const) {
        const g = TITLEBAR_GLYPHS[set];
        expect(typeof g.minimize).toBe("string");
        expect(typeof g.maximize).toBe("string");
        expect(typeof g.restore).toBe("string");
        expect(typeof g.close).toBe("string");
        // 四个字形互不相同，否则界面上分不出按钮
        expect(new Set([g.minimize, g.maximize, g.restore, g.close]).size).toBe(4);
    }
});

test("最大/还原按钮在两种状态下给出不同字形", () => {
    for (const set of ["unicode", "fluent"] as const) {
        const normal = glyphFor(set, "maximize", false);
        const maxed = glyphFor(set, "maximize", true);
        expect(normal).toBe(TITLEBAR_GLYPHS[set].maximize);
        expect(maxed).toBe(TITLEBAR_GLYPHS[set].restore);
        // 关键：漏掉这个分支，用户就永远看到「最大化」图标
        expect(normal).not.toBe(maxed);
    }
});

test("最小化与关闭的字形不受最大化状态影响", () => {
    expect(glyphFor("unicode", "minimize", false)).toBe(glyphFor("unicode", "minimize", true));
    expect(glyphFor("unicode", "close", false)).toBe(glyphFor("unicode", "close", true));
});

test("无障碍标签随最大化状态变化", () => {
    expect(labelFor("minimize", false)).toBe("最小化");
    expect(labelFor("close", true)).toBe("关闭");
    expect(labelFor("maximize", false)).toBe("最大化");
    expect(labelFor("maximize", true)).toBe("向下还原");
});

test("样式表包含 Win 11 的关键取值", () => {
    const css = titleBarCss();
    // 关闭键悬停红是 Win 11 最有辨识度的一处
    expect(css).toContain("#c42b1c");
    // 尺寸走变量，接入方可覆盖
    expect(css).toContain("--ws-tb-height: 32px");
    expect(css).toContain("width: 46px");
    // 浅色主题
    expect(css).toContain('[data-theme="light"]');
    // 禁用文本选择：否则拖窗口会选中标题文字
    expect(css).toContain("user-select: none");
});

// ---------- 消费方元素选择器的渗入 ----------

/**
 * 取样式表里某个选择器的第一个规则块（`{` 到 `}`）。
 *
 * 断言必须在**块内**做：`expect(css).toContain("padding: 0")` 会被任意一条
 * 无关规则的 `padding: 0` 满足（本表里 `.ws-titlebar__btn` 就有），
 * 于是判据自己变成恒真。
 */
function cssBlock(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) {
        return "";
    }
    const open = css.indexOf("{", at);
    const close = css.indexOf("\n}", open);
    return close < 0 ? css.slice(open) : css.slice(open, close + 1);
}

/**
 * 根节点必须显式声明 padding / margin / gap。
 *
 * 挂载点是 `<header class="ws-titlebar">`，而消费方普遍用元素选择器写自己的页头
 * （`header { padding: 12px 18px 10px }` 是最常见的一种）。元素选择器的特异性
 * 低于类选择器，但**只在组件声明了该属性时**才被压住——没写的属性等于交给消费方。
 *
 * 实测（`baw-mvp` 的 `index.html`）：这三条缺一条就出事，
 * 18px 右内边距把三个按钮整体推左 18 CSS px（@192dpi 量到 36 物理 px），
 * 12/10 的上下内边距把 32px 的标题栏压成 9px 内容高。
 * 症状是「字形没居中」——而字形在按钮内其实是居中的，整块被推歪了。
 *
 * 这条判据守的是意图（不许把控制权交出去），不是某个具体取值。
 */
test("根节点显式声明 padding / margin / gap，否则消费方的元素选择器会渗进来", () => {
    const block = cssBlock(titleBarCss(), ".ws-titlebar");
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("padding: 0");
    expect(block).toContain("margin: 0");
    expect(block).toContain("gap: 0");
    // 高度必须由组件自己说了算：消费方一句 `header { padding }` 就能把它吃掉
    expect(block).toContain("box-sizing: border-box");
});

/** 按钮同理：`button { margin: ... }` 是消费方最常见的写法之一。 */
test("按钮显式清零 margin / padding / border", () => {
    const block = cssBlock(titleBarCss(), ".ws-titlebar__btn");
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("margin: 0");
    expect(block).toContain("padding: 0");
    expect(block).toContain("border: 0");
    // 46×32 是 Win 11 的 caption 规格，被内边距一挤就不对了
    expect(block).toContain("width: 46px");
    expect(block).toContain("height: 100%");
});

/**
 * 控件容器同样不能被外来的 `margin` / `padding` 改尺寸：
 * 三个按钮的右边缘要贴着客户区右边缘，这是 caption 按钮的定义位。
 */
test("控件容器不靠外来样式定尺寸", () => {
    const block = cssBlock(titleBarCss(), ".ws-titlebar__controls");
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("flex: none");
    expect(block).toContain("align-items: stretch");
});

// ---------- 挂载 ----------

test("挂载后结构完整：标题栏 + 图标 + 标题 + 三个按钮", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ title: "我的应用", bridge: recordingBridge(), document: doc });

    const root = bar.el as unknown as FakeElement;
    expect(root.className).toBe("ws-titlebar");
    expect(root.children.length).toBe(2);

    const lead = root.children[0];
    const controls = root.children[1];
    expect(lead?.className).toBe("ws-titlebar__lead");
    expect(controls?.className).toBe("ws-titlebar__controls");
    expect(controls?.children.length).toBe(3);

    const acts = controls?.children.map((b) => b.getAttribute("data-act"));
    expect(acts).toEqual(["minimize", "maximize", "close"]);
    // 关闭按钮要带修饰类，否则悬停红不会生效
    expect(controls?.children[2]?.className).toContain("ws-titlebar__btn--close");
});

test("样式只注入一次，多个标题栏共用", () => {
    const doc = fakeDocument();
    mountTitleBar({ bridge: recordingBridge(), document: doc });
    mountTitleBar({ bridge: recordingBridge(), document: doc });

    let count = 0;
    walk(doc.body, (n) => {
        if (n.getAttribute("id") === "bun-app-window-titlebar-css") {
            count++;
        }
    });
    expect(count).toBe(1);
});

test("未给图标时图标位隐藏，给了则设 src", () => {
    const docNoIcon = fakeDocument();
    const bar1 = mountTitleBar({ bridge: recordingBridge(), document: docNoIcon });
    const lead1 = (bar1.el as unknown as FakeElement).children[0];
    expect(lead1?.children[0]?.getAttribute("hidden")).toBe("");

    const docIcon = fakeDocument();
    const bar2 = mountTitleBar({
        icon: "/icon.svg",
        bridge: recordingBridge(),
        document: docIcon,
    });
    const lead2 = (bar2.el as unknown as FakeElement).children[0];
    expect(lead2?.children[0]?.getAttribute("src")).toBe("/icon.svg");
});

test("左键按下标题区触发拖拽，并阻止默认选择行为", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ title: "T", bridge, document: doc });

    let prevented = false;
    const root = bar.el as unknown as FakeElement;
    const lead = root.children[0];

    // target 落在标题区（closest 找不到控件容器）
    root.fire("pointerdown", {
        button: 0,
        target: { closest: () => null },
        preventDefault: () => {
            prevented = true;
        },
    });

    expect(bridge.calls).toEqual(["drag"]);
    expect(prevented).toBe(true);

    void lead;
});

test("非左键按下不触发拖拽", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });

    (bar.el as unknown as FakeElement).fire("pointerdown", {
        button: 2,
        target: { closest: () => null },
        preventDefault: () => undefined,
    });

    expect(bridge.calls).toEqual([]);
});

test("事件落在控件区时不触发窗口拖拽（否则点按钮会拖动窗口）", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });

    const root = bar.el as unknown as FakeElement;
    const controls = root.children[1];

    root.fire("pointerdown", {
        button: 0,
        target: { closest: (sel: string) => (sel === "[data-ws-tb-controls]" ? controls : null) },
        preventDefault: () => undefined,
    });

    expect(bridge.calls).toEqual([]);
});

test("双击标题区切换最大化；双击按钮区不切换", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const root = bar.el as unknown as FakeElement;
    const controls = root.children[1];

    root.fire("dblclick", { target: { closest: () => null } });
    expect(bridge.calls).toEqual(["toggleMaximize"]);

    root.fire("dblclick", {
        target: { closest: (sel: string) => (sel === "[data-ws-tb-controls]" ? controls : null) },
    });
    expect(bridge.calls).toEqual(["toggleMaximize"]);
});

test("三个按钮分别触发对应动作", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];

    const clickOn = (index: number): void => {
        const btn = controls?.children[index];
        controls?.fire("click", {
            target: {
                closest: (sel: string) => (sel === "[data-act]" ? (btn ?? null) : null),
            },
        });
    };

    clickOn(0);
    clickOn(1);
    clickOn(2);
    expect(bridge.calls).toEqual(["minimize", "toggleMaximize", "close"]);
});

test("点在控件区但没有 data-act 时什么都不做", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];

    controls?.fire("click", { target: { closest: () => null } });
    expect(bridge.calls).toEqual([]);
});

test("setMaximized 更新按钮字形与无障碍标签，isMaximized 跟随", () => {
    const doc = fakeDocument();
    // 显式指定 unicode：这条测的是「状态翻转有没有换字形」，与字体无关。
    // 缺省字形由 detectIconSet 决定（通常是 fluent），拿它当期望值会把两件事混在一起。
    const bar = mountTitleBar({ bridge: recordingBridge(), maximized: false, icons: "unicode", document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];
    const maxBtn = controls?.children[1];

    expect(maxBtn?.textContent).toBe(TITLEBAR_GLYPHS.unicode.maximize);
    expect(bar.isMaximized()).toBe(false);

    bar.setMaximized(true);
    expect(maxBtn?.textContent).toBe(TITLEBAR_GLYPHS.unicode.restore);
    expect(maxBtn?.getAttribute("aria-label")).toBe("向下还原");
    expect(bar.isMaximized()).toBe(true);
});

test("初始最大化时按钮一上来就是还原字形", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ bridge: recordingBridge(), maximized: true, icons: "unicode", document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];
    expect(controls?.children[1]?.textContent).toBe(TITLEBAR_GLYPHS.unicode.restore);
    expect(bar.isMaximized()).toBe(true);
});

test("setTitle 同时更新可见文本与 title 属性", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ title: "旧标题", bridge: recordingBridge(), document: doc });
    const root = bar.el as unknown as FakeElement;
    const titleEl = root.children[0]?.children[1];

    bar.setTitle("新标题");
    expect(titleEl?.textContent).toBe("新标题");
    // title 属性挂在根上，鼠标悬停系统提示与任务栏一致
    expect(root.getAttribute("title")).toBe("新标题");
});

test("setTheme 写到根节点，样式靠属性选择器切换", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ bridge: recordingBridge(), document: doc });
    const root = bar.el as unknown as FakeElement;

    bar.setTheme("light");
    expect(root.getAttribute("data-theme")).toBe("light");
    bar.setTheme("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
});

test("destroy 从 DOM 摘掉并解绑事件", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const root = bar.el as unknown as FakeElement;

    expect(doc.body.children.length).toBe(2); // style + header

    bar.destroy();
    expect(doc.body.children.length).toBe(1);
    expect(root.parent).toBeNull();
    expect(root.listeners.get("pointerdown")?.length ?? 0).toBe(0);
});

test("没有 document 且未注入时抛出可读错误", () => {
    // lib 里没有 DOM 类型，globalThis.document 在 Bun 下不存在
    expect(() => mountTitleBar({ bridge: recordingBridge() })).toThrow("mountTitleBar: no document available");
});

test("resolveDocument 的全局访问是双层断言（单层在带 DOM lib 的消费者里报 TS2352）", () => {
    // 这条断言守的是「消费者编译得过」，而本仓永远编译不出那个错——
    // 所以它的判据只能是写法本身，不是运行行为。
    expect(TITLEBAR_CODE).toContain("globalThis as unknown as { document?: TitleBarDocument }");
});

// ---------- 字形集探测 ----------

/** 带字体探测能力的假 document：`available` 里的字体名才算存在。 */
function fakeDocumentWithFonts(available: readonly string[]): TitleBarDocument & { body: FakeElement } {
    const doc = fakeDocument();
    return {
        ...doc,
        fonts: {
            check(font: string): boolean {
                return available.some((name) => font.includes(`"${name}"`));
            },
        },
    };
}

test("缺省字形集是 fluent —— 这才拿得到 Win 11 的 10×10 字形", () => {
    // 没有探测能力时按 fluent 处理：目标平台是 Windows，Win 10/11 都自带 icon 字体。
    expect(detectIconSet()).toBe("fluent");
    expect(detectIconSet(undefined)).toBe("fluent");
});

test("两个 icon 字体有一个在就用 fluent（码位在 Win 10/11 里是同一个位置）", () => {
    expect(detectIconSet({ check: (f) => f.includes("Segoe Fluent Icons") })).toBe("fluent");
    // 只有 Win 10 的 MDL2 也一样：E921/E922/E923/E8BB 在两套字体里逐字相同
    expect(detectIconSet({ check: (f) => f.includes("Segoe MDL2 Assets") })).toBe("fluent");
    expect(detectIconSet({ check: () => true })).toBe("fluent");
});

test("两个 icon 字体都不在时退回 unicode —— 否则 PUA 码位渲染成豆腐块", () => {
    expect(detectIconSet({ check: () => false })).toBe("unicode");
});

test("挂载时按探测结果选字形；显式传 icons 时以调用方为准", () => {
    const fluentDoc = fakeDocumentWithFonts(["Segoe Fluent Icons"]);
    const bar1 = mountTitleBar({ bridge: recordingBridge(), document: fluentDoc });
    expect((bar1.el as unknown as FakeElement).getAttribute("data-icons")).toBe("fluent");

    const tofuDoc = fakeDocumentWithFonts([]);
    const bar2 = mountTitleBar({ bridge: recordingBridge(), document: tofuDoc });
    expect((bar2.el as unknown as FakeElement).getAttribute("data-icons")).toBe("unicode");

    // 显式覆盖：探测说 unicode，调用方要 fluent 就给 fluent
    const forced = mountTitleBar({ bridge: recordingBridge(), icons: "fluent", document: tofuDoc });
    expect((forced.el as unknown as FakeElement).getAttribute("data-icons")).toBe("fluent");
});

test("fluent 的字体栈同时列出 Win 11 与 Win 10 的字体，且 CSS 里用上了", () => {
    expect(TITLEBAR_ICON_FONT_STACK).toContain("Segoe Fluent Icons");
    expect(TITLEBAR_ICON_FONT_STACK).toContain("Segoe MDL2 Assets");
    const block = cssBlock(titleBarCss(), '.ws-titlebar[data-icons="fluent"] .ws-titlebar__btn');
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain(TITLEBAR_ICON_FONT_STACK);
});

// ---------- 五个状态 ----------

/**
 * Win 11 的 caption 背板是「前景色 + 一份 alpha」，四个数值连同关闭键的红色
 * 都取自 Windows 自己的实现（与 `egoist/mygo` 的 `colors()` 一致）。
 *
 * 断言落在具体数值上而不是「有没有这条规则」：旧值 0.0605 / 0.0419 也「有规则」，
 * 只是悬停几乎看不出来——那正是这次要修的东西。
 */
test("悬停与按下背板用 10.2% / 20%（旧值 6.05% / 4.19% 偏淡到看不见）", () => {
    const block = cssBlock(titleBarCss(), ".ws-titlebar");
    expect(block).toContain("--ws-tb-hover: rgba(255, 255, 255, 0.102);");
    expect(block).toContain("--ws-tb-active: rgba(255, 255, 255, 0.200);");
});

test("失焦与禁用各有一档，且失焦靠自定义属性继承而不是堆特异性", () => {
    const css = titleBarCss();
    const root = cssBlock(css, ".ws-titlebar");
    expect(root).toContain("--ws-tb-inactive: rgba(255, 255, 255, 0.447);");
    expect(root).toContain("--ws-tb-disabled: rgba(255, 255, 255, 0.361);");
    // 字形颜色必须是变量，否则 [data-active="false"] 压不过 :hover
    expect(root).toContain("--ws-tb-btn-fg: var(--ws-tb-fg);");
    const inactive = cssBlock(css, '.ws-titlebar[data-active="false"]');
    expect(inactive).toContain("--ws-tb-btn-fg: var(--ws-tb-inactive);");
});

test("浅色主题同样有四个背板/字形档位（只改色不改 alpha）", () => {
    const light = cssBlock(titleBarCss(), '.ws-titlebar[data-theme="light"]');
    expect(light.length).toBeGreaterThan(0);
    expect(light).toContain("--ws-tb-hover: rgba(0, 0, 0, 0.102);");
    expect(light).toContain("--ws-tb-active: rgba(0, 0, 0, 0.200);");
    expect(light).toContain("--ws-tb-inactive: rgba(0, 0, 0, 0.447);");
    expect(light).toContain("--ws-tb-disabled: rgba(0, 0, 0, 0.361);");
});

test("setActive 翻转 data-active，缺省按激活处理", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ bridge: recordingBridge(), document: doc });
    const root = bar.el as unknown as FakeElement;

    // 缺省必须是激活：新建窗口就是前台，写成 false 会让标题栏一开始是灰的
    expect(root.getAttribute("data-active")).toBe("true");
    expect(bar.isActive()).toBe(true);

    bar.setActive(false);
    expect(root.getAttribute("data-active")).toBe("false");
    expect(bar.isActive()).toBe(false);

    bar.setActive(true);
    expect(root.getAttribute("data-active")).toBe("true");
    expect(bar.isActive()).toBe(true);
});

test("初始 active: false 时一上来就是失焦态", () => {
    const doc = fakeDocument();
    const bar = mountTitleBar({ bridge: recordingBridge(), active: false, document: doc });
    expect((bar.el as unknown as FakeElement).getAttribute("data-active")).toBe("false");
    expect(bar.isActive()).toBe(false);
});

test("禁用的按钮不派发动作…", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];
    const maxBtn = controls?.children[1];

    bar.setEnabled("maximize", false);
    expect(maxBtn?.getAttribute("aria-disabled")).toBe("true");

    // …鼠标那条路已被 CSS 的 pointer-events: none 堵住，
    // 但键盘（Tab + Enter）仍会走到 click 处理器，所以这里也要拦。
    controls?.fire("click", {
        target: { closest: (sel: string) => (sel === "[data-act]" ? (maxBtn ?? null) : null) },
    });
    expect(bridge.calls).toEqual([]);

    bar.setEnabled("maximize", true);
    expect(maxBtn?.getAttribute("aria-disabled")).toBe("false");
    controls?.fire("click", {
        target: { closest: (sel: string) => (sel === "[data-act]" ? (maxBtn ?? null) : null) },
    });
    expect(bridge.calls).toEqual(["toggleMaximize"]);
});

test("禁用态与其它按钮互不影响", () => {
    const doc = fakeDocument();
    const bridge = recordingBridge();
    const bar = mountTitleBar({ bridge, document: doc });
    const controls = (bar.el as unknown as FakeElement).children[1];

    bar.setEnabled("maximize", false);
    // 最小化与关闭照旧
    const clickOn = (index: number): void => {
        const btn = controls?.children[index];
        controls?.fire("click", {
            target: { closest: (sel: string) => (sel === "[data-act]" ? (btn ?? null) : null) },
        });
    };
    clickOn(0);
    clickOn(2);
    expect(bridge.calls).toEqual(["minimize", "close"]);
});

test("禁用态在样式表里有对应规则（变淡 + 不吃指针）", () => {
    const css = titleBarCss();
    const disabled = cssBlock(css, '.ws-titlebar__btn[aria-disabled="true"]');
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled).toContain("color: var(--ws-tb-disabled);");
    expect(disabled).toContain("pointer-events: none;");
});

// ---------- 与 IPC 的桥接 ----------

test("bridgeFromWindowService 把四个方法原样转发", async () => {
    const calls: string[] = [];
    const bridge = bridgeFromWindowService({
        minimize: () => void calls.push("minimize"),
        toggleMaximize: async () => {
            calls.push("toggleMaximize");
        },
        close: () => void calls.push("close"),
        drag: () => void calls.push("drag"),
    });

    bridge.minimize();
    bridge.toggleMaximize();
    bridge.close();
    bridge.drag();
    // 异步实现也不该被等——标题栏是 fire-and-forget
    await Promise.resolve();
    expect(calls).toEqual(["minimize", "toggleMaximize", "close", "drag"]);
});
