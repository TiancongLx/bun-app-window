import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bundlePage, contentTypeFor, outputPathFor, writePageBundle } from "@/shell/pack";

/**
 * ADR 0021 的判据：打包层只做通用透传，不认识任何框架。
 *
 * 本文件与 `pack.test.ts` 的分工：
 *
 *   - `pack.test.ts` 守打包**行为**（字节数、裸模块名消除、失败诊断）
 *   - 本文件守**中立性**——即「壳层没有替消费者选择生态」这一约束
 *
 * 中立性不是风格要求。它一旦破例，壳层就需要为第二个框架再破一次例，而默认配置里的
 * 每一条框架约定都会变成所有消费者的隐式依赖。
 */

const ROOT = join(import.meta.dir, "..");

// ---- 依赖树：不出现任何前端框架 ---------------------------------------------

test("package.json 的三个依赖字段均为空", async () => {
    const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as Record<string, unknown>;

    // 三个字段分别对应「直接依赖」「要求消费者提供」「可选依赖」，
    // 任何一处出现框架名都意味着壳层与某个生态绑定
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        const value = pkg[field];
        const keys = value === undefined || value === null ? [] : Object.keys(value as object);
        expect({ field, keys }).toEqual({ field, keys: [] });
    }
});

test("**反向**：上一个断言能看到真实的字段，不是恒真", async () => {
    // 若 `package.json` 读取失败，上面那条会因为「keys 为空」而恒真。
    // 这里确认文件确实被读到了，且 devDependencies 非空——说明解析路径有效。
    const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
        name?: string;
        devDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe("bun-app-window");
    expect(Object.keys(pkg.devDependencies ?? {}).length).toBeGreaterThan(0);
});

// ---- 源码：不出现任何前端框架的名字 -----------------------------------------

test("src/shell/ 中不出现前端框架名", () => {
    const dir = join(ROOT, "src", "shell");
    const files = readdirSync(dir, { recursive: true })
        .map(String)
        .filter((p) => p.endsWith(".ts"));

    expect(files.length).toBeGreaterThan(10);

    // 只匹配小写标识符式出现，避免误伤中文注释里的普通词汇。
    // 大小写不敏感会让 `Solid` 这类普通词命中，而框架名在代码里总是小写。
    const pattern = /\b(svelte|vue|react|solidjs|angular)\b/;
    const hits: string[] = [];
    for (const rel of files) {
        const text = readFileSync(join(dir, rel), "utf8");
        for (const [i, line] of text.split("\n").entries()) {
            // 注释里举例说明「壳层不认识哪些框架」是正当的，但那样也会命中。
            // 判据因此限定为：出现在**非注释行**即算违规。
            const trimmed = line.trim();
            if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
                continue;
            }
            if (pattern.test(line)) {
                hits.push(`${rel}:${i + 1}`);
            }
        }
    }

    expect(hits).toEqual([]);
});

test("**反向**：该判据能命中一段故意写坏的样本", () => {
    // 判据恒真是最常见的失效方式。用一段构造文本确认正则确实生效。
    const pattern = /\b(svelte|vue|react|solidjs|angular)\b/;
    expect(pattern.test('import { SveltePlugin } from "bun-plugin-svelte";')).toBe(true);
    expect(pattern.test('const x = require("vue");')).toBe(true);
    // 普通词不命中（大小写敏感）
    expect(pattern.test("const solid = true;")).toBe(false);
    expect(pattern.test("固体 / 反应 / 视图")).toBe(false);
});

// ---- outputPathFor：产物落点规则 --------------------------------------------

test("入口产物落在调用方给的 out", () => {
    const got = outputPathFor("/p/page.bundle.txt", "/p/main.ts", {
        path: "/p/main.js",
        kind: "entry-point",
    });
    expect(got).toBe("/p/page.bundle.txt");
});

