import { describe, expect, test } from "bun:test";
import { isAbsolute, join, resolve } from "node:path";

import {
    PRE_PUSH_HOOK,
    normalizeEol,
    planInstall,
    resolveHooksDir,
} from "../scripts/install-hooks";

/**
 * 钩子安装器的行为断言。
 *
 * 旧版 `.ps1` 有两处只能靠手工察觉的问题：
 *   1. `Set-Content` 会按 CRLF 写盘，钩子里若是 CRLF 则 `sh` 无法执行
 *   2. 内容比较之前必须先归一化 EOL，否则「内容相同」永远判不出来，每次重写
 * 这两条现在都有断言。
 */

const REPO = resolve("/repo");
const TEMPLATE = PRE_PUSH_HOOK;

describe("PRE_PUSH_HOOK 的关键性质", () => {
    test("以 #!/bin/sh 开头（否则 sh 不认）", () => {
        expect(TEMPLATE.startsWith("#!/bin/sh\n")).toBe(true);
    });

    test("只有 LF，没有 CRLF", () => {
        // 这条是迁到 TS 的直接理由：写盘不经过任何 EOL 转换
        expect(TEMPLATE.includes("\r\n")).toBe(false);
    });

    test("以换行结尾", () => {
        expect(TEMPLATE.endsWith("\n")).toBe(true);
    });

    test("只做转调，不含判定逻辑", () => {
        // 钩子复制门禁逻辑会形成两份判定标准，随时间漂移（ADR 0009 的原始教训）
        expect(TEMPLATE).toContain("bun run scripts/gate.ts");
        expect(TEMPLATE).not.toContain("bun check");
        expect(TEMPLATE).not.toContain("bun test");
        expect(TEMPLATE).not.toContain("verify-pack");
    });

    test("转调的目标确实存在", () => {
        // 断言的字符串是仓库里真实存在的入口，防止改名后钩子静默跳过
        expect(TEMPLATE).toContain("scripts/gate.ts");
        expect(Bun.file(join(import.meta.dir, "..", "scripts", "gate.ts")).size).toBeGreaterThan(0);
    });

    test("文件缺失时放行而不是阻断推送", () => {
        // 新机器 clone 后若忘了装钩子，不该因为找不到 gate 就把推送卡死
        expect(TEMPLATE).toContain("不存在，跳过门禁");
        expect(TEMPLATE).toMatch(/exit 0/);
    });

    test("提供了 --no-verify 的提示", () => {
        expect(TEMPLATE).toContain("--no-verify");
    });
});

describe("resolveHooksDir", () => {
    test("没配 core.hooksPath → 默认 .git/hooks", () => {
        expect(resolveHooksDir(REPO, null)).toBe(join(REPO, ".git", "hooks"));
        expect(resolveHooksDir(REPO, "")).toBe(join(REPO, ".git", "hooks"));
        expect(resolveHooksDir(REPO, "   ")).toBe(join(REPO, ".git", "hooks"));
    });

    test("配了绝对路径 → 原样使用", () => {
        const abs = resolve("/custom/hooks");
        expect(isAbsolute(abs)).toBe(true);
        expect(resolveHooksDir(REPO, abs)).toBe(abs);
    });

    test("配了相对路径 → 按仓库根解析（git 的语义）", () => {
        expect(resolveHooksDir(REPO, "githooks")).toBe(join(REPO, "githooks"));
        expect(resolveHooksDir(REPO, ".githooks")).toBe(join(REPO, ".githooks"));
    });

    test("两端空白被忽略", () => {
        expect(resolveHooksDir(REPO, "  githooks  ")).toBe(join(REPO, "githooks"));
    });
});

describe("normalizeEol", () => {
    test("CRLF 归一为 LF", () => {
        expect(normalizeEol("a\r\nb\r\n")).toBe("a\nb\n");
    });

    test("纯 LF 不变", () => {
        expect(normalizeEol("a\nb\n")).toBe("a\nb\n");
    });
});

describe("planInstall", () => {
    const base = { exists: false, existingContent: null, force: false, dryRun: false, template: TEMPLATE };

    test("不存在 → created", () => {
        expect(planInstall(base)).toBe("created");
    });

    test("存在且内容相同 → unchanged（不重写）", () => {
        expect(planInstall({ ...base, exists: true, existingContent: TEMPLATE })).toBe("unchanged");
    });

    test("CRLF 版本视为内容相同 —— 否则每次都会误判为冲突", () => {
        // PS1 版本踩过这个：here-string 是 CRLF，磁盘上是 LF，永远不相等
        const crlf = TEMPLATE.replace(/\n/g, "\r\n");
        expect(planInstall({ ...base, exists: true, existingContent: crlf })).toBe("unchanged");
    });

    test("存在但内容不同且未加 --force → conflict（不覆盖自定义）", () => {
        expect(planInstall({ ...base, exists: true, existingContent: "#!/bin/sh\necho custom\n" })).toBe("conflict");
    });

    test("存在且内容不同但给了 --force → updated", () => {
        expect(
            planInstall({ ...base, exists: true, existingContent: "#!/bin/sh\n", force: true }),
        ).toBe("updated");
    });

    test("--dry-run 优先于一切判断", () => {
        expect(planInstall({ ...base, dryRun: true })).toBe("dry-run");
        expect(
            planInstall({ ...base, exists: true, existingContent: "x", dryRun: true }),
        ).toBe("dry-run");
        expect(
            planInstall({ ...base, exists: true, existingContent: TEMPLATE, dryRun: true }),
        ).toBe("dry-run");
    });

    test("existingContent 为 null 但 exists 为真 → 按冲突处理，不静默覆盖", () => {
        // 读不到内容（权限、竞态）时不能假设「一样」，也不能假设「可覆盖」
        expect(planInstall({ ...base, exists: true, existingContent: null })).toBe("conflict");
    });
});
