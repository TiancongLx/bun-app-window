/**
 * pe.ts — 只读的 PE 文件结构解析
 *
 * 这些判定原本分散在 `native/build-pack.ps1` 调用的三个外部工具里：
 *
 *     llvm-objdump -p  →  Subsystem（GUI 还是 console）
 *     rg -a -o         →  内嵌资源名
 *     Get-AuthenticodeSignature → 签名状态
 *
 * 三者都能用纯字节读取替代。好处不只是「少三个依赖」：
 *
 *   - 结果可以写成 `bun test` 断言（`tests/pe.test.ts` 拿 `dist/libshell.dll` 当基准）
 *   - 不经过 pwsh，也就没有「函数输出混进返回值」那类陷阱（pitfalls 5.3）
 *   - 判据来自 PE 规范本身，不依赖工具版本
 *
 * 只读，永远不写。所有函数在输入不合法时返回 null 而不是抛错——调用方在
 * 「读不到」和「读到 0」之间必须能区分。
 */

// ---- 偏移常量 ---------------------------------------------------------------
//
// 全部来自 PE/COFF 规范。写死数字很不优雅，但比引入一个 3000 行的 PE 解析库
// 划算：这里只用到三个字段，且规范二十年没变过。

/** DOS header 里 e_lfanew 的位置，指向 PE signature */
const E_LFANEW_OFFSET = 0x3c;

/** PE signature 的字面值 "PE\0\0"（小端读作 u32） */
const PE_SIGNATURE = 0x00004550;

/** Optional Header 里 Subsystem 的偏移（PE32 与 PE32+ 相同） */
const OPT_SUBSYSTEM_OFFSET = 68;

/** Optional Header 里 NumberOfRvaAndSizes 的偏移 */
const OPT_NUM_DIRS_OFFSET_PE32 = 92;
const OPT_NUM_DIRS_OFFSET_PE32PLUS = 108;

/** Data Directory 起点偏移 */
const OPT_DIRS_OFFSET_PE32 = 96;
const OPT_DIRS_OFFSET_PE32PLUS = 112;

/** Data Directory 里 Certificate Table 的索引 */
const DIR_INDEX_CERTIFICATE = 4;

/** Optional Header magic */
const MAGIC_PE32 = 0x010b;
const MAGIC_PE32PLUS = 0x020b;

/** Windows Subsystem 取值 */
export const SUBSYSTEM_WINDOWS_GUI = 2;
export const SUBSYSTEM_WINDOWS_CUI = 3;

// ---- 读取原语 ---------------------------------------------------------------

/** u16 小端；越界返回 null */
export function u16(bytes: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    const lo = bytes[offset];
    const hi = bytes[offset + 1];
    if (lo === undefined || hi === undefined) return null;
    return lo | (hi << 8);
}

