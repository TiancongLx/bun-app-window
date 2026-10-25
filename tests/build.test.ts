import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { BASE_FLAGS, LIBS, buildPaths, clangArgs, missingInputs } from "../native/build";
import { INPUTS } from "../native/fetch";

const REPO = resolve(import.meta.dir, "..");

/**
 * 编译脚本的静态断言。
 *
 * 旧版 `build.ps1` 把 clang++ 参数直接拼在一个数组里，漏一个 `-l` 或写错一个
 * `-I` 只能等编译/链接报错——而那时的报错信息指向 C++，不指向脚本。
 * 抽成纯函数后，参数表本身可以被断言。
 */

describe("buildPaths", () => {
    const p = buildPaths(REPO);

    test("三个 include 目录，顺序固定", () => {
        // 顺序影响头文件优先级；webview 核心头必须先于 SDK
        expect(p.includeDirs).toHaveLength(3);
        expect(p.includeDirs[0]).toBe(join(REPO, "vendor", "webview", "core", "include"));
        expect(p.includeDirs[1]).toBe(join(REPO, "vendor", "webview", "compatibility", "mingw", "include"));
        expect(p.includeDirs[2]).toBe(join(REPO, "vendor", "webview2", "build", "native", "include"));
    });

    test("输出为 .build/libshell.dll，并镜像到 dist/", () => {
        expect(p.outDll).toBe(join(REPO, ".build", "libshell.dll"));
        expect(p.distDll).toBe(join(REPO, "dist", "libshell.dll"));
    });

    test("源文件是 native/shell.cc", () => {
        expect(p.source).toBe(join(REPO, "native", "shell.cc"));
    });

    test("include 目录覆盖 INPUTS 的每份头文件", () => {
        // 判据是「某个 -I 目录是头文件路径的前缀」，不是「父目录完全相等」。
        // 例：webview.h 实际在 core/include/webview/ 下（它自己是个子目录），
        // 而 -I 指到 core/include 就够了 —— 断言等值会误报。
        //
        // 这条断言守的是「前置检查通过但编译找不到头」这种矛盾状态：
        // INPUTS 说齐备、clang 却说找不到，两份清单必须对得上。
        for (const input of INPUTS) {
            const header = join(REPO, "vendor", input.rel);
            const covered = p.includeDirs.some((dir) => header.startsWith(dir));
            expect({ rel: input.rel, covered }).toEqual({ rel: input.rel, covered: true });
        }
    });
});

describe("clangArgs", () => {
    const p = buildPaths(REPO);
    const args = clangArgs(p);

    test("包含每个 include 目录的 -I 形式", () => {
        for (const dir of p.includeDirs) {
            expect(args).toContain(`-I${dir}`);
        }
    });

    test("包含每个导入库的 -l 形式", () => {
        for (const lib of LIBS) {
            expect(args).toContain(`-l${lib}`);
        }
    });

    test("共享库必需的开关一个不少", () => {
        // -shared 少了会产出 exe；-static-libgcc/-static-libstdc++ 少了会导致
        // 目标机器缺 runtime DLL——这两类错误在 PS1 里没有任何静态拦截
        expect(args).toContain("-shared");
        expect(args).toContain("-static-libgcc");
        expect(args).toContain("-static-libstdc++");
        expect(args).toContain("-DWEBVIEW_STATIC");
        expect(args).toContain("-std=c++17");
    });

    test("unused-parameter 被显式关闭（webview 上游回调不满足）", () => {
        expect(args).toContain("-Wno-unused-parameter");
        expect(args).toContain("-Wno-unknown-pragmas");
    });

    test("-o 紧跟输出路径，且只有一组", () => {
        const i = args.indexOf("-o");
        expect(i).toBeGreaterThan(-1);
        expect(args[i + 1]).toBe(p.outDll);
        expect(args.filter((a) => a === "-o")).toHaveLength(1);
    });

    test("源文件在 -o 之前，库在 -o 之后", () => {
        // 链接顺序敏感：库必须在目标文件之后，否则符号解析失败
        const srcIdx = args.indexOf(p.source);
        const oIdx = args.indexOf("-o");
        const libIdx = args.indexOf(`-l${LIBS[0]}`);
        expect(srcIdx).toBeGreaterThan(-1);
        expect(srcIdx).toBeLessThan(oIdx);
        expect(libIdx).toBeGreaterThan(oIdx);
    });

    test("每个元素都是字符串且非空", () => {
        expect(args.every((a) => typeof a === "string" && a.length > 0)).toBe(true);
    });
});

describe("LIBS 与产物的一致性", () => {
    test("十个子系统库与 pwsh 版本逐一对齐", () => {
        expect([...LIBS]).toEqual([
            "advapi32",
            "ole32",
            "oleaut32",
            "uuid",
            "shell32",
            "shlwapi",
            "user32",
            "version",
            "dwmapi",
            // 原生 caption 按钮的字形绘制。此前没有这一项：旧实现全靠页面 CSS
            // 画按钮，壳层一个 GDI 调用都没有；少了它链接期就会报未解析符号。
            "gdi32",
        ]);
    });

    test("BASE_FLAGS 不含 include / 库 / 输出相关开关", () => {
        // 这些由 clangArgs 从路径推导，混进 BASE_FLAGS 会重复或错位
        for (const flag of BASE_FLAGS) {
            expect(flag.startsWith("-I")).toBe(false);
            expect(flag.startsWith("-l")).toBe(false);
            expect(flag).not.toBe("-o");
        }
    });
});

describe("missingInputs", () => {
    test("全部存在时返回空数组", () => {
        expect(missingInputs(REPO, () => true)).toEqual([]);
    });

    test("全部缺失时列出三个相对路径", () => {
        expect(missingInputs(REPO, () => false)).toEqual(INPUTS.map((i) => i.rel));
    });

    test("只缺 SDK 头时只报那一个", () => {
        const sdkRel = INPUTS[2].rel;
        const missing = missingInputs(REPO, (p) => !p.endsWith(sdkRel.replace(/\//g, "\\")) && !p.endsWith(sdkRel));
        expect(missing).toEqual([sdkRel]);
    });

    test("三份输入齐备时 missingInputs 为空（以真实文件系统为准）", () => {
        // 注意：vendor/webview2/ 是 .gitignore 排除的解压产物，干净 clone 里没有它。
        // 因此这条断言只在「已跑过 native/fetch.ts」的环境下成立——而 --clean 的
        // 干净副本恰恰不满足。这里不断言「当前仓库齐备」，只断言两个方向一致：
        // 真实存在 → 不报缺失；真实缺失 → 报出来。
        const actual = missingInputs(REPO);
        const reallyMissing = INPUTS.filter((i) => !existsSync(join(REPO, "vendor", i.rel))).map((i) => i.rel);
        expect(actual).toEqual(reallyMissing);
    });
});

describe("与已删除的 build.ps1 的关系", () => {
    test("build.ps1 已不存在（迁移完成）", () => {
        // 迁移完成后这条从「一致性断言」变成「迁移状态断言」：
        // 若哪天 build.ps1 又回来了，说明有人回退，这里会红。
        expect(existsSync(join(REPO, "native", "build.ps1"))).toBe(false);
        expect(existsSync(join(REPO, "native", "build.ts"))).toBe(true);
    });
});
