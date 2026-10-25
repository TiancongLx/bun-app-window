/**
 * types.ts — 内核的公共类型与常量
 *
 * 这里的类型是**稳定面**：改动需要按语义化版本对待。
 * 调试自省类能力单独放在 Shell["debug"] 下，不视为稳定契约。
 *
 * ## 这个文件必须保持「零 import」
 *
 * 它是 `bun-app-window/types` 子路径的全部内容，而开这个子路径的目的是让
 * **页面侧代码也能 import 这些常量**：主入口 `./index` 从 `./native` 导入
 * `bun:ffi`，浏览器 bundle 解析不了，所以页面过去只能把位值手抄一遍
 * （`BROWSER_UI_*` 抄 5 条、缩放阶梯抄 14 档、边框索引抄 8 条），抄漏抄错
 * 都不会被任何门禁抓到。
 *
 * 因此本文件只允许出现 `export const` / `export type` / `export function`
 * 形式的纯声明，**不得出现任何 `import`**——一旦有了，子路径就不再是浏览器安全的。
 * `tests/types-purity.test.ts` 用一条静态断言守住这条。
 */

/** 无边框：原生层不画标题栏与边框，由页面自绘 */
export const FLAG_FRAMELESS = 1;
/** 置顶 */
export const FLAG_TOPMOST = 2;
/**
 * 启动时把窗口居中到所在显示器的工作区（避开任务栏）。
 *
 * 带边框与无边框两种模式都生效。窗口比工作区大时会先收缩到工作区内再居中——
 * 高 DPI 下这很常见（900×940 逻辑像素在 200% 缩放加边框就是 1950 物理像素高，
 * 超过 1824 的工作区），不收缩只能贴顶，垂直方向看不出居中。
 */
export const FLAG_CENTER = 4;
/** 可缩放（配合无边框时，边框拖拽区由 shell_begin_resize 提供） */
export const FLAG_RESIZABLE = 8;
/**
 * 创建后先不显示，等调用方确认页面就绪再 `shell.show()`。
 * 用于消除「空窗口先出现、内容后填上」的首帧闪烁。
 */
export const FLAG_DEFER_SHOW = 16;
/**
 * 接受文件/文件夹拖放。
 *
 * 落进来的路径以 shell-msg 推送：`{ t: "drop", paths: ["C:\\a", "C:\\b"] }`。
 * 提权进程（High 完整性）需要放行 UIPI，壳已用 `ChangeWindowMessageFilterEx`
 * 处理；否则资源管理器拖过来的消息会被静默拦掉。
 */
export const FLAG_ACCEPT_DROP = 32;
/**
 * 首次显示时直接以最大化出现。
 *
 * 不要用「先 show() 再 toggleMaximize()」代替：那会有一次「小窗闪一下再撑满」
 * 的跳变。本项把最大化合成到显示的那一次 `ShowWindow`，窗口从隐藏直接变成
 * 最大化，中间没有可见帧。
 *
 * 与 `FLAG_CENTER` 同时给时以本项为准（最大化会覆盖位置）。
 */
export const FLAG_START_MAXIMIZED = 64;
/**
 * 允许页面把顶层框架导航到任意 http/https 地址，即**放弃外部导航拦截**。
 *
 * 默认（不给本位）时，壳会拦下跨源导航并改交系统默认浏览器：桌面应用没有地址栏、
 * 没有后退按钮，也没有宿主 API 能把页面拉回来，一次误点外链就等于应用被换成了那个
 * 网站。这是默认值应该选安全一侧的典型场景。
 *
 * 什么时候需要本位：应用本身就是浏览器（多标签、内置地址栏、能自己导航回来）。
 *
 * 边界（两条，别指望它能关掉更多）：
 *
 * - **只影响顶层框架导航**。`window.open` / `target=_blank` 仍然被拦下并外开，
 *   因为壳只支持一个顶层窗口（原生层是进程级单例），开出来的新窗口没有任何宿主
 *   API 能管它。这是能力边界，不是安全策略。
 * - **不放宽 scheme 白名单**。交给系统浏览器的只有 http/https；`file:`、
 *   `javascript:`、`ms-*:` 以及自定义 scheme 一律静默取消，与本位无关。
 */