test("非入口产物落在同目录，扩展名替换", () => {
    // 样式产物：入口名 `main.css` 不应泄漏进产物命名
    const got = outputPathFor("/p/page.bundle.txt", "/p/main.ts", {
        path: "/p/main.css",
        kind: "asset",
    });
    // 期望由同一套 path API 构造，避免正/反斜杠在 Windows 上造成假失败
    expect(got).toBe(join(dirname("/p/page.bundle.txt"), "page.bundle.css"));
});

test("**反向**：不同扩展名的非入口产物各自得到不同落点", () => {
    const css = outputPathFor("/p/out.txt", "/p/main.ts", { path: "/p/a.css", kind: "asset" });
    const map = outputPathFor("/p/out.txt", "/p/main.ts", { path: "/p/a.map", kind: "sourcemap" });
    expect(css).not.toBe(map);
    expect(css.endsWith(".css")).toBe(true);
    expect(map.endsWith(".map")).toBe(true);
});

test("产物没有扩展名时用 kind 兜底，不会覆盖入口", () => {
    const got = outputPathFor("/p/out.js", "/p/main.ts", { path: "/p/CHUNK", kind: "chunk" });
    expect(got).not.toBe("/p/out.js");
    expect(got.endsWith(".chunk")).toBe(true);
});

test("out 本身没有扩展名时也能推导", () => {
    const got = outputPathFor("/p/bundle", "/p/main.ts", { path: "/p/a.css", kind: "asset" });
    expect(got).toBe(join(dirname("/p/bundle"), "bundle.css"));
});

// ---- contentTypeFor：未识别即回退，不猜 ------------------------------------

test("常见扩展名给出准确的 content-type", () => {
    expect(contentTypeFor("/a.js")).toContain("text/javascript");
    expect(contentTypeFor("/a.mjs")).toContain("text/javascript");
    expect(contentTypeFor("/a.css")).toContain("text/css");
    expect(contentTypeFor("/a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/a.woff2")).toBe("font/woff2");
});

test("大小写与查询串外的路径形态都能处理", () => {
    expect(contentTypeFor("/a.CSS")).toContain("text/css");
    expect(contentTypeFor("C:/deep/dir/a.css")).toContain("text/css");
});

test("**反向**：未识别扩展名回退到 octet-stream，而不是猜测", () => {
    // 猜错的表现是脚本或样式**不执行**（浏览器对错误的 MIME 静默拒绝），
    // 而回退的表现是「被下载」——后者立刻可见。
    expect(contentTypeFor("/a.wasm")).toBe("application/octet-stream");
    expect(contentTypeFor("/a.unknown")).toBe("application/octet-stream");
    expect(contentTypeFor("/noext")).toBe("application/octet-stream");
});

// ---- 透传：插件、define、alias 真的生效 ------------------------------------

const WORK = join(process.env.TEMP ?? ".", `baw-neutrality-${process.pid}`);

function fixture(name: string, source: string): string {
    mkdirSync(WORK, { recursive: true });
    const file = join(WORK, name);
    writeFileSync(file, source, "utf8");
    return file;
}

