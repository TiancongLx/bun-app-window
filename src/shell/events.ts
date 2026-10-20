/**
 * events.ts — 窗口生命周期事件：解码、游标与拉取节奏
 *
 * ## 为什么是队列 + 拉取，而不是回调
 *
 * `webview_run` 会阻塞原生 UI 线程，而 `bun:ffi` 的 `JSCallback` 依赖空闲的 JS
 * 主线程。二者叠加就是跨线程重入死锁（ADR 0002、`AGENTS.md` §5 第 5 条）。所以
 * 原生层只能往一个定长环里写，宿主在自己的节奏里批量拉走——`shell_poll_events`。
 *
 * ## 单读者
 *
 * `shell_poll_events` 是**消费式**的：读走的记录不会再来。一个进程里只应有一个
 * 消费者。要么用本模块的 `attachEventPump()`，要么自己按节奏调 `shell.pollEvents()`，
 * 别两者都来——两个消费者会各自拿到一部分，谁也看不全。
 *
 * 需要多路关心同一批事件时（例如「位置持久化」与「宿主等关闭」），用一个 pump
 * 加多个 `on()` 订阅，而不是起两个 pump。
 *
 * ## 序号与缺口
 *
 * 环满时丢最旧（原生侧裁断）。丢掉的记录不会伪装成还在，代价是 `seq` 出现断档——
 * 这正是「丢了几条」的精确来源：`EventCursor` 把它换算成 `gaps`，比一条合成的
 * 「溢出事件」信息量更大，也少一个要定义 `seq` 的特殊值。
 *
 * 新一次 `shell_start_ex` 会把 `seq` 归零。`seq` 回退即判定为重启（`restarted`），
 * 缺口不跨重启点计算。
 */

/**
 * 一条事件记录的字节数。
 *
 * 与 `native/shell.cc` 的 `EventRecord` 严格一一对应（那边有
 * `static_assert(sizeof(EventRecord) == 32)`）。改布局就是改 ABI。
 */
export const EVENT_RECORD_BYTES = 32;

/** 窗口状态变化。载荷是抓取那一刻的快照，不是增量 */
export const EVENT_STATE = 1;
/** 窗口已销毁且原生单例已释放。终态：此后不再有任何事件 */
export const EVENT_CLOSED = 2;

/** 最大化（对应 `SHELL_EV_MAXIMIZED`） */
export const EV_MAXIMIZED = 1;
/** 最小化 */
export const EV_MINIMIZED = 2;
/** 前台焦点 */
export const EV_FOCUSED = 4;
/** 系统深色主题 */
export const EV_DARK = 8;

/** 状态快照：`EVENT_STATE` 的载荷 */
export type StateEvent = {
    readonly type: typeof EVENT_STATE;
    /** 单调递增，从 1 起；新一次启动归零 */
    readonly seq: number;
    /** 客户区宽（物理像素） */
    readonly width: number;
    /** 客户区高（物理像素） */
    readonly height: number;
    /** 窗口 DPI；页面 CSS 像素 = 物理像素 × 96 / dpi */
    readonly dpi: number;
    readonly maximized: boolean;
    readonly minimized: boolean;
    readonly focused: boolean;
    readonly dark: boolean;
};

/** 终态：`EVENT_CLOSED` 的载荷 */
export type ClosedEvent = {
    readonly type: typeof EVENT_CLOSED;
    readonly seq: number;
};

export type WindowEvent = StateEvent | ClosedEvent;

/** 原生事件队列的容量。宿主一次拉取超过它没有意义 */
export const EVENT_QUEUE_CAPACITY = 128;

/**
 * 把原生写出的定长缓冲解成事件数组。
 *
 * `count` 来自 `shell_poll_events` 的返回值。它按契约不会超过 `buf` 能容纳的条数，
 * 但这里仍然夹一次——`count` 与 `buf` 由两处代码分别决定，夹一下的成本是一次除法，
 * 换来的是「原生改了布局、TS 忘了同步」时不会越界读。
 *
 * 未知 `type` 直接跳过而不是抛错：旧宿主遇到将来新增的事件类型，应该继续工作。
 */
export function decodeEvents(buf: Uint8Array, count: number): WindowEvent[] {
    const room = Math.floor(buf.byteLength / EVENT_RECORD_BYTES);
    const n = Math.min(Math.max(0, Math.trunc(count)), room);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out: WindowEvent[] = [];

    for (let i = 0; i < n; i++) {
        const at = i * EVENT_RECORD_BYTES;
        const seq = view.getUint32(at, true);
        const type = view.getUint32(at + 4, true);

        if (type === EVENT_CLOSED) {
            out.push({ type: EVENT_CLOSED, seq });
            continue;
        }
        if (type !== EVENT_STATE) {
            continue;
        }

        const flags = view.getUint32(at + 24, true);
        out.push({
            type: EVENT_STATE,
            seq,
            width: view.getInt32(at + 8, true),
            height: view.getInt32(at + 12, true),
            dpi: view.getInt32(at + 16, true),
            maximized: (flags & EV_MAXIMIZED) !== 0,
            minimized: (flags & EV_MINIMIZED) !== 0,
            focused: (flags & EV_FOCUSED) !== 0,
            dark: (flags & EV_DARK) !== 0,
        });
    }
    return out;
}

/** 只要求「能拉一批事件」，不绑定 `Shell`——便于测试与自定义源 */
export type EventSource = {
    pollEvents(max?: number): WindowEvent[];
};