export const FLAG_ALLOW_EXTERNAL_NAV = 128;
/**
 * 顶部让出一条给自绘标题栏：把 WebView2 的容器子窗口整体下移 caption 高度（32 逻辑像素）。
 *
 * ## 为什么需要它（命中测试的硬约束，不是布局偏好）
 *
 * WebView2 的容器子窗口（widget）铺满整个客户区，它内部还有三层 Chrome 窗口，
 * 而**真实鼠标的 `WM_NCHITTEST` 走光标下最深那层**：
 *
 * ```text
 * webview_widget → Chrome_WidgetWin_0 → Chrome_WidgetWin_1
 * → Chrome_RenderWidgetHostHWND → Intermediate D3D Window
 * ```
 *
 * 后三层在**别的进程**里（实测 pid 各不相同），`SetWindowLongPtr` 够不着，
 * 所以「把 `HTTRANSPARENT` 一路传上去」这条子类化路线走不通。它们返回 `HTCLIENT`，
 * 顶层窗口那套 `HTMAXBUTTON` 逻辑永远没机会被问到——**Snap Layouts 因此不弹**。
 *
 * 让 widget 别盖住标题栏，光标就落在顶层窗口自己身上，命中测试正常走到
 * `hit_test_client` → `caption_button_at` → `HTMAXBUTTON`。
 *
 * ## 什么时候该给
 *
 * 只在**自绘标题栏**、而且标题栏真的在客户区顶部时。无边框不等于要自绘标题栏：
 * 有的应用整窗都是内容区，无条件让位会在顶部留一条点不到的死区。
 *
 * ## 与 `FLAG_FRAMELESS` 的关系
 *
 * 本位只在 `FLAG_FRAMELESS` 同时给出时生效——带边框模式的标题栏由系统画，
 * widget 本来就在客户区内，不存在遮挡。
 */
export const FLAG_TITLEBAR_RESERVE = 256;

/**
 * 在客户区右上角盖一层**原生绘制**的 caption 按钮（关闭 / 最大化 / 最小化）。
 *
 * ## 它解决的是「页面拿不到 Snap Layouts」
 *
 * `WM_NCHITTEST` 走光标下最深那层，而 WebView2 的渲染子窗口在**别的进程**里、
 * 返回 `HTCLIENT`，光标的查询根本到不了顶层窗口（`pitfalls` 2.14 的实测链）。
 * 盖一个壳层自己的 layered 子窗口在按钮位置上，命中就落在壳层手里，
 * `HTMAXBUTTON` 才生效，Snap 面板才会弹。
 *
 * ## 它与 `FLAG_TITLEBAR_RESERVE` 是**替代关系**，不要同时给
 *
 * `TITLEBAR_RESERVE` 的做法是把 WebView2 的容器子窗口整体下移 caption 高度，
 * 让光标落到顶层窗口。那条路实测也能让 Snap 弹，但它把页面内容整体下移 32 逻辑
 * 像素，而 caption 命中区固定在客户区 `y ∈ [0, 32)` —— 页面自己画的标题栏会与
 * 命中区**错位 32px**，想对齐只能给页面负偏移，那已经出了 widget 客户区、
 * 被子窗口裁掉。所以「HTML 画标题栏 + 让位」在几何上不成立。
 *
 * 本位不动布局：子窗口只是**盖在**按钮位置上，页面该怎么排还怎么排，
 * 缩放边框也不受影响。
 *
 * ## 消费方要配合的一件事
 *
 * 用了本位就别再让页面画那三个按钮了，改由壳层画；页面的标题栏要在右侧留出
 * `CAPTION_BUTTON_WIDTH * 3` 的空白（`mountTitleBar` 的 `captions: "native"`
 * 就是做这件事的）。否则会看到两套按钮叠在一起。
 *
 * 只在 `FLAG_FRAMELESS` 同时给出时生效——带边框模式的标题栏由系统画。
 */
export const FLAG_NATIVE_CAPTIONS = 512;

/**
 * 关闭 WebView2 的浏览器行为（`ShellOptions.browserUi` 使用）。
 *
 * WebView2 默认是**浏览器**语义：右键弹 Edge 菜单、Ctrl+P 打印网页、左下角跳状态栏、
 * 触控板横滑前进后退、表单自动填充。这些在浏览器里都对，在桌面应用里每一条都是
 * 「这是个网页」的破绽。位定义与原生 `ShellBrowserUi` 逐位一致。
 */
export const BROWSER_UI_MENU = 1;
export const BROWSER_UI_KEYS = 2;
export const BROWSER_UI_STATUSBAR = 4;
export const BROWSER_UI_SWIPE = 8;
export const BROWSER_UI_AUTOFILL = 16;

/** 一次性关掉全部浏览器行为。桌面应用通常要这个。 */
export const BROWSER_UI_ALL =
    BROWSER_UI_MENU | BROWSER_UI_KEYS | BROWSER_UI_STATUSBAR | BROWSER_UI_SWIPE | BROWSER_UI_AUTOFILL;

