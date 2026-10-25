/**
 * readme-contract.ts — README 与代码之间的契约判定（纯函数）
 *
 * ## 为什么要有这个文件
 *
 * 三份 README 是发布面里唯一面向外部读者的东西，而它们各自独立维护：同一处事实
 * 要在 `README.md`、`README.zh-CN.md`、`README.zh-TW.md` 里各写一遍。任何「只改了一份」
 * 或「代码加了能力但文档没跟上」都会静默留下不一致，而**没有任何编译期信号**。
 *
 * 判定逻辑放在这里而不是直接写进测试，是因为它有两个消费者：
 *
 *   - `tests/readme-contract.test.ts`  每次 `bun test` 都跑（静态项，不打包）——**唯一实现**
 *   - `scripts/release-sentinel.ts`     发版前跑，但只用 `parsePackageSize`：它把文档声明
 *     与真打包出来的字节比对，其余判据一律交给上面的测试
 *
 * 两处共用同一套规则。分开写必然会出现「测试认为合格、哨兵认为不合格」这种最糟的
 * 情况——那时人只会绕过其中一个。
 *
 * ## 判定取向：只守「形状唯一」的事实
 *
 * 本文件**不**断言 README 的叙述性内容。理由是 `docs/pitfalls.md` 2.12 那条：
 * 一条经常性误报的判据等于没有判据。能被唯一定位的才守：
 *
 *   - 包体积 / 文件数（有固定计量单位与位置）
 *   - 标志位常量名（来自源码，逐个可枚举）
 *   - 子路径（来自 package.json exports，逐个可枚举）
 *   - 自身版本字面量（来自 package.json version，精确匹配）
 *   - 指向发布面之外的文件引用（路径可枚举）
 *
 * 段落顺序、措辞、表格列数都不守——那是编辑自由，守了只会让人为了过门禁改废话。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 三份 README 的固定清单。顺序即展示顺序，`README.md` 是英文基准。 */
export const README_FILES = ["README.md", "README.zh-CN.md", "README.zh-TW.md"] as const;

/** README 声明过的包体积。三语版本用不同量词，解析后归一成同一形状。 */
export type DeclaredPackageSize = {
    /** 随包文件数 */
    files: number;
    /** tarball 体积（十进制 MB，与 `verify-pack` 的读数同口径） */
    packedMB: number;
    /** 解包后总体积（十进制 MB） */
    unpackedMB: number;
};

/**
 * 从「包内容」段落解析声明的体积。
 *
 * 三份的写法不同，量词与括号形态都不一样：
 *
 * ```text
 * README.md          22 files, 0.48 MB packed (1.39 MB unpacked)
 * README.zh-CN.md    共 22 个文件（0.48 MB，解包后 1.39 MB）
 * README.zh-TW.md    共 22 個檔案（0.48 MB，解包後 1.39 MB）
 * ```
 *
 * 解析策略是「同一行里先认量词、再认它后面的两个 MB」，而不是给三种形态各写一个
 * 正则——后者每加一门语言就要多一条，且漏一条的症状是**静默返回 null**。
 *
 * 返回 `null` 表示这一行不存在或格式认不出。调用方必须把 `null` 当作失败而不是
 * 「没有声明所以跳过」：声明被删掉本身就是漂移。
 */
export function parsePackageSize(text: string): DeclaredPackageSize | null {
    for (const line of text.split(/\r?\n/)) {
        const files = /(\d+)\s*(?:files|个文件|個檔案)/.exec(line);
        if (!files?.[1]) continue;
        const mb = [...line.matchAll(/([\d.]+)\s*MB/g)]
            .map((m) => Number(m[1]))
            .filter((n) => Number.isFinite(n));
        if (mb.length < 2) continue;
        const [packedMB, unpackedMB] = mb;
        if (packedMB === undefined || unpackedMB === undefined) continue;
        return { files: Number(files[1]), packedMB, unpackedMB };
    }
    return null;
}

/**
 * 抓出文本里出现的全部 `FLAG_*` 常量名。
 *
 * 用「出现在文本里」而不是「出现在标志位表格里」：后者要求解析 Markdown 表格，
 * 而表格一改列宽就失效。名字出现过就算提到过——这比漏判安全，且足够回答
 * 「新增的标志位有没有写进文档」。
 */
export function mentionedFlags(text: string): Set<string> {
    return new Set([...text.matchAll(/\bFLAG_[A-Z0-9_]+\b/g)].map((m) => m[0]));
}

/** 从 `types.ts` 源码抓出全部 `export const FLAG_* = <n>` 的名字。 */
export function declaredFlags(typesSource: string): string[] {
    return [...typesSource.matchAll(/export const (FLAG_[A-Z0-9_]+)\s*=/g)]
        .map((m) => m[1])
        .filter((n): n is string => typeof n === "string")
        .sort();
}

/** 从 `types.ts` 源码抓出 `BROWSER_UI_*` 常量名（`BROWSER_UI_ALL` 是聚合值，不参与）。 */
export function declaredBrowserUiBits(typesSource: string): string[] {
    return [...typesSource.matchAll(/export const (BROWSER_UI_[A-Z]+)\s*=/g)]
        .map((m) => m[1])
        .filter((n): n is string => typeof n === "string" && n !== "BROWSER_UI_ALL")
        .sort();
}

