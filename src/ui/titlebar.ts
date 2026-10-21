/**
 * titlebar.ts — Win 11 风格的应用标题栏
 *
 * 为什么是组件而不是壳的内建能力：窗口壳只负责一个窗口，标题栏属于应用外观。
 * 把外观内建进壳，等于替所有接入方做了审美决定；做成组件，接入方拿走的是一份
 * 已经调好的观感，改不改、怎么改都随它。
 *
 * 三条边界：
 *
 *   1. **不依赖 `bun-app-window` 的任何内部模块。** 窗口控制走注入的 `bridge`，
 *      因此这个组件也能用在 Electron / Tauri / 纯浏览器里。
 *   2. **不依赖 DOM 类型声明。** `tsconfig` 的 `lib` 只有 ESNext，这里自带一套
 *      最小的元素接口；运行时用真实的 DOM 对象，类型上按结构匹配。
 *   3. **不自己建连接。** 谁连 WebSocket 是应用的事，组件只调 `bridge`。
 *
 * 尺寸与配色取自 Win 11：标题栏 32px、按钮 46×32、关闭悬停 `#c42b1c`。
 * 全部颜色走 CSS 变量，覆盖 `--ws-tb-*` 即可换肤。
 */

/** 窗口控制通道。实现方决定它接到哪里（IPC / Electron / 直接调用） */
export type TitleBarBridge = {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    /** 开始一次原生窗口拖拽（含贴边分屏） */
    drag(): void;
};

/** 组件真正用到的最小元素接口，按结构匹配真实 DOM 元素 */
export type TitleBarElement = {
    className: string;
    textContent: string | null;
    readonly style: { setProperty(name: string, value: string): void };
    append(...nodes: TitleBarElement[]): void;
    appendChild(child: TitleBarElement): TitleBarElement;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    addEventListener(type: string, fn: (ev: never) => void): void;
    removeEventListener(type: string, fn: (ev: never) => void): void;
    remove(): void;
};

export type TitleBarDocument = {
    createElement(tag: string): TitleBarElement;
    body?: TitleBarElement;
    getElementById(id: string): TitleBarElement | null;
    querySelector(selector: string): TitleBarElement | null;
    /**
     * 可选：字体可用性探测，通常是 `document.fonts`。
     *
     * 缺省时 {@link detectIconSet} 按 `fluent` 处理（Win 10 / 11 都自带其中一个
     * icon 字体）。传了就按探测结果选字形，两个字体都不在时退回 `unicode`。
     */
    fonts?: TitleBarFonts;
};

type EventLike = {
    button?: number;
    target?: unknown;
    preventDefault?(): void;
};

export type TitleBarIconSet = "unicode" | "fluent";

/**
 * Win 11 caption 字形所用的字体栈。
 *
 * `Segoe Fluent Icons` 是 Win 11 的，`Segoe MDL2 Assets` 是 Win 10 的，
 * 而 `E921` / `E922` / `E923` / `E8BB` 这几个人码位在两者里**是同一个位置**——
 * 所以同一份码位在两代系统上都能正确显示。这一点是照着
 * `egoist/mygo` 的 `internal/windows/titlebar.go` 核实的：它同时支持 Win 10 / 11，
 * 用的就是这一份码位表，只换字体名。
 */
export const TITLEBAR_ICON_FONT_STACK = '"Segoe Fluent Icons", "Segoe MDL2 Assets"';

/**
 * 按钮字形。
 *
 * `unicode` 是几何符号，任何字体都有，零依赖，但**撑不满 em 框**——
 * 实测在 10px 字号下 `\u25A1` 的墨迹只有 5×4.5 逻辑 px，
 * 而 Win 11 的 caption 字形是 10×10。这是「字形看起来偏小」的根因，不是字号问题。
 *
 * `fluent` 是 Segoe Fluent Icons / Segoe MDL2 Assets 的私有区码位，字形填满 em 框，
 * 观感与 Win 11 原生一致。真正的风险只剩「两个字体都没有」的环境
 * （非 Windows 宿主、极旧系统），那时 PUA 码位会渲染成豆腐块——
 * 所以由 {@link detectIconSet} 探测，探测不到才退回 `unicode`。
 */
