import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { isEntrypoint, normalizePath } from "../scripts/lib/entrypoint";

/**
 * 入口判定的测试。
 *
 * 这个文件存在的理由很直接：第一版实现把 `import.meta.main` 和 `import.meta.path`
 * 写在 helper 模块内部读，而 `import.meta` 是模块作用域的——在被 import 的模块里
 * `main` 恒为 false、`path` 恒指向 helper 自己。结果三个脚本的入口全被挡掉，
 * **静默退出 0、什么都不做**，门禁形同虚设。
 *
 * 守护逻辑自己成了故障源，而且同样静默。这类错误只有测出来才算数。
 */

const SELF = resolve("scripts/gate.ts");
const OTHER = resolve("scripts/verify-pack.ts");

describe("normalizePath", () => {
    test("统一为正斜杠并小写", () => {
        expect(normalizePath("C:\\A\\B\\c.TS")).toBe("c:/a/b/c.ts");
    });

    test("大小写不同的同一路径归一后相等", () => {
        // 这正是 Git 的 sh 里 cwd 大小写与真实目录名不一致时的情况
        expect(normalizePath("C:/Users/root/_repositories/x.ts")).toBe(
            normalizePath("C:\\Users\\root\\_Repositories\\x.ts"),
        );
    });

    test("相对路径按 cwd 解析", () => {
        expect(normalizePath("scripts/gate.ts")).toBe(normalizePath(SELF));
    });
});

describe("isEntrypoint", () => {
    test("import.meta.main 为真是充分条件", () => {
        expect(isEntrypoint(true, SELF, undefined)).toBe(true);
        // 即便 argv 指向别处，main 为真也直接成立
        expect(isEntrypoint(true, SELF, OTHER)).toBe(true);
    });

    test("main 为假但 argv[1] 与模块路径相同 → 仍然算入口", () => {
        // 这是修复的核心场景：cwd 大小写不一致会让 import.meta.main 失真，
        // 但 argv[1] 与 import.meta.path 指向同一个文件
        expect(isEntrypoint(false, SELF, SELF)).toBe(true);
    });

    test("大小写不同的同一路径也算入口", () => {
        const upper = SELF.replace("_repositories", "_Repositories");
        expect(isEntrypoint(false, SELF, upper)).toBe(true);
    });

    test("被别的模块 import 时返回 false", () => {
        // bun test 的场景：argv[1] 是测试入口，不是被测文件
        expect(isEntrypoint(false, SELF, OTHER)).toBe(false);
    });

    test("argv[1] 缺失时返回 false，不抛错", () => {
        expect(isEntrypoint(false, SELF, undefined)).toBe(false);
        expect(isEntrypoint(false, SELF, "")).toBe(false);
    });

    test("默认参数取自 process.argv[1]（不显式传参也能工作）", () => {
        // 只验证不抛错且返回布尔；真实取值随运行环境而变
        expect(typeof isEntrypoint(false, SELF)).toBe("boolean");
    });
});

describe("回归：入口守卫不能恒为假", () => {
    test("main=true 时必须在任何模块路径下都成立", () => {
        // 第一版 bug 的表现就是这一条不成立：helper 内部读到的是自己的 path
        for (const p of [SELF, OTHER, resolve("scripts/lib/entrypoint.ts")]) {
            expect(isEntrypoint(true, p)).toBe(true);
        }
    });

    test("三个真实入口在同一 argv 下判定一致", () => {
        const entries = [resolve("scripts/gate.ts"), resolve("scripts/verify-pack.ts"), resolve("native/fetch.ts")];
        for (const entry of entries) {
            // 该文件自己作为 argv → 是入口
            expect(isEntrypoint(false, entry, entry)).toBe(true);
            // 别的文件作为 argv → 不是入口
            for (const other of entries) {
                if (other !== entry) {
                    expect(isEntrypoint(false, entry, other)).toBe(false);
                }
            }
        }
    });
});
