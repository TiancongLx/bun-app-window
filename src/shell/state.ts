import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { EVENT_STATE, attachEventPump, type EventPump, unrefTimer } from "./events";
import type { Shell } from "./index";

/**
 * 窗口位置与尺寸的持久化。
 *
 * 单独一个模块而不是塞进 `index.ts`，因为库主体有一条硬约束：不得引入副作用
 * （不写文件、不起服务、不读 env）。持久化按定义就是副作用，所以它是**显式调用**的
 * 可选件，你不调用它就不会有任何文件产生。
 *
 * 跨会话恢复有三个坑，原生侧已经处理，这里只负责序列化与节流：
 *   - DPI 变化：存的是物理像素 + 当时的 DPI，恢复时按比例换算
 *   - 显示器不在了：矩形要与某块工作区有足够交叠才算可用，否则居中
 *   - 最大化状态：存「还原后」的矩形，而不是整屏尺寸
 *
 * ## 为什么现在是事件驱动，不是轮询
 *
 * 这个模块曾经每 700 ms 调一次 `getBounds()`。理由是「原生侧的窗口状态推送是发给
 * **页面**的（shell-msg），宿主拿不到」。0.4.0 起那个理由不成立了：`shell_poll_events`
 * 给了宿主一条自己的通道。
 *
 * 换成事件驱动之后，两件事同时变好：
 *   - 窗口静止时**一次 FFI 都不发生**（轮询时代是每秒 1.4 次）
 *   - 拖动期间不再每帧写盘。事件到一条就即时 `getBounds()` 存快照（微秒级），
 *     但**写盘**攒到停手后 `debounceMs` 才做一次
 *
 * 快照与写盘分离是有意的：窗口关闭后原生侧 `getBounds()` 立刻返回空串
 * （`format_bounds` 里 `!g_hwnd` 直接返回 0），若等到防抖到点才去读，最后那次
 * 位置变化就永久丢了——用户「拖完立刻点 X」是最常见的关闭方式。
 */

export type WindowPlacement = {
    /** 物理像素，屏幕坐标 */
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
    /** 保存时的窗口 DPI；恢复时用于换算尺寸 */
    dpi: number;
};

const DEFAULTS = {
    /** 收到变化事件后攒多久再写盘。拖动期间事件每帧一条，攒到停手写一次 */
    debounceMs: 300,
    /** 自建事件泵（未由调用方提供）时的拉取节奏 */
    pumpMs: 16,
} as const;

/**
 * Win32 的「窗口已最小化」哨兵坐标。
 *
 * 窗口最小化时 `GetWindowRect` 返回的不是真实位置，而是一对哨兵值——实测
 * `-32000,-32000` 加一个图标尺寸（典型 `314x50`）。它们**看起来完全合法**：
 * 坐标是整数，尺寸也大于 0，所以只判「非有限 / 尺寸 ≤ 0」的形状校验拦不住。
 *
 * 成因在原生 `format_bounds`：它只在 `IsZoomed` 为真时走
 * `WINDOWPLACEMENT.rcNormalPosition`，最小化时 `IsZoomed` 返回 false，于是落进
 * `GetWindowRect` 分支——**`IsIconic` 从未被判断**。于是这对哨兵值会一路写成
 * `{"x":-32000,"y":-32000,"width":314,"height":50}`，下次启动恢复成一个畸形小窗
 * （实测：666×471，页面被挤到换行并出现滚动条）。
 *
 * 阈值取 -30000 而不是精确 -32000：不同 DPI / 主题下这对值会带几个像素偏移。
 * 真实坐标到不了这个量级——8K 屏横向也只有 7680，多屏横排也远不到 30000，
 * 所以用阈值不会误伤合法的负坐标（主屏在右、副屏在左时 x 确实是负数）。
 */
const MINIMIZED_SENTINEL = -30000;