/**
 * 从 `package.json` 的 `exports` 取需要被文档覆盖的子路径。
 *
 * 排除两项：`"."`（主入口，文档通篇都在讲它）与 `"./package.json"`（元数据出口，
 * 不是能力面）。返回的是 `types` / `app` 这种裸名，比对时拼成 `bun-app-window/types`。
 */
export function documentedSubpaths(exportsMap: Record<string, unknown>): string[] {
    return Object.keys(exportsMap)
        .filter((k) => k !== "." && k !== "./package.json")
        .map((k) => k.replace(/^\.\//, ""))
        .sort();
}

/**
 * 找出指向**发布面之外**的文件引用。
 *
 * 这是本文件最要紧的一条判据，理由是它有确定性的伤害：`package.json` 的 `files`
 * 白名单只有 8 项，`AGENTS.md`、`.internal/`、`docs/`、`scripts/`、`tests/` 都不在包里。
 * README 让读者「去看 `AGENTS.md` 的形态 B」时，装包的人打开 node_modules 找不到那个
 * 文件——**这条引用从写下的第一天起就是死的**，而且不会有人报错。
 *
 * `vendor/webview` 是例外：它确实不在发布面，但 README 提到它的每一处都是在解释
 * 「为什么这些东西不随包分发」，属于正当说明而非指路。
 */
const FORBIDDEN_REFERENCES: ReadonlyArray<{ pattern: RegExp; name: string; why: string }> = [
    {
        pattern: /\bAGENTS\.md\b/g,
        name: "AGENTS.md",
        why: "gitignored 且不在 files 白名单，装包的人打不开",
    },
    {
        pattern: /\.internal\//g,
        name: ".internal/",
        why: "ADR 只存在于本地，从不随包分发",
    },
    {
        pattern: /\bdocs\/pitfalls\.md\b/g,
        name: "docs/pitfalls.md",
        why: "docs/ 不在 files 白名单",
    },
];

export type ForbiddenReference = { file: string; name: string; line: number; why: string };

/** 逐行扫一遍，返回所有指向发布面之外的引用。 */
export function forbiddenReferences(fileName: string, text: string): ForbiddenReference[] {
    const out: ForbiddenReference[] = [];
    text.split(/\r?\n/).forEach((line, i) => {
        if (/\bvendor\//.test(line)) {
            // 同一行里既提 vendor 又提被禁项时不能整体豁免。先剔除 vendor 片段再判。
            // 目前没有这种行，但豁免写得太宽会在将来悄悄放过一条。
            const stripped = line.replace(/`?vendor\/[A-Za-z0-9._/-]*`?/g, "");
            for (const rule of FORBIDDEN_REFERENCES) {
                rule.pattern.lastIndex = 0;
                if (!rule.pattern.test(stripped)) continue;
                out.push({ file: fileName, name: rule.name, line: i + 1, why: rule.why });
            }
            return;
        }
        for (const rule of FORBIDDEN_REFERENCES) {
            rule.pattern.lastIndex = 0;
            if (!rule.pattern.test(line)) continue;
            out.push({ file: fileName, name: rule.name, line: i + 1, why: rule.why });
        }
    });
    return out;
}

/**
 * 找出文档里出现的**自身版本字面量**。
 *
 * README 不写自己的版本号是刻意的：它随包发布，而版本号每发一次就变一次，
 * 写进正文等于给自己埋一个必然过期的数字。需要版本时让读者看 `package.json`
 * 或 `libInfo.version`。
 *
 * 第三方依赖的版本（Bun `1.4.4`、WebView2 `1.0.4258.31`）不在禁止之列——它们是
 * 契约的一部分，且升级时是显式动作。
 */
export function selfVersionLiterals(fileName: string, text: string, version: string): Array<{ file: string; line: number; text: string }> {
    const out: Array<{ file: string; line: number; text: string }> = [];
    if (!version) return out;
    // 用边界包住：避免 `0.7.0` 命中 `1.0.7.0` 这类更长版本串的内部
    const needle = new RegExp(`(?<![\\d.])${version.replace(/\./g, "\\.")}(?![\\d.])`);
    text.split(/\r?\n/).forEach((line, i) => {
        if (needle.test(line)) out.push({ file: fileName, line: i + 1, text: line.trim() });
    });
    return out;
}

/** 统计 ATX 标题（`#` / `##` / `###`）数量，用于检查三份结构是否同构。 */
export function headingCount(text: string): number {
    return text.split(/\r?\n/).filter((l) => /^#{1,3} /.test(l)).length;
}

/** 取出全部 ATX 一级/二级标题文本，按出现顺序。用于比较段落集合而非仅数量。 */
export function headingOutline(text: string): string[] {
    return text
        .split(/\r?\n/)
        .filter((l) => /^#{1,3} /.test(l))
        .map((l) => l.replace(/^#+\s*/, "").trim());
}

/**
 * 扫一个目录下所有 `.ts`，拼成一份可静态检索的语料。
 *
 * 用于「README 提到的常量是否真的存在」这类判定。只读文件内容，不加载模块——
 * 加载会触发 `bun:ffi`（主入口经 `./native` 引入它），在无窗口环境下不可靠。
 */
export function readSourceTree(dir: string): string {
    const parts: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            parts.push(readSourceTree(full));
            continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        parts.push(readFileSync(full, "utf8"));
    }
    return parts.join("\n");
}
