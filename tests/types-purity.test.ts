/**
 * types.ts 的纯净性判据：`bun-app-window/types` 子路径必须保持浏览器安全。
 *
 * ## 为什么需要这条
 *
 * 开 `./types` 子路径的唯一理由是让**页面侧**也能 import 这些常量。页面跑在
 * WebView2 里，主入口 `./index` 从 `./native` 拖进 `bun:ffi`，浏览器 bundle
 * 解析不了——所以过去页面只能把位值手抄一遍（`BROWSER_UI_*` 5 条、缩放阶梯
 * 14 档、边框索引 8 条），抄漏抄错都没有任何门禁能发现。
 *
 * 这个收益有个**唯一前提**：`types.ts` 自己不引入任何模块。一旦有人往里面加一句
 * `import`，子路径立刻变得不再浏览器安全，而症状会是「打包时报一个
 * `Could not resolve "bun:ffi"`」——离真正的原因隔了好几层。
 *
 * 所以这里用静态断言把前提钉住。它守的不是代码风格，是那个子路径存在的资格。
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const TYPES_PATH = join(import.meta.dir, "..", "src", "shell", "types.ts");

/**
 * 剥掉注释再判。
 *
 * 这是第一版判据红过之后加的：`types.ts` 的注释里出现了 `import` 与 `bun:ffi`
 * 这两个词（因为它在**解释**为什么不能用它们），全文搜索会把解释本身当成违规。
 * 只判真正的代码行才是对的。
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
}

/**
 * 注释里会提到「import」这个词，所以只能按行首判，不能全文搜关键字。
 * 正则一律限制在单行内：跨行匹配会把「第一个 export」到「后面某处 from」
 * 连成一条假命中（第一版就是这么红的）。
 */
const IMPORT_FORMS: ReadonlyArray<{ label: string; re: RegExp }> = [
    { label: "静态 import", re: /^[ \t]*import[ \t]/m },
    { label: "副作用 import", re: /^[ \t]*import[ \t]*["']/m },
    { label: "export … from 转出", re: /^[ \t]*export[ \t][^\n]*[ \t]from[ \t]*["']/m },
    { label: "export * 转出", re: /^[ \t]*export[ \t]*\*/m },
    { label: "动态 import()", re: /(?:^|[^.\w])import[ \t]*\(/m },
    { label: "require()", re: /(?:^|[^.\w])require[ \t]*\(/m },
];

test("types.ts 里没有任何 import / require —— 这是它浏览器安全的唯一前提", async () => {
    const raw = await Bun.file(TYPES_PATH).text();
    const code = stripComments(raw);

    const hits: string[] = [];
    for (const { label, re } of IMPORT_FORMS) {
        const m = re.exec(code);
        if (m === null) {
            continue;
        }
        // 报出行号：文件有几百行，只说「有 import」等于让人自己找
        const line = code.slice(0, m.index).split("\n").length;
        hits.push(`第 ${line} 行（${label}）：${m[0].trim()}`);
    }

    expect(hits).toEqual([]);
});

test("types.ts 只从本文件的声明导出（没有运行时依赖）", async () => {
    // 上一条按语法防；这一条按「导出面」防：所有 export 后面都必须是
    // const / type / function / interface，不能是 from 转出。
    const code = await Bun.file(TYPES_PATH).text();
    const exports = code.match(/^[ \t]*export[ \t]+[^\n]*/gm) ?? [];

    expect(exports.length).toBeGreaterThan(0);

    const allowed = /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:const|let|type|function|interface|abstract class|class)[ \t]/;
    const bad = exports.filter((line) => !allowed.test(line));
    expect(bad).toEqual([]);
});

test("这条判据本身能红 —— 拿一段带 import 的样本自检", () => {
    // 判据失效的最常见方式是它恒真（比如正则写错）。这里用构造样本做反向验证：
    // 样本必须是「会被判死」的，否则前面两条等于没跑。
    const sample = [
        "export const A = 1;",
        "",
        'import { x } from "./y";',
    ].join("\n");

    const detected = IMPORT_FORMS.some(({ re }) => re.test(sample));
    expect(detected).toBe(true);

    // 再确认它对合法样本不误报（注释里出现 import 这个词是允许的）
    const clean = [
        "/** 不得出现任何 `import` */",
        "export const A = 1;",
        "export type B = { a: number };",
    ].join("\n");
    const falsePositive = IMPORT_FORMS.some(({ re }) => re.test(clean));
    expect(falsePositive).toBe(false);
});