export const TITLEBAR_GLYPHS = {
    unicode: { minimize: "\u2500", maximize: "\u25A1", restore: "\u2750", close: "\u2715" },
    fluent: { minimize: "\uE921", maximize: "\uE922", restore: "\uE923", close: "\uE8BB" },
} as const;

/**
 * 只问一件事的字体探测接口（`document.fonts` 的结构子集）。
 *
 * 单独抽出来而不是直接依赖 `FontFaceSet`：组件刻意不依赖 DOM 类型声明
 * （`tsconfig` 的 `lib` 只有 ESNext），这一层最小接口既够用又能被测试注入。
 */
export type TitleBarFonts = {
    check(font: string): boolean;
};

/**
 * 选字形集：优先 `fluent`，两个 icon 字体都不在时才退化到 `unicode`。
 *
 * 没有探测能力（`fonts` 缺省）时按 `fluent` 处理——目标平台是 Windows，
 * Win 10 与 Win 11 都自带其中之一。冒险的只有「非 Windows 宿主 + 不传 fonts」，
 * 那本来也不是这个组件的目标场景。
 */
export function detectIconSet(fonts?: TitleBarFonts): TitleBarIconSet {
    if (!fonts) {
        return "fluent";
    }
    const hasFluent = fonts.check(`10px "Segoe Fluent Icons"`);
    const hasMdl2 = fonts.check(`10px "Segoe MDL2 Assets"`);
    return hasFluent || hasMdl2 ? "fluent" : "unicode";
}

/**
 * 取某个按钮当前该显示的字形。
 *
 * 最大化按钮在两种状态下是两个字形，这是标题栏最容易做错的一处：
 * 漏掉「已最大化」分支，用户就永远看到「最大化」图标。
 */
export function glyphFor(
    icons: TitleBarIconSet,
    action: "minimize" | "maximize" | "close",
    maximized: boolean,
): string {
    const set = TITLEBAR_GLYPHS[icons];
    if (action === "maximize") {
        return maximized ? set.restore : set.maximize;
    }
    return action === "minimize" ? set.minimize : set.close;
}

/** 最大/还原按钮的无障碍标签 */
export function labelFor(action: "minimize" | "maximize" | "close", maximized: boolean): string {
    if (action === "minimize") {
        return "最小化";
    }
    if (action === "close") {
        return "关闭";
    }
    return maximized ? "向下还原" : "最大化";
}

const STYLE_ID = "bun-app-window-titlebar-css";

/**
 * 组件样式。
 *
 * 用 `data-theme` 而非 media query 做主题开关：应用可能想让窗口主题与系统
 * 深色模式无关（例如跟随自己的设置项）。缺省值仍跟随 `prefers-color-scheme`。
 */