afterAll(() => {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("plugins 被原样交给 Bun.build —— 自定义扩展名可被编译", async () => {
    // 用最朴素的插件模拟「编译型框架」：把 .txt 文件当模块，内容转成 export。
    // 这里不引入任何真实框架，判据只关心「透传是否发生」。
    const compilerPlugin = {
        name: "neutrality-fixture-compiler",
        setup(build: {
            onLoad: (
                opts: { filter: RegExp },
                cb: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
            ) => void;
        }) {
            build.onLoad({ filter: /\.txt$/ }, async (args) => {
                const raw = readFileSync(args.path, "utf8").trim();
                return { contents: `export const COMPILED = ${JSON.stringify(raw)};`, loader: "js" };
            });
        },
    };

    const mod = fixture("payload.txt", "FROM_PLUGIN");
    const entry = fixture(
        "uses-plugin.ts",
        [
            'import { COMPILED } from "./payload.txt";',
            "console.log(COMPILED);",
            "",
        ].join("\n"),
    );

    const { code } = await bundlePage({
        entry,
        plugins: [compilerPlugin as never],
    });

    // 插件真的跑了：原文出现在产物中，且 .txt 不再以裸导入形式残留
    expect(code).toContain("FROM_PLUGIN");
    expect(code).not.toContain("./payload.txt");
    expect(mod.length).toBeGreaterThan(0);
});

test("**反向**：不传 plugins 时同一入口会失败，说明上面那条不是恒真", async () => {
    fixture("payload2.txt", "X");
    const entry = fixture(
        "uses-plugin-2.ts",
        ['import { COMPILED } from "./payload2.txt";', "console.log(COMPILED);", ""].join("\n"),
    );

    let message = "";
    try {
        await bundlePage({ entry });
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("页面脚本打包失败");
});

test("define 被原样透传 —— 编译期常量替换生效", async () => {
    const entry = fixture(
        "uses-define.ts",
        ["// eslint-disable-next-line", "console.log(__NEUTRAL_FLAG__);", ""].join("\n"),
    );

    const { code } = await bundlePage({
        entry,
        define: { __NEUTRAL_FLAG__: '"SUBSTITUTED"' },
    });

    expect(code).toContain("SUBSTITUTED");
    expect(code).not.toContain("__NEUTRAL_FLAG__");
});

test("alias 由壳层插件实现，且默认不预置任何条目", async () => {
    mkdirSync(join(WORK, "lib"), { recursive: true });
    const target = join(WORK, "lib", "thing.ts");
    writeFileSync(target, 'export const ALIASED = "ALIAS_OK";\n', "utf8");

    const entry = fixture(
        "uses-alias.ts",
        ['import { ALIASED } from "aliased-thing";', "console.log(ALIASED);", ""].join("\n"),
    );

    // 不传 alias → 裸名解析失败，证明下面那条的成功来自 alias 而非默认行为
    let failedWithout = false;
    try {
        await bundlePage({ entry });
    } catch {
        failedWithout = true;
    }
    expect(failedWithout).toBe(true);

    // 传了 alias → 裸名被映射到目标文件，解析成功
    const { code } = await bundlePage({
        entry,
        alias: { "aliased-thing": target },
    });
    expect(code).toContain("ALIAS_OK");
    expect(code).not.toContain("aliased-thing");
});

test("outputs 含全部产物，不止入口脚本", async () => {
    const entry = fixture("single-output.ts", 'console.log("one");\n');
    const bundle = await bundlePage({ entry });

    expect(bundle.outputs.length).toBeGreaterThan(0);
    // code / bytes 取的是 entry-point 那个，不是 outputs[0]
    const entryOutput = bundle.outputs.find((o) => o.kind === "entry-point");
    expect(entryOutput).toBeDefined();
    expect(bundle.code).toBe(entryOutput!.code);
    expect(bundle.bytes).toBe(entryOutput!.bytes);
    // 每个产物都带自身读数
    for (const o of bundle.outputs) {
        expect(o.bytes).toBe(Buffer.byteLength(o.code, "utf8"));
        expect(o.kind.length).toBeGreaterThan(0);
    }
});

test("writePageBundle 的 written 逐一列出落盘文件", async () => {
    const entry = fixture("for-written.ts", 'console.log("w");\n');
    const out = join(WORK, "written", "page.bundle.txt");
    mkdirSync(join(WORK, "written"), { recursive: true });

    const result = await writePageBundle({ entry, out });

    expect(result.written.length).toBe(result.outputs.length);
    for (const w of result.written) {
        expect(Bun.file(w.path).size).toBe(w.bytes);
    }
    // 入口一定写在调用方给的 out 上
    expect(result.written.some((w) => w.path === out)).toBe(true);
});
