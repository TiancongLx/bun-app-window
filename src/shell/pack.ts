/**
 * pack.ts — 把页面脚本打成浏览器可加载的 ESM
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
 * ## 中立性
 *
 * `plugins` / `define` / `alias` / `loader` 是对 `Bun.build` 的**通用透传**，不是对某个
 * 前端框架的支持：本模块不认识任何框架，`alias` 的默认值为空，也不内置任何插件。
 * 编译型框架（Svelte / Vue / Solid）由消费者自己 `bun add` 插件并传入（ADR 0021）。
 *
 * 这条约束的理由与依赖树一致：壳层认识一个框架，就要认识第二个。
 *
 * ## 与 `bun-app-window/types` 的区别
 *
 * `./types` 是零 import 的纯常量面，浏览器可以打包它。本模块用 `Bun.build`，
 * 属于**构建期**工具，不得出现在页面侧代码里。
 */

import { basename, dirname, extname, join, resolve } from "node:path";
import type { BunPlugin, Loader } from "bun";

/** 单个打包产物的读数 */
export type PageOutput = {
    /** 产物路径，由 `Bun.build` 给出（相对于工作目录或绝对路径） */
    path: string;
    /**
     * 产物类型，取 `Bun.build` 的原值。
     *
     * - `entry-point`：入口脚本本身
     * - `chunk`：拆分出的公共块
     * - `asset`：非脚本资源（样式、图片等）
     * - `sourcemap`：源码映射
     * - `bytecode`：预编译字节码
     */
    kind: string;
    /** 产物的文本内容 */
    code: string;
    /** UTF-8 字节数，不是 `code.length` */
    bytes: number;
};

/** 打包结果 */
export type PageBundle = {
    /**
     * 入口脚本的 ESM 源码，可直接交给 `createApp({ page })`。
     *
     * 取的是 `kind === "entry-point"` 那个产物，**不是** `outputs[0]`：
     * `outputs` 的顺序不构成契约，样式产物可能排在前面。
     */
    code: string;
    /**
     * 入口脚本的 UTF-8 字节数。
     *
     * 不是 `code.length`：那是 UTF-16 码元数，源码含中文时两者不等，
     * 而调用方几乎总是拿这个数当「产物多大」来报。
     */
    bytes: number;
    /**
     * 全部产物，按 `Bun.build` 的输出顺序。
     *
     * 编译型框架常产生多个产物（例如脚本 + 独立的样式文件）。只取第一个会让第二个
     * 被静默丢弃，而表现是页面渲染正常但样式全无。
     */
    outputs: PageOutput[];
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
    /**
     * `Bun.build` 插件。原样透传，壳层不构造也不包装。
     *
     * 编译型框架的接入点。传入的插件自行负责其扩展名的编译，壳层对此不做任何假设。
     */
    plugins?: BunPlugin[];
    /**
     * 编译期常量替换。原样透传。
     *
     * ```ts
     * define: { __VUE_OPTIONS_API__: "false" }
     * ```
     */
    define?: Record<string, string>;
    /**
     * 路径别名。**由壳层实现，不是直接透传。**
     *
     * 理由：Bun 1.4.4 的 `BuildConfig` 没有 `alias` 字段——实测传入会被静默忽略，
     * 而 `bun-types` 的 `BuildConfig` 中也不存在该属性。因此由本模块用一个
     * `onResolve` 插件实现（约十五行），对消费者而言仍是一个普通映射表。
     *
     * **默认值为空，不预置任何条目**：`$lib` 是 SvelteKit 的约定，`@/` 是某个工程的
     * `tsconfig` 约定，两者都不属于壳层。预置任何别名都等于替消费者选择一个生态。
     *
     * 映射规则：键等于说明符，或以 `键/` 为前缀。其余说明符不干预。
     */
    alias?: Record<string, string>;
    /** 扩展名到 loader 的映射。用于自定义后缀（`.vue` / `.svelte` 之外的情形） */
    loader?: Record<string, Loader>;
};