export function titleBarCss(): string {
    return `
.ws-titlebar {
    --ws-tb-height: 32px;
    --ws-tb-bg: #202020;
    --ws-tb-fg: #ffffff;
    --ws-tb-dim: rgba(255, 255, 255, 0.786);
    /* ---- 五个状态 ----------------------------------------------------------
       Win 11 的 caption 背板是「前景色 + 一份 alpha」，不是固定灰；
       数值取自 Windows 自己的实现，与 egoist/mygo 的
       internal/windows/titlebar.go（colors()）一致：hover 0x1A、pressed 0x33。
       旧值 0.0605 / 0.0419 偏淡到几乎看不见悬停。
       失焦只降字形（0x72），禁用再降一档（0x5C）；hot / pressed 优先于失焦。 */
    --ws-tb-hover: rgba(255, 255, 255, 0.102);
    --ws-tb-active: rgba(255, 255, 255, 0.200);
    --ws-tb-close-hover: #c42b1c;
    --ws-tb-close-active: #b02a1c;
    --ws-tb-inactive: rgba(255, 255, 255, 0.447);
    --ws-tb-disabled: rgba(255, 255, 255, 0.361);
    /* 字形当前色。做成自定义属性而不是直接写 color，
       这样「失焦变淡」与「hover 恢复满强度」可以靠继承关系表达，
       不必给 hover 规则堆特异性去压过 [data-active="false"]。 */
    --ws-tb-btn-fg: var(--ws-tb-fg);
    --ws-tb-border: rgba(255, 255, 255, 0.08);

    display: flex;
    align-items: stretch;
    height: var(--ws-tb-height);
    background: var(--ws-tb-bg);
    color: var(--ws-tb-fg);
    font: 400 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    /* 下面四条**必须显式声明**。
       挂载点是 <header>，而消费方常写元素选择器「header { padding: ... }」做自己的页头。
       元素选择器的特异性低于类选择器，但只在组件**声明了**该属性时才被压住——
       没写的属性等于把控制权交给消费方。
       实测（baw-mvp）：它的「header { padding: 12px 18px 10px }」漏进来，
       18px 右内边距把三个按钮整体推左 18 CSS px（@192dpi = 36 物理 px），
       12/10 的上下内边距又把 32px 的标题栏压成 9px 内容高，按钮跟着缩到 18 物理 px。
       两者合起来看起来像「字形没有居中」，而字形在按钮内其实是居中的。 */
    margin: 0;
    padding: 0;
    gap: 0;
    border-bottom: 1px solid var(--ws-tb-border);
    box-sizing: border-box;
}

.ws-titlebar[data-theme="light"] {
    --ws-tb-bg: #f3f3f3;
    --ws-tb-fg: #000000;
    --ws-tb-dim: rgba(0, 0, 0, 0.6063);
    --ws-tb-hover: rgba(0, 0, 0, 0.102);
    --ws-tb-active: rgba(0, 0, 0, 0.200);
    --ws-tb-inactive: rgba(0, 0, 0, 0.447);
    --ws-tb-disabled: rgba(0, 0, 0, 0.361);
    --ws-tb-border: rgba(0, 0, 0, 0.0578);
}

/* 窗口失焦：只降字形，背板照旧（hover / pressed 仍然优先，见下） */
.ws-titlebar[data-active="false"] {
    --ws-tb-btn-fg: var(--ws-tb-inactive);
}

.ws-titlebar__lead {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-inline-start: 12px;
    min-width: 0;
    flex: 1;
    cursor: default;
}

.ws-titlebar__icon {
    width: 16px;
    height: 16px;
    object-fit: contain;
    flex: none;
}

.ws-titlebar__icon[hidden] { display: none; }

.ws-titlebar__title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ws-tb-fg);
}

.ws-titlebar__controls {
    display: flex;
    align-items: stretch;
    flex: none;
}

/* ---- 原生 caption（FLAG_NATIVE_CAPTIONS）----------------------------------
   三个按钮由壳层画在一个 layered 子窗口里、盖在窗口右上角。页面这边要做的唯一
   一件事是**把位置留出来**——否则标题文字会被那层子窗口压住。
   宽度是 46 × 3，与 .ws-titlebar__btn 的 width 同源（后者由
   tests/types.test.ts 钉在 CAPTION_BUTTON_WIDTH 上）。
   为什么不用 padding 而是给控件容器定宽：按钮区是「贴住客户区右边缘」的，
   用容器定宽更直白，也不会与标题栏自己的 padding 相互影响。 */
.ws-titlebar[data-captions="native"] .ws-titlebar__controls {
    width: calc(46px * 3);
}

.ws-titlebar__btn {
    width: 46px;
    height: 100%;
    /* margin 必须显式清零：消费方常写「button { margin: ... }」之类，
       元素选择器只在组件没声明该属性时生效。与 .ws-titlebar 那一组同理。 */
    margin: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--ws-tb-btn-fg);
    font: inherit;
    /* Win 11 的 caption 字形是 10 DIP。在这个字号下，
       Fluent 图标字体把 10×10 逻辑 px 填满（实测墨迹填满 em 框），
       而几何符号的墨迹只占 5×4.5——所以换字体才是「字形偏小」的解。 */
    font-size: 10px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: default;
    border-radius: 0;
}

.ws-titlebar__btn:hover { background: var(--ws-tb-hover); color: var(--ws-tb-fg); }
.ws-titlebar__btn:active { background: var(--ws-tb-active); color: var(--ws-tb-fg); }

.ws-titlebar__btn--close:hover { background: var(--ws-tb-close-hover); color: #ffffff; }
.ws-titlebar__btn--close:active { background: var(--ws-tb-close-active); color: #ffffff; }

.ws-titlebar__btn:focus-visible {
    outline: 1px solid var(--ws-tb-fg);
    outline-offset: -2px;
}

/* 禁用：字形再淡一档，且不响应悬停 / 按下。Win 11 用 aria-disabled 语义即可，
   不必另造一个属性名。 */
.ws-titlebar__btn[aria-disabled="true"] {
    color: var(--ws-tb-disabled);
    pointer-events: none;
}
.ws-titlebar__btn[aria-disabled="true"]:hover,
.ws-titlebar__btn[aria-disabled="true"]:active {
    background: transparent;
    color: var(--ws-tb-disabled);
}

.ws-titlebar[data-icons="fluent"] .ws-titlebar__btn {
    font-family: ${TITLEBAR_ICON_FONT_STACK}, sans-serif;
    /* 图标字体的字形是等宽方框，不要被消费方的 letter-spacing 拉开 */
    letter-spacing: 0;
}
`.trim();
}

