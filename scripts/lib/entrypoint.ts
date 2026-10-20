/**
 * entrypoint.ts — 判断「当前模块是不是被直接执行的」
 *
 * ## 为什么需要它
 *
 * Bun 在解析 `bun run <path>` 时，`process.argv[1]` 会保留调用方 cwd 的**字面
 * 大小写**，而 `import.meta.path` 是解析后的真实路径。Windows 上 cwd 若以不同
 * 大小写进入（例如 Git 的 sh 里 `cd /c/Users/root/_repositories/...`，而真实
 * 目录名是 `_Repositories`），两者只差一个字母的大小写，`import.meta.main`
 * 就变成 `false`。
 *
 * 2026-10-20 实测：
 *
 *   pwsh 里 `bun run scripts/gate.ts`                    → main = true
 *   Git 的 sh 里 `bun run scripts/gate.ts`（cwd 小写）    → main = false
 *   Git 的 sh 里 `bun scripts/gate.ts`                    → main = true
 *
 * 后果是入口逻辑被守卫挡掉、脚本**静默退出 0 什么都不做**。门禁什么都不跑却报
 * 成功，是本仓反复要防的那类失败（`docs/pitfalls.md` 5.3）。
 *
 * ## 为什么必须显式传参
 *
 * 第一版写成无参的 `invokedAsEntrypoint()`，在模块内部读 `import.meta.main` 与
 * `import.meta.path`。这是错的：`import.meta` 是**模块作用域**的，
 *
 *   - 在被 import 的模块里 `import.meta.main` 恒为 `false`
 *   - `import.meta.path` 指向的是 `entrypoint.ts` 自己，不是调用方
 *
 * 于是函数恒返回 `false`，把三个脚本的入口全挡掉了——**守护逻辑自己成了故障源**，
 * 而且同样是静默的。因此这里只做纯判定，两个值都由调用方传入：
 *
 *     if (isEntrypoint(import.meta.main, import.meta.path)) { ... }
 *
 * 这个坑由 `tests/entrypoint.test.ts` 钉住。
 */

import { resolve } from "node:path";

/** 路径规范化：解析为绝对路径 → 统一正斜杠 → 小写（Windows 大小写不敏感） */
export function normalizePath(p: string): string {
    return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * 当前模块是否被当作入口直接执行。
 *
 * @param moduleMain 调用方模块的 `import.meta.main`
 * @param modulePath 调用方模块的 `import.meta.path`
 * @param argv1      默认 `process.argv[1]`，测试可注入
 *
 * 判据是「或」关系：`moduleMain` 为真，或者 argv[1] 与模块路径在规范化后相等。
 * 后者兜住 cwd 大小写不一致导致 `import.meta.main` 失真的情况。
 *
 * 被 `bun test` 导入时，argv[1] 是测试入口而不是被测文件，因此返回 false——
 * 导入不产生副作用这件事仍然成立。
 */
export function isEntrypoint(
    moduleMain: boolean,
    modulePath: string,
    argv1: string | undefined = process.argv[1],
): boolean {
    if (moduleMain) {
        return true;
    }
    if (!argv1) {
        return false;
    }
    return normalizePath(argv1) === normalizePath(modulePath);
}
