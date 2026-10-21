/**
 * pack.ts — 把页面脚本打成浏览器可加载的单文件 ESM
 *
 * ## 这一步为什么省不掉
 *
 * 页面代码要 `import { connect } from "bun-app-window/ipc"`，裸模块名浏览器解析不了，
 * 必须先打包。而打包只能发生在**构建期**：`bun build --compile` 之后
 * `import.meta.dir` 指向内嵌文件系统（`B:\~BUN\root`），那里没有 `.ts` 源文件，
 * 运行期打包会以 `ENOENT: failed to open root directory` 失败。
 *
 * 所以流程固定为两段：
 *
 * ```text
 * 构建期   bundlePage()  →  ESM 源码字符串  →  交给 createApp({ page })
 * 运行期   createApp 从内存里吐出 /page.js，不碰磁盘
 * ```
 *
 * ## 为什么放在壳层而不是各应用自己写
 *
 * 三件事每次都一样，且每一件都容易写错：
 *
 * 1. `target: "browser"` 与 `format: "esm"` 是「页面脚本」这个场景的硬要求，不是可选项；
 * 2. 失败时必须带上 Bun 的完整日志——打包失败在运行期只表现为页面白屏，没有日志就
 *    等于没有任何线索；
 * 3. 报大小要报**字节数**。`string.length` 是 UTF-16 码元数，源码里有中文时与字节数
 *    相差可观，而单位通常写成 `B`。
 *
 * 第 3 条是本仓在消费者工程上实测到的：某处报 `35,085 B`，磁盘实际 `37,319 B`。
 *
 * ## 与 `bun-app-window/types` 的区别
 *
 * `./types` 是零 import 的纯常量面，浏览器可以打包它。本模块用 `Bun.build`，
 * 属于**构建期**工具，不得出现在页面侧代码里。
 */

import { resolve } from "node:path";

/** 打包结果 */
export type PageBundle = {
    /** 单文件 ESM 源码，可直接交给 `createApp({ page })` */
    code: string;
    /**
     * UTF-8 字节数。
     *
     * 不是 `code.length`：那是 UTF-16 码元数，源码含中文时两者不等，
     * 而调用方几乎总是拿这个数当「产物多大」来报。
     */
    bytes: number;
};

export type BundlePageOptions = {
    /**
     * 页面脚本入口的绝对路径。
     *
     * 相对路径按 `process.cwd()` 解析，但**建议传绝对路径**：打包的模块解析基准是
     * 入口文件所在目录，而 `cwd` 只影响相对路径的解析。两者混用会让「为什么在这里
     * 能解析、在那里不能」变成一道推理题。
     */
    entry: string;
    /** 是否压缩。默认 `false`（与不传时的直观预期一致，也便于排查产物） */
    minify?: boolean;
};

/**
 * 从 `Bun.build` 的失败里取出可读线索。
 *
 * `Bun.build` 有两种失败形态，**日志位置不同**（2026-10-21 实测）：
 *
 * | 形态 | 返回值 | 日志在哪 |
 * | --- | --- | --- |
 * | 编译期诊断（语法错、无法解析的导入） | `{ success: false, logs: [...] }` | `result.logs` |
 * | 入口本身不可达 | **抛 `AggregateError`** | `err.errors`（**没有 `.logs`**） |
 *
 * 第二种的 `message` 只有一句 `Bundle failed`，完全无法定位——所以必须读 `.errors`。
 * 两条路径都要覆盖，否则最常见的一种「入口写错」会变成一句没有信息量的报错。
 */
function failureDetail(err: unknown): string {
    if (err instanceof Error) {
        // AggregateError 的成员在 .errors 上；普通 Error 没有这个属性
        const members = (err as { errors?: unknown }).errors;
        if (Array.isArray(members) && members.length > 0) {
            return members.map((item) => String(item)).join("\n");
        }
        return err.message;
    }
    return String(err);
}

/**
 * 打包页面脚本，返回 ESM 源码。
 *
 * 失败时抛错并附上 Bun 的完整诊断。抛而不是返回 `null`：调用方拿到 `null` 之后
 * 唯一合理的动作也是终止构建，而返回值多一个空状态就多一处要处理的分支。
 */
export async function bundlePage(opts: BundlePageOptions): Promise<PageBundle> {
    const entry = resolve(opts.entry);

    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
        result = await Bun.build({
            entrypoints: [entry],
            target: "browser",
            format: "esm",
            ...(opts.minify === undefined ? {} : { minify: opts.minify }),
        });
    } catch (err) {
        // 入口不可达走这条：`Bun.build` 抛 AggregateError 而不是返回 success:false
        throw new Error(
            `页面脚本打包失败（entry=${entry}）\n${failureDetail(err)}`,
        );
    }

    const first = result.outputs[0];
    if (!result.success || first === undefined) {
        const detail = result.logs.map((item) => String(item)).join("\n");
        throw new Error(
            `页面脚本打包失败（entry=${entry}）\n${detail || "（Bun 未提供日志）"}`,
        );
    }

    const code = await first.text();
    return { code, bytes: Buffer.byteLength(code, "utf8") };
}

/**
 * 打包并写盘，供「产物不入库、由 npm scripts 前置生成」的工程使用。
 *
 * ```json
 * "scripts": {
 *     "bundle:page": "bun run scripts/bundle-page.ts",
 *     "build": "bun run bundle:page && bun build --compile …"
 * }
 * ```
 *
 * ```ts
 * // scripts/bundle-page.ts
 * import { writePageBundle } from "bun-app-window/pack";
 * await writePageBundle({ entry: "src/ui/page.ts", out: "src/ui/page.bundle.txt" });
 * ```
 *
 * 产物是否需要入库由调用方决定。不入库时 `bun check` 仍然通过——类型检查按
 * `declare module "*.txt"` 解析模块，不访问文件系统；但 `bun build --compile`
 * 需要文件真实存在，所以前置不可省。
 */
export async function writePageBundle(
    opts: BundlePageOptions & { out: string },
): Promise<PageBundle & { out: string }> {
    const out = resolve(opts.out);
    const bundle = await bundlePage(opts);
    await Bun.write(out, bundle.code);

    // 复核一次实际字节数：`Bun.write` 的编码行为不由我们控制，
    // 报出去的数字必须是磁盘上那个，而不是我们以为的那个。
    const written = Bun.file(out).size;
    if (written !== bundle.bytes) {
        throw new Error(
            `页面产物写入字节数与预期不符：` +
                `写入 ${out}，预期 ${bundle.bytes} B，实际 ${written} B。` +
                `若产物被写成了带 BOM 或 CRLF 的形态，先查写入路径。`,
        );
    }

    return { ...bundle, out };
}