export type TitleBarOptions = {
    /** 窗口标题 */
    title?: string;
    /** 图标 URL。不给则隐藏图标位 */
    icon?: string;
    /** 窗口控制通道 */
    bridge: TitleBarBridge;
    /** 初始是否已最大化 */
    maximized?: boolean;
    /** 窗口初始是否处于激活状态（决定字形是否变淡）。缺省 `true` */
    active?: boolean;
    /** 按钮字形，缺省由 {@link detectIconSet} 按字体可用性决定（通常 `fluent`） */
    icons?: TitleBarIconSet;
    /**
     * 三个 caption 按钮由谁画。
     *
     * - `"dom"`（缺省）：组件自己渲染按钮，行为完全由 `bridge` 决定
     * - `"native"`：**不渲染按钮**，只在右侧留出 `46 × 3` 的空白，
     *   由壳层的 `FLAG_NATIVE_CAPTIONS` 把按钮画上去
     *
     * 什么时候要 `"native"`：需要 Snap Layouts 的时候。`WM_NCHITTEST` 走光标下
     * 最深那层，而 WebView2 的渲染子窗口在**别的进程**里、返回 `HTCLIENT`，
     * 页面画的按钮永远拿不到 `HTMAXBUTTON`（`pitfalls` 2.14）。壳层会盖一个
     * 自己的子窗口在按钮位置上，命中就落在壳层手里。
     *
     * 两者必须配套：壳层开了 `FLAG_NATIVE_CAPTIONS` 而这里仍用 `"dom"`，
     * 会看到两套按钮叠在一起；反过来则是一块点不到的空区。
     */
    captions?: "dom" | "native";
    /** 主题，缺省跟随 `prefers-color-scheme` */
    theme?: "light" | "dark";
    /** 挂载容器，缺省 `document.body` */
    container?: TitleBarElement;
    /** 覆盖文档对象（测试或特殊宿主用） */
    document?: TitleBarDocument;
};

export type TitleBarHandle = {
    readonly el: TitleBarElement;
    setTitle(title: string): void;
    setMaximized(maximized: boolean): void;
    /** 组件最后一次被设置的最大化状态。用于核对与宿主推送是否同步 */
    isMaximized(): boolean;
    /**
     * 窗口是否处于激活（聚焦）状态。失焦时字形降到 45% 不透明度，
     * 这是 Win 11 与「永远满强度」的一处可见差别。
     *
     * 接 `windowState` 推送里的 `focused`：用户点别的窗口时它会变，
     * 页面自己看不到这件事。
     */
    setActive(active: boolean): void;
    /** 组件最后一次被设置的激活状态 */
    isActive(): boolean;
    /**
     * 按 Win 11 的规则禁用某个按钮。
     *
     * 用途是「这个窗口不能最大化」这类情形——禁用后字形变淡、且不再派发动作。
     * 用 `aria-disabled` 而不是另造属性：它同时是给辅助技术的语义。
     */
    setEnabled(action: "minimize" | "maximize" | "close", enabled: boolean): void;
    setTheme(theme: "light" | "dark"): void;
    /** 移除 DOM 与事件监听。样式表保留（可能是别的实例注入的） */
    destroy(): void;
};

function resolveDocument(doc?: TitleBarDocument): TitleBarDocument {
    // 双层断言是必需的，不是笔误：消费者 tsconfig 的 `lib` 含 `DOM` 时，
    // `globalThis.document` 是完整的 `Document`，与本组件的极简结构不重叠，
    // 单层 `as` 会被判成 TS2352「两侧类型不够重叠」。`skipLibCheck` 挡不住——
    // 这是包内 `.ts` 源码，不是 `.d.ts`。本仓 tsconfig 的 lib 只有 ESNext，
    // 这个错在本仓永远复现不出来，判据落在 tests/titlebar.test.ts 的源码断言上。
    const found = doc ?? (globalThis as unknown as { document?: TitleBarDocument }).document;
    if (!found) {
        throw new Error("mountTitleBar: no document available; pass options.document");
    }
    return found;
}