/**
 * 缩放边框的 8 个命中边，取值与 Win32 HT* 常量一致。
 *
 * 这是 `Shell.beginResize()` 的**入参取值**。传 `RESIZE_EDGE.LEFT` 即可。
 *
 * 历史（0.6.0 修正）：原生 `shell_begin_resize()` 收的是内部数组下标 0–7，
 * 而本位定义是 HT* 常量 10–17，两者差一个**非线性**映射——
 *
 * ```c
 * static const WPARAM codes[8] = {HTLEFT, HTRIGHT, HTTOP, HTBOTTOM,
 *                                 HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT};
 * ```
 *
 * 注意 `HTTOPLEFT`(13) 在下标 4、`HTBOTTOM`(15) 在下标 3：既不是恒等也不是减 10。
 * 0.5.x 里 `beginResize` 的注释写「取 RESIZE_EDGE 的值」而实现直传下标，
 * 照注释写必然被 `edge > 7` 拒掉（`rc=-1`，表现是「点了没反应」）。0.6.0 起由
 * `Shell.beginResize()` 在 TS 层查表转换，本常量成为真正的入参契约。
 */
export const RESIZE_EDGE = {
    LEFT: 10,
    RIGHT: 11,
    TOP: 12,
    TOPLEFT: 13,
    TOPRIGHT: 14,
    BOTTOM: 15,
    BOTTOMLEFT: 16,
    BOTTOMRIGHT: 17,
} as const;

export type ResizeEdge = (typeof RESIZE_EDGE)[keyof typeof RESIZE_EDGE];

/**
 * `RESIZE_EDGE` 的 HT* 值 → 原生 `codes[]` 的**数组下标**。
 *
 * 顺序必须与 `native/shell.cc` 里那张表逐项一致：
 *
 * ```c
 * static const WPARAM codes[8] = {HTLEFT, HTRIGHT, HTTOP, HTBOTTOM,
 *                                 HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT};
 * ```
 *
 * **它既不是恒等也不是 `value - 10`**：`HTTOPLEFT`=13 落在下标 4、`HTBOTTOM`=15
 * 落在下标 3。`tests/types.test.ts` 有一条断言逐项钉住这张表。
 *
 * 消费者一般不需要它——`Shell.beginResize()` 已经替你查表了。放在公共面是因为
 * 它属于「协议的另一半」，逃生机 `shell.symbols.shell_begin_resize()` 要直连原生
 * 时需要它，而那种时候手写映射必然抄错。
 */
export const RESIZE_INDEX: Readonly<Record<number, number>> = {
    [RESIZE_EDGE.LEFT]: 0,
    [RESIZE_EDGE.RIGHT]: 1,
    [RESIZE_EDGE.TOP]: 2,
    [RESIZE_EDGE.BOTTOM]: 3,
    [RESIZE_EDGE.TOPLEFT]: 4,
    [RESIZE_EDGE.TOPRIGHT]: 5,
    [RESIZE_EDGE.BOTTOMLEFT]: 6,
    [RESIZE_EDGE.BOTTOMRIGHT]: 7,
};

/**
 * HT* 值 → 下标；不认识的值返回 -1。
 *
 * 返回 -1 而不是抛错：原生 `shell_begin_resize()` 用 `edge < 0` 把它当场拒掉并回
 * `rc=-1`，与「窗口已销毁」是同一个外部表现，调用方按 `rc` 处理即可。
 */
export function resizeIndex(edge: number): number {
    return RESIZE_INDEX[edge] ?? -1;
}

/**
 * 缩放阶梯，与原生 `native/shell.cc` 的 `kZoomLadder` 逐档一致。
 *
 * 原生侧 `apply_zoom` 只把入参夹到首尾两档（0.25 ~ 3.0），不吸附中间档——
 * 传任意值都能生效。这份表是给「按档位走」的界面用的：`−` / `+` 要按相邻档
 * 跳，而档位表属于两边都要知道的常量。
 *
 * 过去消费者只能自己抄一份（抄了 14 个数，没有任何门禁能发现它与 C++ 漂移）。
 */
export const ZOOM_LADDER = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] as const;

/** 缩放倍率的上下限（`ZOOM_LADDER` 的首尾两项） */
export const ZOOM_MIN = ZOOM_LADDER[0];
export const ZOOM_MAX = ZOOM_LADDER[ZOOM_LADDER.length - 1];

