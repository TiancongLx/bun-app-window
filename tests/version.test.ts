import { expect, test } from "bun:test";

/**
 * 版本一致性守护。
 *
 * 版本号散落在多处，没有任何机制保证一致。改一处漏一处不会报错，
 * 只会静默漂移：npm 上是 0.2.0，而 exe 属性页写着 0.1.0.0。
 * 这类错误没有失败信号，所以必须有静态判据守住。
 *
 * 参与校验的两处：
 *   package.json          →  npm 发布用
 *   native/build-pack.ts  →  exe 的 PE 版本资源（--windows-version）
 *
 * CHANGELOG.md 与 git tag 不在断言范围：前者是给人读的叙述，
 * 后者在发版瞬间才产生，二者都无法在提交时稳定校验。
 */

const PKG_ROOT = `${import.meta.dir}/..`;

const PKG = (await Bun.file(`${PKG_ROOT}/package.json`).json()) as { version: string };
const BUILD_PACK = await Bun.file(`${PKG_ROOT}/native/build-pack.ts`).text();

/** semver：MAJOR.MINOR.PATCH，可选 prerelease / build metadata */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** PE 版本资源固定四段数字 */
const PE_VERSION = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * 从打包脚本源码里取出 `--windows-version` 的字面值。
 *
 * 三条约束，每条都对应一次真实事故：
 *
 * 1. 引号接受 `"` 与 `'`：`.ps1` 时代是单引号，迁到 TS 后是双引号。
 * 2. **必须排除注释行。** 初版用的非锚定正则会先命中注释里的示例
 *    （`* \`"--windows-version", "0.2.0.0"\``），于是版本号升到 0.2.1 之后
 *    这条断言仍然读到注释里的 0.2.0.0 并判失败 —— 而 `bump-version.ts`
 *    带行首锚定的正则改的是真代码。两处各自都对，合起来错。
 * 3. 因此注释里也不许写真实版本号（`build-pack.ts` 的文档注释里有说明）。
 *
 * ## 为什么在整段文本上匹配，而不是逐行
 *
 * 逐行匹配把契约绑在了**排版**上：`"--windows-version", "0.9.0.0",` 写在一行才认。
 * `bun fmt` 以 120 列排版时会把这两个元素拆成两行，于是四条断言同时变红——
 * 而代码本身一个字都没错。排版是格式化的产物，不是事实；契约应当锚在
 * 「版本号字面量紧随 `--windows-version`」这一点上，跨不跨行都成立。
 *
 * 注释行先抹成空行再匹配，而不是删掉：删掉会改变行结构，
 * 让「同一行内」与「下一行」这两种形状失去区分依据。
 */
function windowsVersionFrom(source: string): string | null {
    const cleaned = source
        .split(/\r?\n/)
        .map((raw) => {
            const t = raw.trim();
            const isComment = t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
            return isComment ? "" : raw;
        })
        .join("\n");

    // `\s` 含换行，故同行与另起一行两种排版都能命中；
    // `[^"'\r\n]+` 明确不跨行取值，避免把下一行的内容当成版本号。
    const m = /["']--windows-version["']\s*,\s*["']([^"'\r\n]+)["']/.exec(cleaned);
    return m?.[1] ?? null;
}

test("package.json 的 version 是合法 semver", () => {
    expect(PKG.version).toMatch(SEMVER);
});

test("build-pack.ts 里能定位到 --windows-version", () => {
    // 定位不到说明打包参数被改写或这行被删，后续断言会失去意义
    expect(BUILD_PACK).toContain("--windows-version");
    expect(windowsVersionFrom(BUILD_PACK)).not.toBeNull();
});

test("--windows-version 是四段数字", () => {
    const v = windowsVersionFrom(BUILD_PACK);
    expect(v).not.toBeNull();
    expect(v).toMatch(PE_VERSION);
});

test("exe 版本与 package.json 同源（前三段必须相等）", () => {
    const win = windowsVersionFrom(BUILD_PACK);
    expect(win).not.toBeNull();

    const semverMatch = SEMVER.exec(PKG.version);
    expect(semverMatch).not.toBeNull();
    const major = semverMatch?.[1];
    const minor = semverMatch?.[2];
    const patch = semverMatch?.[3];
    expect(major).toBeDefined();

    const expected = `${major}.${minor}.${patch}.0`;
    // 失败时提示怎么修，而不是让人对着两个字符串猜
    const hint =
        `package.json=${PKG.version} build-pack.ts=${win}。` +
        `发版前请运行 bun run scripts/bump-version.ts <version> 同步两处。`;
    expect(`${win} ${hint}`).toContain(`${expected} `);
});

test("exe 版本第四段固定为 0（PE 资源不承载 prerelease）", () => {
    const win = windowsVersionFrom(BUILD_PACK);
    expect(win).not.toBeNull();
    const parts = (win ?? "").split(".");
    expect(parts).toHaveLength(4);
    expect(parts[3]).toBe("0");
});

/**
 * 注释里不许出现**完整的版本字面量**。
 *
 * 这条是被真事逼出来的：`build-pack.ts` 的文档注释里原本有一行示例
 * `` `"--windows-version", "0.2.0.0"` ``，`windowsVersionFrom` 的非锚定正则
 * 先命中它、再命中断代码，于是版本号升到 0.2.1 之后这条断言仍读到 0.2.0.0。
 * 而 `bump-version.ts` 用的是行首锚定正则，改的确实是真代码。
 * **两处各自都对，合起来错** —— 只有一条「注释不许放真值」的断言能防住。
 */
test("注释里不得出现完整版本字面量", () => {
    const offenders: string[] = [];
    BUILD_PACK.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        const isComment = t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
        if (!isComment) return;
        if (/["']--windows-version["']\s*,\s*["']\d+\.\d+\.\d+\.\d+["']/.test(t)) {
            offenders.push(`L${i + 1}: ${t}`);
        }
    });
    expect(offenders).toEqual([]);
});
