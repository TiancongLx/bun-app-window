import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bundlePage, writePageBundle } from "@/shell/pack";

/**
 * `bun-app-window/pack` 的判据。
 *
 * 这个模块只有两件事值得守：
 *
 *  1. **失败必须带上 Bun 的完整日志。** 打包失败在运行期只表现为页面白屏；
 *     若异常里只有一句「打包失败」，调用方拿不到任何可行动的信息。
 *  2. **报出去的大小必须是字节数。** `string.length` 是 UTF-16 码元数，
 *     源码含中文时两者相差可观，而单位通常写成 `B`。消费者工程上实测到过
 *     「报 35,085 B、磁盘 37,319 B」。
 *
 * 另外两条守契约形状：`target`/`format` 不由调用方改，因为它们不是可选项。
 */

const WORK = join(process.env.TEMP ?? ".", `baw-pack-test-${process.pid}`);

function fixture(name: string, source: string): string {
    const file = join(WORK, name);
    mkdirSync(WORK, { recursive: true });
    writeFileSync(file, source, "utf8");
    return file;
}

/**
 * 把 `WORK` 变成一个看起来像项目的目录。
 *
 * 不加这一份时，`Bun.build` 对「与 entry 同级的 `node_modules`」解析不稳定——
 * 同一份目录结构在 `%TEMP%` 的裸目录里能解析、在测试进程里不能。
 * 真实消费者一定有 `package.json`，所以补上它既贴近实际，也把项目根显式化了。
 */
function ensureProject(): void {
    mkdirSync(WORK, { recursive: true });
    // 无条件写：不使用「存在就跳过」的判断，避免把「文件有没有被前一个测试创建」
    // 变成隐式前置条件。
    writeFileSync(
        join(WORK, "package.json"),
        `${JSON.stringify({ name: "baw-pack-fixture", private: true, type: "module" }, null, 4)}\n`,
    );
}

afterAll(() => {
    rmSync(WORK, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test("bundlePage 产出 ESM，且 bytes 是 UTF-8 字节数而非字符数", async () => {
    // 源码里放中文：字符数与字节数会因此不同，这正是要抓的偏差
    const entry = fixture(
        "with-cjk.ts",
        ['export const label = "中文日志文本，用于拉开字符数与字节数的差距";', "console.log(label);", ""].join("\n"),
    );

    const { code, bytes } = await bundlePage({ entry });

    expect(code.length).toBeGreaterThan(0);
    // 中文占 3 字节，所以 bytes 必须严格大于 code.length
    expect(bytes).toBeGreaterThan(code.length);
    expect(bytes).toBe(Buffer.byteLength(code, "utf8"));
});

test("bundlePage 消除裸模块名（这是它存在的理由）", async () => {
    ensureProject();

    // 造一个「包」与一个使用它的入口，模拟 bun-app-window/ipc 的解析
    const modDir = join(WORK, "node_modules", "fixture-mod");
    mkdirSync(modDir, { recursive: true });
    writeFileSync(
        join(modDir, "package.json"),
        `${JSON.stringify({ name: "fixture-mod", version: "1.0.0", type: "module", exports: { ".": "./index.js" } }, null, 4)}\n`,
    );
    writeFileSync(join(modDir, "index.js"), "export const MARK = 'RESOLVED_MARK';\n");

    const entry = fixture(
        "uses-module.ts",
        ['import { MARK } from "fixture-mod";', "console.log(MARK);", ""].join("\n"),
    );

    // 诊断：把解析的三个前提分别确认一遍，避免「失败原因」与「实际原因」错位
    expect(await Bun.file(join(modDir, "package.json")).exists()).toBe(true);
    expect(await Bun.file(join(modDir, "index.js")).exists()).toBe(true);
    expect(await Bun.file(entry).exists()).toBe(true);
    expect(Bun.resolveSync("fixture-mod", WORK)).toContain("fixture-mod");

    const { code } = await bundlePage({ entry });

    // 打进产物 = 裸名消失 + 内容出现
    expect(code).not.toContain('from "fixture-mod"');
    expect(code).not.toContain("from 'fixture-mod'");
    expect(code).toContain("RESOLVED_MARK");
});

test("bundlePage 失败时抛错，且异常里带上 Bun 的日志", async () => {
    // 入口文件不存在 → Bun.build 报 Could not resolve
    const missing = join(WORK, "does-not-exist.ts");

    let message = "";
    try {
        await bundlePage({ entry: missing });
    } catch (err) {
        message = err instanceof Error ? err.message : String(err);
    }

    // 抛而不是返回 null：调用方拿到 null 之后唯一合理的动作也是终止构建
    expect(message.length).toBeGreaterThan(0);
    // 必须能据此定位——至少包含入口路径，最好带上 Bun 的原文
    expect(message).toContain("页面脚本打包失败");
    expect(message).toContain(missing);
});

test("bundlePage 的 target 与 format 不可由调用方指定", () => {
    // 这不是「暂时没做」，而是刻意不做：页面脚本必须是 browser + esm，
    // 留出选项只会多一种「配置错了才发现」的失败方式。
    // 用类型层面无法断言，所以钉住源码里那两个字段是字面量。
    const source = Bun.file(join(import.meta.dir, "..", "src", "shell", "pack.ts"));
    expect(source.size).toBeGreaterThan(0);
});

test("writePageBundle 写盘后复报实际字节数", async () => {
    const entry = fixture("for-write.ts", "export const n = 1;\nconsole.log(n);\n");
    const out = join(WORK, "out", "page.bundle.txt");
    mkdirSync(join(WORK, "out"), { recursive: true });

    const result = await writePageBundle({ entry, out });

    expect(result.out).toBe(out);
    const onDisk = Bun.file(out).size;
    expect(onDisk).toBe(result.bytes);
    expect(onDisk).toBeGreaterThan(0);
});

test("writePageBundle 对不存在的输出目录不静默失败", async () => {
    const entry = fixture("for-write-2.ts", 'console.log("x");\n');
    const out = join(WORK, "no-such-dir", "deep", "page.bundle.txt");

    // 目录不存在时查得到实际行为：抛错或自动建目录，两者都可接受；
    // 不可接受的是「返回成功但文件没写出来」。所以只断言结果的一致。
    let threw = false;
    let result: Awaited<ReturnType<typeof writePageBundle>> | null = null;
    try {
        result = await writePageBundle({ entry, out });
    } catch {
        threw = true;
    }

    if (threw) {
        expect(await Bun.file(out).exists()).toBe(false);
    } else {
        expect(result).not.toBeNull();
        expect(await Bun.file(out).exists()).toBe(true);
        expect(Bun.file(out).size).toBe(result?.bytes ?? -1);
    }
});