/**
 * 自绘标题栏的几何规格（**逻辑像素**，96 DPI 基准）。
 *
 * 这两个值有**三处**副本，`tests/types.test.ts` 用判据把它们钉在一起：
 *
 * | 处 | 用途 | 为什么不能省 |
 * | --- | --- | --- |
 * | 这里 | 页面侧布局与命中测试的共同事实源 | 页面要按它画，原生要按它算 |
 * | `src/ui/titlebar.ts` 的 CSS | 视觉尺寸 | 页面真正渲染的是 CSS |
 * | `native/shell.cc` 的 `kCaptionBarHeight` / `kCaptionButtonWidth` | `WM_NCHITTEST` 命中区 | C++ 无法 import TS |
 *
 * 为什么必须一致：`HTMAXBUTTON` 是「悬停弹 Snap Layouts」的**唯一**触发条件
 * （微软文档明写 Win32 应用要返回它）。命中区与视觉按钮错位，表现为
 * 「悬停位置偏了才弹」或「悬停不弹」——两种都极难从现象反推回常量。
 *
 * 规格取自 Win 11：标题栏 32 px、caption button 46×32。
 */
export const CAPTION_BAR_HEIGHT = 32;
export const CAPTION_BUTTON_WIDTH = 46;

/**
 * 从右往左的三个 caption button，与 Win 11 的顺序一致。
 *
 * 顺序不是审美选择：`close` 贴右上角，`maximize` 在它左边，`minimize` 再左。
 * `WM_NCHITTEST` 按这个顺序算矩形，页面 CSS 也按这个顺序排 DOM。
 */
export const CAPTION_BUTTONS = ["close", "maximize", "minimize"] as const;

/** `CAPTION_BUTTONS` 的成员名 */
export type CaptionButton = (typeof CAPTION_BUTTONS)[number];

/** window state 位掩码（与原生 shell_get_state 一致） */
export const STATE_MAXIMIZED = 1;
export const STATE_MINIMIZED = 2;
export const STATE_FOCUSED = 4;

export type WindowState = {
    raw: number;
    maximized: boolean;
    minimized: boolean;
    focused: boolean;
    /** 系统当前是否深色（原生侧读 AppsUseLightTheme，并随 WM_SETTINGCHANGE 刷新） */
    dark: boolean;
};

/** 原生库的解析结果 */
export type NativeLibInfo = {
    path: string;
    /**
     * explicit  — 调用方显式指定
     * dev       — 本仓开发态（build/ 或 dist/）
     * package   — 包内 dist/ 或可执行文件同级
     * embedded  — 从编译产物内嵌字节释放
     * fallback-tmp — 受限环境下退回 Bun 默认释放
     */
    source: "explicit" | "dev" | "package" | "embedded" | "fallback-tmp";
    /**
     * `bun-app-window` 自身的版本号（取自包内 `package.json`，不是 DLL 的 PE 版本）。
     *
     * 加它的理由：消费者要在界面上显示「连上的确实是这个版本」时，过去只能
     * `import libPkg from "bun-app-window/package.json"` 再拼字符串——那是一条
     * 额外的子路径依赖，且 `package.json` 在 `files` 白名单里所以要跟着发布面走。
     * 现在顺手带出来，页面侧直接读 `shell.libInfo.version`。
     */
    version: string;
    sha256: string;
    bytes: number;
    reused: boolean;
    pruned: string[];
};

export type ShellOptions = {
    /** 要加载的 URL（通常是本地回环地址） */
    url: string;
    title?: string;
    width?: number;
    height?: number;
    /** FLAG_* 位组合 */
    flags?: number;
    /** 启动后立即设置的最小尺寸（逻辑像素） */
    minWidth?: number;
    minHeight?: number;
    /**
     * 原生库路径。给定时跳过所有自动解析。
     * 用于测试或多副本部署。
     */
    nativeLibPath?: string;
    /**
     * 运行时数据目录名（`%LOCALAPPDATA%\<appName>\runtime`）。
     * 同一机器上多个应用共用一个包时应各自指定，避免互相清理 DLL 副本。
     */
    appName?: string;
    /**
     * 关闭哪些浏览器行为，取 `BROWSER_UI_*` 的按位或。缺省 0（保持 WebView2 默认）。
     *
     * 桌面应用一般传 `BROWSER_UI_ALL`：关掉右键 Edge 菜单、`Ctrl+P`/`Ctrl+F`/`Ctrl+S`、
     * 左下角状态栏、触控板滑动导航与表单自动填充。关掉默认右键菜单后若要右键有反应，
     * 用 `showContextMenu()` 弹原生菜单。
     */
    browserUi?: number;
    /**
     * 编译产物内嵌字节的提供者。
     * 使用 `bun build --compile` 时传入 `embeddedDll`（见 `bun-app-window/embedded`）。
     */
    embedded?: () => Promise<Uint8Array | null>;
};

export type StartResult = { rc: number; error: string };