/**
 * 把别名表编译成一个 `onResolve` 插件。
 *
 * 返回 `null` 表示没有别名需要处理——此时**不注册插件**，避免一个恒空转的
 * `onResolve` 钩子进入每条解析路径。
 *
 * 解析顺序：先按 `Bun.resolveSync` 求真实路径（这样 `@/thing` → `<dir>/thing.ts`
 * 的扩展名补全由 Bun 自己完成），求不到则原样交给后续解析。不求到就放弃，
 * 是因为「别名指向一个不存在的路径」应当由 Bun 报出原始的可读错误，而不是被
 * 插件改写成一个更难理解的信息。
 */
function createAliasPlugin(alias: Record<string, string> | undefined): BunPlugin | null {
    if (alias === undefined) {
        return null;
    }
    const keys = Object.keys(alias);
    if (keys.length === 0) {
        return null;
    }
    // 长键优先，保证 `@/x` 不会被更短的 `@` 先命中
    keys.sort((a, b) => b.length - a.length);

    return {
        name: "bun-app-window:alias",
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                // 相对路径、绝对路径与运行时内置模块不参与别名
                if (args.path.startsWith(".") || args.path.startsWith("/") || /^[a-z]+:/.test(args.path)) {
                    return undefined;
                }
                for (const key of keys) {
                    let remainder: string;
                    if (args.path === key) {
                        remainder = "";
                    } else if (args.path.startsWith(`${key}/`)) {
                        remainder = args.path.slice(key.length);
                    } else {
                        continue;
                    }
                    const candidate = (alias[key] ?? "") + remainder;
                    try {
                        return { path: Bun.resolveSync(candidate, dirname(args.importer)) };
                    } catch {
                        return { path: candidate };
                    }
                }
                return undefined;
            });
        },
    };
}

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
 * 打包页面脚本，返回 ESM 源码与全部产物。
 *
 * 失败时抛错并附上 Bun 的完整诊断。抛而不是返回 `null`：调用方拿到 `null` 之后
 * 唯一合理的动作也是终止构建，而返回值多一个空状态就多一处要处理的分支。
 */
export async function bundlePage(opts: BundlePageOptions): Promise<PageBundle> {
    const entry = resolve(opts.entry);

    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
        // 别名不是 Bun.build 的字段（见 BundlePageOptions.alias），由插件承担。
        // 与消费者传入的插件合并而非替换：两者的职责正交，替换会让「用了 alias 就不能
        // 用框架插件」变成一条隐藏规则。
        const aliasPlugin = createAliasPlugin(opts.alias);
        const plugins = [...(opts.plugins ?? []), ...(aliasPlugin === null ? [] : [aliasPlugin])];

        result = await Bun.build({
            entrypoints: [entry],
            target: "browser",
            format: "esm",
            ...(opts.minify === undefined ? {} : { minify: opts.minify }),
            // 以下三项为原样透传：不筛选、不改写、不补默认值
            ...(plugins.length === 0 ? {} : { plugins }),
            ...(opts.define === undefined ? {} : { define: opts.define }),
            ...(opts.loader === undefined ? {} : { loader: opts.loader }),
        });
    } catch (err) {
        // 入口不可达走这条：`Bun.build` 抛 AggregateError 而不是返回 success:false
        throw new Error(
            `页面脚本打包失败（entry=${entry}）\n${failureDetail(err)}`,
        );
    }

    if (!result.success || result.outputs.length === 0) {
        const detail = result.logs.map((item) => String(item)).join("\n");
        throw new Error(
            `页面脚本打包失败（entry=${entry}）\n${detail || "（Bun 未提供日志）"}`,
        );
    }

    const outputs: PageOutput[] = [];
    for (const artifact of result.outputs) {
        const code = await artifact.text();
        outputs.push({
            path: artifact.path,
            kind: String(artifact.kind),
            code,
            bytes: Buffer.byteLength(code, "utf8"),
        });
    }

    // 取 entry-point 而非 outputs[0]：输出顺序不是契约，样式产物可能排在前面
    const entryOutput = outputs.find((o) => o.kind === "entry-point") ?? outputs[0];
    if (entryOutput === undefined) {
        throw new Error(`页面脚本打包失败（entry=${entry}）\n产物中找不到入口脚本`);
    }

    return { code: entryOutput.code, bytes: entryOutput.bytes, outputs };
}