/** 是不是 Win32 的最小化哨兵坐标。任一维命中即判否——两维是同时写的 */
function isMinimizedSentinel(x: number, y: number): boolean {
    return x <= MINIMIZED_SENTINEL || y <= MINIMIZED_SENTINEL;
}

/** 把原生返回的一行文本解析成 WindowPlacement；格式不对返回 null。 */
export function parseBounds(text: string): WindowPlacement | null {
    const parts = text.trim().split(",");
    if (parts.length !== 6) {
        return null;
    }
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) {
        return null;
    }
    const [x, y, width, height, maximized, dpi] = nums as [
        number,
        number,
        number,
        number,
        number,
        number,
    ];
    // 尺寸为 0 或负数说明窗口还没建好（原生在无窗口时返回 0 长度文本，这里再兜一层）
    if (width <= 0 || height <= 0 || dpi <= 0) {
        return null;
    }
    // 最小化时原生给的是哨兵坐标，不是真实位置——宁可返回 null 让调用方保留上一次的值
    if (isMinimizedSentinel(x, y)) {
        return null;
    }
    return { x, y, width, height, maximized: maximized !== 0, dpi };
}

/**
 * 校验外部来源（磁盘 JSON）里的 placement。
 *
 * 配置文件可能是手改坏的、被截断的、或者是旧版本写的。这里做形状校验而不是直接
 * 相信它：一个 out-of-range 的坐标会让窗口出现在屏幕外，表现为「程序启动了但看不到」。
 */