export type EventBatch = {
    readonly events: readonly WindowEvent[];
    /** 每项是「这里丢了几条」。空数组表示序号连续 */
    readonly gaps: readonly number[];
    /** `seq` 回退，说明原生侧重启过 */
    readonly restarted: boolean;
};

/**
 * 事件游标：把「序号」翻译成「有没有丢」。
 *
 * 抽成独立对象是因为这是本模块唯一有状态、且状态正确性不能靠端到端验证的部分——
 * 真窗口能证明「拉到事件了」，证明不了「丢了事件时能看出来」。
 */
export class EventCursor {
    private last = 0;

    /** 最近一次收到的 `seq`；0 表示还没收到过 */
    get seq(): number {
        return this.last;
    }

    /** 丢弃已记录的位置（换了一个窗口重新开始看时用） */
    reset(): void {
        this.last = 0;
    }

    push(events: readonly WindowEvent[]): EventBatch {
        const gaps: number[] = [];
        let restarted = false;

        for (const e of events) {
            // 序号回退 = 原生侧重启（`reset_events()` 把序号归零）。
            // 重启后的第一条不检查缺口：新的一轮从 1 开始，把它当成「前面丢了 N 条」
            // 会把重启本身误报成丢事件。
            let afterRestart = false;
            if (this.last > 0 && e.seq <= this.last) {
                restarted = true;
                this.last = 0;
                afterRestart = true;
            }
            // last 为 0 且不是重启后的第一条（宿主从未读过）时，首条不是 1 同样说明有丢弃
            if (!afterRestart && e.seq > this.last + 1) {
                gaps.push(e.seq - this.last - 1);
            }
            this.last = e.seq;
        }

        return { events, gaps, restarted };
    }
}

export type EventPump = {
    /** 订阅。返回退订函数 */
    on(fn: (e: WindowEvent) => void): () => void;
    /** 订阅缺口。丢了多久之后不会再补，只会告诉你有多少条没看见 */
    onGap(fn: (missing: number) => void): () => void;
    stop(): void;
    readonly running: boolean;
    /** 已消费到的最新序号 */
    readonly seq: number;
};

export type EventPumpOptions = {
    /** 拉取节奏。默认 16 ms，约一帧 */
    intervalMs?: number;
    /** 一次最多拉多少条。默认 64，不超过 `EVENT_QUEUE_CAPACITY` */
    maxBatch?: number;
    /**
     * 是否让定时器阻止进程退出。默认 `false`（unref）。
     *
     * 设 `true` 的场景只有一种：**靠这个 pump 等窗口关闭**。unref 的定时器不
     * 阻止退出，而一个永不兑现的 promise 也撑不住事件循环——宿主会在窗口还开着
     * 的时候直接退出。`./app` 的骨架因此传 `true`。
     */
    keepAlive?: boolean;
};

/**
 * 按固定节奏从原生侧拉取事件，并分发给订阅者。
 *
 * 收到 `EVENT_CLOSED` 后自动 `stop()`：那是终态，之后再拉只有空数组，留着定时器
 * 只是白烧 CPU。
 *
 * 每个窗口只应有一个 pump（见模块头「单读者」）。
 */
export function attachEventPump(src: EventSource, opts: EventPumpOptions = {}): EventPump {
    const intervalMs = opts.intervalMs ?? 16;
    // 原生环就 EVENT_QUEUE_CAPACITY 条，要更多没有意义：多出来的缓冲永远不会被写满
    const maxBatch = Math.min(Math.max(1, opts.maxBatch ?? 64), EVENT_QUEUE_CAPACITY);
    const keepAlive = opts.keepAlive ?? false;

    const cursor = new EventCursor();
    const listeners = new Set<(e: WindowEvent) => void>();
    const gapListeners = new Set<(missing: number) => void>();
    let stopped = false;

    function stop(): void {
        if (stopped) {
            return;
        }
        stopped = true;
        clearInterval(timer);
    }

    const tick = (): void => {
        if (stopped) {
            return;
        }
        let batch: EventBatch;
        try {
            batch = cursor.push(src.pollEvents(maxBatch));
        } catch {
            // 原生库已被卸载、窗口正在销毁：这一拍跳过，下一拍再说。
            // 定时器回调里抛出的异常会直接终止进程，而这里没有任何值得终止的事。
            return;
        }

        if (batch.gaps.length > 0) {
            for (const missing of batch.gaps) {
                for (const fn of gapListeners) fn(missing);
            }
        }

        for (const e of batch.events) {
            for (const fn of listeners) fn(e);
            if (e.type === EVENT_CLOSED) {
                stop();
                return;
            }
        }
    };

    const timer = setInterval(tick, intervalMs);
    if (!keepAlive) unrefTimer(timer);

    return {
        on(fn) {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
        onGap(fn) {
            gapListeners.add(fn);
            return () => {
                gapListeners.delete(fn);
            };
        },
        stop,
        get running() {
            return !stopped;
        },
        get seq() {
            return cursor.seq;
        },
    };
}

/**
 * 让定时器不阻止进程退出。
 *
 * Bun 与 Node 的定时器对象都有 `unref()`，但类型库里 `setInterval` 的返回值在
 * DOM 与运行时两种声明下不同，所以按结构判断而不是按类型断言。
 */
export function unrefTimer(timer: unknown): void {
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref(): void }).unref();
    }
}