/**
 * 由一个产物推导它在磁盘上的落点。
 *
 * 规则：入口脚本落在调用方给的 `out`；其余产物落在同目录，扩展名替换为该产物的扩展名。
 *
 * 用替换而非拼接：`page.bundle.txt` 的样式产物落为 `page.bundle.css`，而不是入口名
 * （`main.css`）。后者会把入口文件名泄漏进产物命名，而产物名会被 HTML 与
 * `createApp({ assets })` 引用，改一次入口名就会连带改所有引用点。
 *
 * 产物本身没有扩展名时（少见），追加 `.<kind>`，保证不覆盖入口脚本。
 */
export function outputPathFor(
    out: string,
    entryPath: string,
    artifact: Pick<PageOutput, "path" | "kind">,
): string {
    if (artifact.path === entryPath || artifact.kind === "entry-point") {
        return out;
    }
    // 先试产物自带的扩展名；拿不到就用 kind 兜底
    let ext = extname(artifact.path);
    if (ext === "") {
        ext = `.${artifact.kind}`;
    }
    // stem 取 basename：dirname(out) 已经是目录，再拼上绝对路径会重复目录段
    const current = extname(out);
    const stem = current === "" ? basename(out) : basename(out, current);
    return join(dirname(out), stem + ext);
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
 * 多产物时，入口脚本写到 `out`，其余写到同目录（规则见 `outputPathFor`）。
 * 返回值里的 `written` 逐项列出实际落盘路径，调用方的清理逻辑据此处理——
 * 只删 `out` 会留下样式产物。
 *
 * 产物是否需要入库由调用方决定。不入库时 `bun check` 仍然通过——类型检查按
 * `declare module "*.txt"` 解析模块，不访问文件系统；但 `bun build --compile`
 * 需要文件真实存在，所以前置不可省。
 */
export async function writePageBundle(
    opts: BundlePageOptions & { out: string },
): Promise<PageBundle & { out: string; written: Array<{ path: string; bytes: number }> }> {
    const out = resolve(opts.out);
    const bundle = await bundlePage(opts);

    const entryArtifact = bundle.outputs.find((o) => o.kind === "entry-point") ?? bundle.outputs[0];
    const written: Array<{ path: string; bytes: number }> = [];

    for (const artifact of bundle.outputs) {
        const dest = outputPathFor(out, entryArtifact?.path ?? "", artifact);
        await Bun.write(dest, artifact.code);

        // 复核一次实际字节数：`Bun.write` 的编码行为不由我们控制，
        // 报出去的数字必须是磁盘上那个，而不是我们以为的那个。
        const onDisk = Bun.file(dest).size;
        if (onDisk !== artifact.bytes) {
            throw new Error(
                `页面产物写入字节数与预期不符：` +
                    `写入 ${dest}，预期 ${artifact.bytes} B，实际 ${onDisk} B。` +
                    `若产物被写成了带 BOM 或 CRLF 的形态，先查写入路径。`,
            );
        }
        written.push({ path: dest, bytes: onDisk });
    }

    return { ...bundle, out, written };
}

/**
 * 由扩展名推断 `content-type`。
 *
 * 未识别的扩展名回退到 `application/octet-stream` 而不是猜测：猜错的表现是脚本或样式
 * **不执行**（`<script type="module">` 与 `<link rel=stylesheet>` 都会静默拒绝错误的
 * MIME 类型），而回退的表现是「被下载」——后者立刻可见。
 */
export function contentTypeFor(path: string): string {
    switch (extname(basename(path)).toLowerCase()) {
        case ".js":
        case ".mjs":
            return "text/javascript; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".html":
            return "text/html; charset=utf-8";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".webp":
            return "image/webp";
        case ".woff":
            return "font/woff";
        case ".woff2":
            return "font/woff2";
        case ".txt":
            return "text/plain; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}