/** u32 小端；越界返回 null。用 >>> 0 归一为无符号 */
export function u32(bytes: Uint8Array, offset: number): number | null {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    const b0 = bytes[offset];
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const b3 = bytes[offset + 3];
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

// ---- 结构化定位 -------------------------------------------------------------

export type PeLayout = {
    /** PE signature 的文件偏移 */
    peOffset: number;
    /** Optional Header 的文件偏移 */
    optOffset: number;
    /** Optional Header 的字节长度（来自 COFF header） */
    optSize: number;
    isPe32Plus: boolean;
};

/**
 * 定位 PE 头，顺便验证签名。
 *
 * 返回 null 的三种情况都要能区分出来（调用方可能需要不同的错误文案），
 * 但本模块只负责「不是合法 PE」，具体文案留给调用方。
 */
export function locatePe(bytes: Uint8Array): PeLayout | null {
    const peOffset = u32(bytes, E_LFANEW_OFFSET);
    if (peOffset === null) return null;
    if (u32(bytes, peOffset) !== PE_SIGNATURE) return null;

    const optOffset = peOffset + 24;
    const magic = u16(bytes, optOffset);
    if (magic === null) return null;

    // COFF header 的 SizeOfOptionalHeader 在 peOffset + 4 + 16
    const optSize = u16(bytes, peOffset + 4 + 16);
    if (optSize === null) return null;

    if (magic === MAGIC_PE32PLUS) {
        return { peOffset, optOffset, optSize, isPe32Plus: true };
    }
    if (magic === MAGIC_PE32) {
        return { peOffset, optOffset, optSize, isPe32Plus: false };
    }
    return null;
}

/**
 * 读 Subsystem 字段。
 *
 * `2` = Windows GUI（`--windows-hide-console` 之后应当是这个）
 * `3` = Console（默认）
 *
 * 这条断言的价值：`--windows-hide-console` 的效果是**改 PE 头**，只看
 * `bun build` 的退出码看不出来。曾经出现过「以为加了这个开关，实际没生效」。
 */
export function readSubsystem(bytes: Uint8Array): number | null {
    const layout = locatePe(bytes);
    if (!layout) return null;
    return u16(bytes, layout.optOffset + OPT_SUBSYSTEM_OFFSET);
}

export type CertificateDir = { offset: number; size: number };

/**
 * 读 Certificate Table（安全目录）的条目。
 *
 * 注意 PE 规范里这一项的特殊之处：它的「RVA」字段实际存的是**文件偏移**，
 * 不是 RVA。`pitfalls` 3.18 记着这一点与其余四个验签陷阱。
 *
 * 返回 null 表示没有签名（或不是合法 PE）。
 */
export function readCertificateDir(bytes: Uint8Array): CertificateDir | null {
    const layout = locatePe(bytes);
    if (!layout) return null;

    const numDirsOffset = layout.isPe32Plus ? OPT_NUM_DIRS_OFFSET_PE32PLUS : OPT_NUM_DIRS_OFFSET_PE32;
    const dirsOffset = layout.isPe32Plus ? OPT_DIRS_OFFSET_PE32PLUS : OPT_DIRS_OFFSET_PE32;

    const numDirs = u32(bytes, layout.optOffset + numDirsOffset);
    if (numDirs === null || numDirs <= DIR_INDEX_CERTIFICATE) return null;

    const entryOffset = layout.optOffset + dirsOffset + DIR_INDEX_CERTIFICATE * 8;
    const offset = u32(bytes, entryOffset);
    const size = u32(bytes, entryOffset + 4);
    if (offset === null || size === null) return null;
    if (offset === 0 || size === 0) return null;
    return { offset, size };
}

/** 是否带 Authenticode 签名（只看安全目录是否非空，不验签也不验信任链） */
export function hasAuthenticodeSignature(bytes: Uint8Array): boolean {
    return readCertificateDir(bytes) !== null;
}

// ---- 内嵌资源扫描 -----------------------------------------------------------

/** 在字节流里找 needle 的所有出现位置（只用于短 needle，不做 KMP） */
function findAllAscii(bytes: Uint8Array, needle: string): number[] {
    const hits: number[] = [];
    const n = needle.length;
    if (n === 0 || n > bytes.length) return hits;
    const first = needle.charCodeAt(0);
    for (let i = 0; i + n <= bytes.length; i++) {
        if (bytes[i] !== first) continue;
        let ok = true;
        for (let k = 1; k < n; k++) {
            if (bytes[i + k] !== needle.charCodeAt(k)) {
                ok = false;
                break;
            }
        }
        if (ok) hits.push(i);
    }
    return hits;
}

const HEX_LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 扫出 `bun build` 给内嵌资源起的名字。
 *
 * Bun 会把 `type: "file"` 的资产命名成 `<原名>-<8位hash>.<ext>`，
 * 例如 `libshell-a1b2c3d4.dll`。原 PS 脚本用 `rg -a -o` 抓这个，
 * 这里直接扫字节，省掉一个外部依赖。
 *
 * 返回去重后的名字列表，顺序按首次出现。
 */
export function findEmbeddedAssets(bytes: Uint8Array, prefixes: readonly string[]): string[] {
    const found: string[] = [];
    const seen = new Set<string>();

    for (const prefix of prefixes) {
        for (const at of findAllAscii(bytes, prefix)) {
            // prefix 形如 "libshell-"，其后应为 8 位 hash
            const hashStart = at + prefix.length;
            if (hashStart + 8 > bytes.length) continue;
            let hash = "";
            let valid = true;
            for (let k = 0; k < 8; k++) {
                const code = bytes[hashStart + k];
                if (code === undefined) {
                    valid = false;
                    break;
                }
                const ch = String.fromCharCode(code);
                if (!HEX_LOWER_ALNUM.includes(ch)) {
                    valid = false;
                    break;
                }
                hash += ch;
            }
            if (!valid) continue;

            // 扩展名：从 hash 之后读到 `.` 再读 3~5 个字母
            const dot = hashStart + 8;
            if (bytes[dot] !== 0x2e /* . */) continue;
            let ext = "";
            for (let k = dot + 1; k < bytes.length && ext.length < 5; k++) {
                const code = bytes[k];
                if (code === undefined) break;
                const ch = String.fromCharCode(code);
                if (ch >= "a" && ch <= "z") {
                    ext += ch;
                } else {
                    break;
                }
            }
            if (ext.length < 3) continue;

            const name = `${prefix}${hash}.${ext}`;
            if (!seen.has(name)) {
                seen.add(name);
                found.push(name);
            }
        }
    }
    return found;
}

// ---- 人类可读 ---------------------------------------------------------------

/** Subsystem 数字 → 可读标签 */
export function subsystemLabel(value: number | null): string {
    if (value === SUBSYSTEM_WINDOWS_GUI) return "2 (Windows GUI)";
    if (value === SUBSYSTEM_WINDOWS_CUI) return "3 (Console)";
    if (value === null) return "unknown";
    return `${value}`;
}