/** 事件目标是否落在控件区（点按钮时不能触发窗口拖拽） */
function inControls(target: unknown): boolean {
    const node = target as { closest?: (selector: string) => unknown } | null | undefined;
    if (!node || typeof node.closest !== "function") {
        return false;
    }
    return node.closest("[data-ws-tb-controls]") !== null;
}

/**
 * 挂载标题栏，返回可更新状态的句柄。
 *
 * ```ts
 * const bar = mountTitleBar({
 *     title: "我的应用",
 *     icon: "/icon.svg",
 *     bridge: {
 *         minimize: () => void api.window.minimize(),
 *         toggleMaximize: () => void api.window.toggleMaximize(),
 *         close: () => void api.window.close(),
 *         drag: () => void api.window.drag(),
 *     },
 * });
 *
 * api.on("windowState", (s) => bar.setMaximized(s.maximized));
 * ```
 */
export function mountTitleBar(opts: TitleBarOptions): TitleBarHandle {
    const doc = resolveDocument(opts.document);
    // 缺省按字体探测：Win 10 / 11 都有 icon 字体，看到的就是原生字形；
    // 两个都没有才退回几何符号（`unicode`）。
    const icons: TitleBarIconSet = opts.icons ?? detectIconSet(doc.fonts);

    // 样式只注入一次。多个标题栏实例（多窗口页面）共用同一份
    if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.setAttribute("id", STYLE_ID);
        style.textContent = titleBarCss();
        doc.body?.appendChild(style);
    }

    const root = doc.createElement("header");
    root.className = "ws-titlebar";
    root.setAttribute("data-icons", icons);
    // 缺省按激活处理：窗口刚创建时就是前台，写成 false 会让标题栏一开始是灰的。
    root.setAttribute("data-active", opts.active === false ? "false" : "true");
    // 原生 caption 模式：不渲染按钮，只在右侧留位（CSS 按这个属性选择器定宽）。
    // 属性只在 native 时出现，所以缺省形态的 DOM 与引入本位之前**逐字相同**。
    const nativeCaptions = opts.captions === "native";
    if (nativeCaptions) {
        root.setAttribute("data-captions", "native");
    }
    if (opts.theme) {
        root.setAttribute("data-theme", opts.theme);
    }
    if (opts.title !== undefined) {
        root.setAttribute("title", opts.title);
    }

    const lead = doc.createElement("div");
    lead.className = "ws-titlebar__lead";

    const icon = doc.createElement("img");
    icon.className = "ws-titlebar__icon";
    icon.setAttribute("alt", "");
    if (opts.icon) {
        icon.setAttribute("src", opts.icon);
    } else {
        icon.setAttribute("hidden", "");
    }

    const title = doc.createElement("span");
    title.className = "ws-titlebar__title";
    title.textContent = opts.title ?? "";

    lead.append(icon, title);

    const controls = doc.createElement("div");
    controls.className = "ws-titlebar__controls";
    controls.setAttribute("data-ws-tb-controls", "");

    const buttons: Partial<Record<"minimize" | "maximize" | "close", TitleBarElement>> = {};
    // `captions: "native"` 时一个按钮都不建：那三个由壳层的 layered 子窗口画，
    // 页面上再画一份就是两套叠在一起。控件容器仍然保留——它是「留位」的载体
    // （CSS 给它 46×3 的宽度），也是拖拽判定里 `inControls` 的锚点。
    if (!nativeCaptions) {
        for (const action of ["minimize", "maximize", "close"] as const) {
            const btn = doc.createElement("button");
            btn.className =
                action === "close" ? "ws-titlebar__btn ws-titlebar__btn--close" : "ws-titlebar__btn";
            btn.setAttribute("type", "button");
            btn.setAttribute("data-act", action);
            btn.textContent = glyphFor(icons, action, opts.maximized === true);
            btn.setAttribute("aria-label", labelFor(action, opts.maximized === true));
            buttons[action] = btn;
            controls.appendChild(btn);
        }
    }

    root.append(lead, controls);

    let maximizedState = opts.maximized === true;

    const applyMaximized = (next: boolean): void => {
        maximizedState = next;
        const btn = buttons.maximize;
        if (!btn) {
            return;
        }
        btn.textContent = glyphFor(icons, "maximize", next);
        btn.setAttribute("aria-label", labelFor("maximize", next));
    };

    /** 当前是否最大化。供调用方在本地校验状态是否同步 */
    const isMaximized = (): boolean => maximizedState;

    let activeState = opts.active !== false;

    /** 当前是否处于激活状态 */
    const isActive = (): boolean => activeState;

    const applyActive = (next: boolean): void => {
        activeState = next;
        root.setAttribute("data-active", next ? "true" : "false");
    };

    const applyEnabled = (action: "minimize" | "maximize" | "close", enabled: boolean): void => {
        const btn = buttons[action];
        if (!btn) {
            return;
        }
        btn.setAttribute("aria-disabled", enabled ? "false" : "true");
    };

    const onPointerDown = (ev: EventLike): void => {
        if (ev.button !== undefined && ev.button !== 0) {
            return;
        }
        if (inControls(ev.target)) {
            return;
        }
        ev.preventDefault?.();
        opts.bridge.drag();
    };

    const onDoubleClick = (ev: EventLike): void => {
        if (inControls(ev.target)) {
            return;
        }
        opts.bridge.toggleMaximize();
    };

    const onControlsClick = (ev: EventLike): void => {
        const node = ev.target as { closest?: (s: string) => { getAttribute(n: string): string | null } | null } | null;
        const btn = typeof node?.closest === "function" ? node.closest("[data-act]") : null;
        // 禁用的按钮不派发动作。CSS 已经用 pointer-events: none 拦住鼠标，
        // 但键盘（Tab 到按钮上按 Enter/Space）仍会走到这里，所以判定必须在这里也做一次。
        if (btn?.getAttribute("aria-disabled") === "true") {
            return;
        }
        const act = btn?.getAttribute("data-act");
        if (act === "minimize") {
            opts.bridge.minimize();
        } else if (act === "maximize") {
            opts.bridge.toggleMaximize();
        } else if (act === "close") {
            opts.bridge.close();
        }
    };

    root.addEventListener("pointerdown", onPointerDown as (ev: never) => void);
    root.addEventListener("dblclick", onDoubleClick as (ev: never) => void);
    controls.addEventListener("click", onControlsClick as (ev: never) => void);

    const container = opts.container ?? doc.body;
    if (!container) {
        throw new Error("mountTitleBar: no container and document.body is missing");
    }
    container.appendChild(root);

    return {
        get el(): TitleBarElement {
            return root;
        },
        setTitle(next: string): void {
            title.textContent = next;
            root.setAttribute("title", next);
        },
        setMaximized: applyMaximized,
        isMaximized,
        setActive: applyActive,
        isActive,
        setEnabled: applyEnabled,
        setTheme(theme: "light" | "dark"): void {
            root.setAttribute("data-theme", theme);
        },
        destroy(): void {
            root.removeEventListener("pointerdown", onPointerDown as (ev: never) => void);
            root.removeEventListener("dblclick", onDoubleClick as (ev: never) => void);
            controls.removeEventListener("click", onControlsClick as (ev: never) => void);
            root.remove();
        },
    };
}

/**
 * 便利函数：把 `bun-app-window/ipc` 的客户端包成 `TitleBarBridge`。
 *
 * 传进来的服务需要暴露四个方法（见 `WindowService`）。单独做成函数而不是
 * 让 `mountTitleBar` 自己认 IPC，是为了让组件与控制通道保持解耦。
 */
export type WindowService = {
    minimize(): Promise<unknown> | unknown;
    toggleMaximize(): Promise<unknown> | unknown;
    close(): Promise<unknown> | unknown;
    drag(): Promise<unknown> | unknown;
};

export function bridgeFromWindowService(service: WindowService): TitleBarBridge {
    return {
        minimize: () => {
            void service.minimize();
        },
        toggleMaximize: () => {
            void service.toggleMaximize();
        },
        close: () => {
            void service.close();
        },
        drag: () => {
            void service.drag();
        },
    };
}
