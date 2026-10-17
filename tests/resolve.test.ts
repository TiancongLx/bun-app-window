import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { isPackedRuntime, resolveNativeLib } from "@/shell/resolve";

/** 包根：tests/ → 上一级 */
const PKG_ROOT = resolve(import.meta.dir, "..");
const DIST_DLL = join(PKG_ROOT, "dist", "libshell.dll");
const BUILD_DLL = join(PKG_ROOT, "build", "libshell.dll");

test("测试环境不是编译产物", () => {
    // 若这条失败，说明测试被塞进了 bun build --compile 产物里
    expect(isPackedRuntime()).toBe(false);
});

test("显式 nativeLibPath 优先，source 标记为 explicit", async () => {
    const info = await resolveNativeLib({ nativeLibPath: DIST_DLL });
    expect(info.source).toBe("explicit");
    expect(info.path).toBe(DIST_DLL);
    expect(info.bytes).toBeGreaterThan(100_000);
    expect(info.reused).toBe(false);
    expect(info.pruned).toEqual([]);
});

test("显式路径不存在时抛错且信息可读", async () => {
    const missing = join(PKG_ROOT, "dist", "definitely-not-here.dll");
    expect(existsSync(missing)).toBe(false);

    const err = await resolveNativeLib({ nativeLibPath: missing }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("nativeLibPath does not exist");
});

test("开发态自动定位到 build/ 下的 DLL", async () => {
    const info = await resolveNativeLib();
    // 仓库内开发态：build/ 优先于 dist/
    expect(info.source).toBe("dev");
    expect(existsSync(info.path)).toBe(true);
    expect(info.path.endsWith("libshell.dll")).toBe(true);
    if (existsSync(BUILD_DLL)) {
        expect(info.path).toBe(BUILD_DLL);
    }
});

test("解析结果的 sha256 在非内嵌分支为空串（不假装算过）", async () => {
    const info = await resolveNativeLib();
    expect(info.sha256).toBe("");
});

test("build/ 与 dist/ 的 DLL 是同一份产物", async () => {
    if (!existsSync(BUILD_DLL)) return;
    const a = Bun.file(BUILD_DLL);
    const b = Bun.file(DIST_DLL);
    expect(a.size).toBe(b.size);
    const [ba, bb] = await Promise.all([a.bytes(), b.bytes()]);
    expect(Bun.hash(ba)).toBe(Bun.hash(bb));
});
