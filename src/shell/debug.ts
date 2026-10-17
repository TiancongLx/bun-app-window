import type { Shell } from "./index";
import { readBuffer } from "./native";

/**
 * 排障面（调试入口）。
 *
 * 为什么单独一个入口：公共 API 只承诺产品向能力。把 `hittest` / `metrics` /
 * `dpi` / `selfBase` / `selfPath` 留在主入口，等于把它们也变成契约——
 * 将来改一次诊断输出的格式，就成了破坏性变更。放到子路径后，
 * 主入口的 `Shell` 类型可以稳定演进，而排障手段仍随手可用。
 *
 *     import { openShell } from "webview-shell";
 *     import { debugOf } from "webview-shell/debug";
 *
 * 这些接口随时可能变化，生产代码不应依赖。
 */
export type ShellDebug = {
    /** 客户区坐标 → Win32 命中码（HT* 常量，1 = HTCLIENT） */
    hittest(x: number, y: number): number;
    /** 一次性几何快照：pos / win / client / work / border / round */
    metrics(): string;
    /** DPI 感知级别与实际监视器 DPI */
    dpi(): string;
    /** 原生库自身模块基址（判断是否内存映射） */
    selfBase(): bigint;
    /** 原生库自身文件路径 */
    selfPath(): string;
};

/** 取得某个 shell 的排障接口。底层是同一个 dlopen 句柄，无需二次加载。 */
export function debugOf(shell: Shell): ShellDebug {
    const s = shell.symbols;
    return {
        hittest: (x, y) => s.shell_debug_hittest(x, y),
        metrics: () => readBuffer((p, len) => s.shell_debug_metrics(p, len)),
        dpi: () => readBuffer((p, len) => s.shell_debug_dpi(p, len)),
        selfBase: () => s.shell_self_base(),
        selfPath: () => readBuffer((p, len) => s.shell_self_path(p, len)),
    };
}
