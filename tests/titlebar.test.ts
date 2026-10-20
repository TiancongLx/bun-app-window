import { expect, test } from "bun:test";

import {
    bridgeFromWindowService,
    glyphFor,
    labelFor,
    mountTitleBar,
    TITLEBAR_GLYPHS,
    titleBarCss,
    type TitleBarBridge,
    type TitleBarDocument,
    type TitleBarElement,
} from "@/ui/titlebar";

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
        if (n.getAttribute("id") === "bunframe-titlebar-css") {
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
                closest: (sel: string) => (sel === "[data-act]" ? btn ?? null : null),
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
    const bar = mountTitleBar({ bridge: recordingBridge(), maximized: false, document: doc });
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
    const bar = mountTitleBar({ bridge: recordingBridge(), maximized: true, document: doc });
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
    expect(() => mountTitleBar({ bridge: recordingBridge() })).toThrow(
        "mountTitleBar: no document available",
    );
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
