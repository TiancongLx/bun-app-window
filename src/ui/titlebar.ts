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
};

type EventLike = {
    button?: number;
    target?: unknown;
    preventDefault?(): void;
};

export type TitleBarIconSet = "unicode" | "fluent";

/**
 * 按钮字形。
 *
 * `unicode` 是几何符号，任何字体都有，零依赖；
 * `fluent` 是 Segoe Fluent Icons 的私有区码位，观感更接近 Win 11 原生，
 * 但该字体缺失时会显示成豆腐块——所以不是默认值。
 */
export const TITLEBAR_GLYPHS = {
    unicode: { minimize: "\u2500", maximize: "\u25A1", restore: "\u2750", close: "\u2715" },
    fluent: { minimize: "\uE921", maximize: "\uE922", restore: "\uE923", close: "\uE8BB" },
} as const;

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
    --ws-tb-hover: rgba(255, 255, 255, 0.0605);
    --ws-tb-active: rgba(255, 255, 255, 0.0419);
    --ws-tb-close-hover: #c42b1c;
    --ws-tb-close-active: #b02a1c;
    --ws-tb-border: rgba(255, 255, 255, 0.08);

    display: flex;
    align-items: stretch;
    height: var(--ws-tb-height);
    background: var(--ws-tb-bg);
    color: var(--ws-tb-fg);
    font: 400 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    border-bottom: 1px solid var(--ws-tb-border);
    box-sizing: border-box;
}

.ws-titlebar[data-theme="light"] {
    --ws-tb-bg: #f3f3f3;
    --ws-tb-fg: #000000;
    --ws-tb-dim: rgba(0, 0, 0, 0.6063);
    --ws-tb-hover: rgba(0, 0, 0, 0.0373);
    --ws-tb-active: rgba(0, 0, 0, 0.0241);
    --ws-tb-border: rgba(0, 0, 0, 0.0578);
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

.ws-titlebar__btn {
    width: 46px;
    height: 100%;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--ws-tb-dim);
    font: inherit;
    font-size: 10px;
    line-height: 1;
    display: grid;
    place-items: center;
    cursor: default;
    border-radius: 0;
}

.ws-titlebar__btn:hover { background: var(--ws-tb-hover); color: var(--ws-tb-fg); }
.ws-titlebar__btn:active { background: var(--ws-tb-active); }

.ws-titlebar__btn--close:hover { background: var(--ws-tb-close-hover); color: #ffffff; }
.ws-titlebar__btn--close:active { background: var(--ws-tb-close-active); color: #ffffff; }

.ws-titlebar__btn:focus-visible {
    outline: 1px solid var(--ws-tb-fg);
    outline-offset: -2px;
}

.ws-titlebar[data-icons="fluent"] .ws-titlebar__btn {
    font-family: "Segoe Fluent Icons", "Segoe MDL2 Assets", sans-serif;
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
    /** 按钮字形，默认 `unicode` */
    icons?: TitleBarIconSet;
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
    const icons: TitleBarIconSet = opts.icons ?? "unicode";

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