export function parsePlacement(raw: unknown): WindowPlacement | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const num = (k: string): number | null => {
        const v = o[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const x = num("x");
    const y = num("y");
    const width = num("width");
    const height = num("height");
    const dpi = num("dpi");
    if (x === null || y === null || width === null || height === null || dpi === null) {
        return null;
    }
    if (width <= 0 || height <= 0 || dpi <= 0) {
        return null;
    }
    // 物理像素的合理上限：8K 也只有 7680。超过说明文件被污染了
    if (width > 20000 || height > 20000) {
        return null;
    }
    if (Math.abs(x) > 200000 || Math.abs(y) > 200000) {
        return null;
    }
    // 已写进磁盘的哨兵坐标同样不可用：旧版本写过这种文件，读的时候要判否而不是恢复它
    if (isMinimizedSentinel(x, y)) {
        return null;
    }
    return { x, y, width, height, maximized: o.maximized === true, dpi };
}

/** 读当前窗口矩形；窗口不存在或数据不可解析时返回 null。 */
export function capturePlacement(shell: Shell): WindowPlacement | null {
    return parseBounds(shell.getBounds());
}

/** 把保存的矩形恢复到窗口上（异步生效；原生侧会做 DPI 换算与屏幕校验）。 */
export function restorePlacement(shell: Shell, p: WindowPlacement): number {
    return shell.restoreBounds(p.x, p.y, p.width, p.height, p.dpi, p.maximized);
}

/** 从磁盘读。文件不存在、损坏、形状不对一律返回 null，不抛错。 */
export async function loadPlacement(file: string): Promise<WindowPlacement | null> {
    try {
        const f = Bun.file(file);
        if (!(await f.exists())) {
            return null;
        }
        return parsePlacement(JSON.parse(await f.text()));
    } catch {
        return null;
    }
}

/**
 * 写磁盘。先写临时文件再改名——窗口位置在关闭时写，如果正好被强杀，
 * 半截 JSON 会让下次启动读不到位置；改名是原子的，至少保证要么旧值要么新值。
 */
export async function savePlacement(file: string, p: WindowPlacement): Promise<void> {
    const target = resolve(file);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(p, null, 4)}\n`, "utf8");
    renameSync(tmp, target);
}

export type PlacementStore = {
    /** 立即抓一次并写盘（关闭前调用） */
    flush(): Promise<void>;
    /** 停止拉取事件与防抖定时器。不清盘——最后写入的值保留 */
    dispose(): void;
    /** 当前已知的 placement（最近一次快照） */
    readonly current: WindowPlacement | null;
};

export type PlacementStoreOptions = {
    /**
     * 变化后攒多久再写盘。默认 300 ms。
     *
     * 设成 0 表示「每条事件都立刻写」——只适合测试，真实应用会给磁盘造成
     * 每秒几十次的写入。
     */
    debounceMs?: number;
    /**
     * 复用宿主已有的事件泵。
     *
     * **`shell.pollEvents()` 是消费式的**：一个窗口只该有一个消费者。用
     * `./app` 的骨架时传 `{ events: app.events }`，别再让它自己起一个——
     * 两个泵会各自拿到一部分事件，位置持久化会随机漏掉一些变化。
     *
     * 不给时本模块自建一个（内部泵定时器 unref，不阻止进程退出）。
     */
    events?: EventPump;
    /** 自建事件泵时的拉取节奏，默认 16 ms。给了 `events` 时忽略 */
    pumpMs?: number;
};

/**
 * 订阅窗口状态变化并在停手后写盘。
 *
 * 变化检测按内容比较：窗口静止时不产生任何磁盘写入，也不产生任何调度。
 *
 * 首次 `attach` 会立刻抓一次快照并写盘——程序若在用户操作前崩溃，也还有
 * 初始位置可恢复。
 */
export function attachPlacementStore(
    shell: Shell,
    file: string,
    opts: PlacementStoreOptions = {},
): PlacementStore {
    const debounceMs = Math.max(0, opts.debounceMs ?? DEFAULTS.debounceMs);
    const pump =
        opts.events ??
        attachEventPump(shell, { intervalMs: Math.max(1, opts.pumpMs ?? DEFAULTS.pumpMs) });
    const ownsPump = opts.events === undefined;

    let last: WindowPlacement | null = null;
    let lastKey = "";
    let disposed = false;
    let pending: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 已取到快照、但还没写盘的值 */
    let dirty: WindowPlacement | null = null;

    const same = (a: WindowPlacement, b: WindowPlacement): boolean =>
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height &&
        a.maximized === b.maximized &&
        a.dpi === b.dpi;

    /**
     * 抓一次快照，变了就记进 `dirty`。
     *
     * 与写盘分开：这一步是微秒级的 FFI 读，必须在窗口还活着的时候做。写盘可以晚。
     */
    const snapshot = (): void => {
        if (disposed) {
            return;
        }
        const now = capturePlacement(shell);
        // 窗口销毁过程中会短暂读到 0 尺寸，parseBounds 已过滤
        if (!now) {
            return;
        }
        if (last && same(now, last)) {
            return;
        }
        const key = JSON.stringify(now);
        if (key === lastKey) {
            return;
        }
        last = now;
        lastKey = key;
        dirty = now;
    };

    const write = (): void => {
        const now = dirty;
        dirty = null;
        if (!now) {
            return;
        }
        // 串行化写入：并发 rename 同一目标会互相踩
        pending = pending.then(() => savePlacement(file, now)).catch(() => {
            // 写盘失败不该打断应用；下一次变化会重试
        });
    };

    const scheduleWrite = (): void => {
        if (disposed) {
            return;
        }
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            write();
        }, debounceMs);
        unrefTimer(timer);
    };

    const off = pump.on((e) => {
        if (e.type !== EVENT_STATE) {
            return;
        }
        // 立刻取快照（窗口还活着），但写盘交给防抖
        snapshot();
        scheduleWrite();
    });

    // 首次快照：不等到第一条事件就有初始值可恢复
    snapshot();
    write();

    return {
        async flush(): Promise<void> {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            snapshot();
            write();
            await pending;
        },
        dispose(): void {
            disposed = true;
            off();
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (ownsPump) {
                pump.stop();
            }
        },
        get current(): WindowPlacement | null {
            return last;
        },
    };
}
