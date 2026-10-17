import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
    /** 轮询间隔。GetWindowRect 是微秒级，700 ms 足够了 */
    intervalMs: 700,
} as const;

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
    /** 停止轮询。不清盘——最后写入的值保留 */
    dispose(): void;
    /** 当前已知的 placement（最近一次成功写入的） */
    readonly current: WindowPlacement | null;
};

/**
 * 轮询窗口矩形并在变化时写盘。
 *
 * 为什么轮询而不是事件：原生侧的窗口状态推送是发给**页面**的（shell-msg），宿主
 * 拿不到；加一条原生→宿主的回调通道要多一套生命周期管理，而 GetWindowRect 是
 * 微秒级调用，700 ms 一次的代价可以忽略。
 *
 * 变化检测按内容比较：窗口静止时不产生任何磁盘写入。
 */
export function attachPlacementStore(
    shell: Shell,
    file: string,
    opts: { intervalMs?: number } = {},
): PlacementStore {
    const intervalMs = opts.intervalMs ?? DEFAULTS.intervalMs;
    let last: WindowPlacement | null = null;
    let lastKey = "";
    let disposed = false;
    let pending: Promise<void> = Promise.resolve();

    const same = (a: WindowPlacement, b: WindowPlacement): boolean =>
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height &&
        a.maximized === b.maximized &&
        a.dpi === b.dpi;

    const tick = (): void => {
        if (disposed) {
            return;
        }
        const now = capturePlacement(shell);
        if (!now) {
            return;
        }
        // 窗口销毁过程中会短暂读到 0 尺寸，上面已过滤
        if (last && same(now, last)) {
            return;
        }
        const key = JSON.stringify(now);
        if (key === lastKey) {
            return;
        }
        last = now;
        lastKey = key;
        // 串行化写入：并发 rename 同一目标会互相踩
        pending = pending.then(() => savePlacement(file, now)).catch(() => {
            // 写盘失败不该打断应用；下一次 tick 会重试
        });
    };

    const timer = setInterval(tick, intervalMs);
    // 不阻止进程退出：应用退出时不该因为一个定时器挂住
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as { unref(): void }).unref();
    }

    return {
        async flush(): Promise<void> {
            tick();
            await pending;
        },
        dispose(): void {
            disposed = true;
            clearInterval(timer);
        },
        get current(): WindowPlacement | null {
            return last;
        },
    };
}
