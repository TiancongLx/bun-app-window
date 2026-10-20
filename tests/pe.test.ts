import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    SUBSYSTEM_WINDOWS_CUI,
    SUBSYSTEM_WINDOWS_GUI,
    findEmbeddedAssets,
    hasAuthenticodeSignature,
    locatePe,
    readCertificateDir,
    readSubsystem,
    subsystemLabel,
    u16,
    u32,
} from "../native/pe";

/**
 * PE 只读解析的判据。
 *
 * 这个文件取代了三个外部工具断言（`llvm-objdump -p`、`rg -a -o`、
 * `Get-AuthenticodeSignature`）。用真实产物当基准而不是构造假字节——
 * 构造的假 PE 只能证明「解析器符合我对规范的理解」，不能证明「它读得懂
 * 真实的 Windows 二进制」。两者都必要，这里选后者。
 */

const ROOT = join(import.meta.dir, "..");
const DLL = join(ROOT, "dist", "libshell.dll");

/** 小端 u16 写入，用于构造假 PE */
function putU16(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
}

/** 小端 u32 写入 */
function putU32(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
    buf[offset + 2] = (value >>> 16) & 0xff;
    buf[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * 造一个最小但结构完整的 PE32+ 映像。
 *
 * 只填本模块会读的字段：e_lfanew、PE signature、SizeOfOptionalHeader、
 * Magic、Subsystem、NumberOfRvaAndSizes、Certificate Table 条目。
 */
function makeFakePe(opts: {
    isPe32Plus?: boolean;
    subsystem?: number;
    certOffset?: number;
    certSize?: number;
    trailing?: string;
} = {}): Uint8Array {
    const isPe32Plus = opts.isPe32Plus ?? true;
    const buf = new Uint8Array(512);

    const peOffset = 0x80;
    putU32(buf, 0x3c, peOffset);
    putU32(buf, peOffset, 0x00004550); // "PE\0\0"

    const optOffset = peOffset + 24;
    putU16(buf, peOffset + 4 + 16, isPe32Plus ? 240 : 224); // SizeOfOptionalHeader
    putU16(buf, optOffset, isPe32Plus ? 0x20b : 0x10b); // Magic
    putU16(buf, optOffset + 68, opts.subsystem ?? SUBSYSTEM_WINDOWS_CUI);

    const numDirsOffset = isPe32Plus ? 108 : 92;
    const dirsOffset = isPe32Plus ? 112 : 96;
    putU32(buf, optOffset + numDirsOffset, 16); // NumberOfRvaAndSizes

    const certEntry = optOffset + dirsOffset + 4 * 8;
    putU32(buf, certEntry, opts.certOffset ?? 0);
    putU32(buf, certEntry + 4, opts.certSize ?? 0);

    if (opts.trailing) {
        const bytes = new TextEncoder().encode(opts.trailing);
        // 从最后一段空白区往前放，避免破坏头部
        const at = buf.length - bytes.length;
        buf.set(bytes, at);
    }
    return buf;
}

// ---- 读取原语 ---------------------------------------------------------------

describe("u16 / u32", () => {
    test("小端读数", () => {
        const b = new Uint8Array([0x34, 0x12, 0x78, 0x56, 0x34, 0x12]);
        expect(u16(b, 0)).toBe(0x1234);
        expect(u32(b, 2)).toBe(0x12345678);
    });

    test("越界返回 null，不抛错也不返回 0", () => {
        const b = new Uint8Array([1, 2, 3]);
        expect(u16(b, 2)).toBeNull();
        expect(u32(b, 0)).toBeNull();
        expect(u16(b, -1)).toBeNull();
        expect(u32(b, 100)).toBeNull();
    });

    test("高位字节当符号位上不会变成负数", () => {
        const b = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
        expect(u32(b, 0)).toBe(0xffffffff);
    });
});

// ---- 真实产物 ---------------------------------------------------------------

describe("真实 dist/libshell.dll", () => {
    const bytes = new Uint8Array(readFileSync(DLL));

    test("能定位到 PE 头", () => {
        const layout = locatePe(bytes);
        expect(layout).not.toBeNull();
        expect(layout?.isPe32Plus).toBe(true); // x64
    });

    test("读得到 Subsystem，且是 GUI 或 Console 之一", () => {
        const sub = readSubsystem(bytes);
        expect(sub).not.toBeNull();
        // 只要读出来是 2 或 3 就说明字段位置对了；DLL 通常被链接成 Console 子系统
        expect(sub === SUBSYSTEM_WINDOWS_GUI || sub === SUBSYSTEM_WINDOWS_CUI).toBe(true);
    });

    test("未签名的产物没有证书表", () => {
        // dist/libshell.dll 未签名。若将来签了名，这条会红——那时改成断言有签名。
        expect(readCertificateDir(bytes)).toBeNull();
        expect(hasAuthenticodeSignature(bytes)).toBe(false);
    });
});

// ---- 构造的假 PE ------------------------------------------------------------

describe("构造的 PE32+", () => {
    test("Subsystem 字段读得准", () => {
        expect(readSubsystem(makeFakePe({ subsystem: SUBSYSTEM_WINDOWS_GUI }))).toBe(
            SUBSYSTEM_WINDOWS_GUI,
        );
        expect(readSubsystem(makeFakePe({ subsystem: SUBSYSTEM_WINDOWS_CUI }))).toBe(
            SUBSYSTEM_WINDOWS_CUI,
        );
    });

    test("证书表非空 → 判定为已签名", () => {
        const pe = makeFakePe({ certOffset: 0x300, certSize: 0x100 });
        expect(readCertificateDir(pe)).toEqual({ offset: 0x300, size: 0x100 });
        expect(hasAuthenticodeSignature(pe)).toBe(true);
    });

    test("offset 或 size 任一为 0 → 不算签名", () => {
        expect(hasAuthenticodeSignature(makeFakePe({ certOffset: 0x300, certSize: 0 }))).toBe(false);
        expect(hasAuthenticodeSignature(makeFakePe({ certOffset: 0, certSize: 0x100 }))).toBe(false);
    });

    test("PE32（非 Plus）的目录偏移也读得对", () => {
        const pe32 = makeFakePe({ isPe32Plus: false, certOffset: 0x200, certSize: 0x50 });
        expect(readCertificateDir(pe32)).toEqual({ offset: 0x200, size: 0x50 });
    });

    test("NumberOfRvaAndSizes 不足 5 项 → 没有证书表", () => {
        const pe = makeFakePe({ certOffset: 0x300, certSize: 0x100 });
        // 把 NumberOfRvaAndSizes 改成 4（< DIR_INDEX_CERTIFICATE + 1）
        putU32(pe, 0x80 + 24 + 108, 4);
        expect(readCertificateDir(pe)).toBeNull();
    });

    test("不是 PE 的文件全部返回 null", () => {
        const garbage = new Uint8Array(512).fill(0x41);
        expect(locatePe(garbage)).toBeNull();
        expect(readSubsystem(garbage)).toBeNull();
        expect(hasAuthenticodeSignature(garbage)).toBe(false);
    });

    test("文件太短不足以读 e_lfanew → null", () => {
        expect(locatePe(new Uint8Array(16))).toBeNull();
    });
});

// ---- 内嵌资源扫描 -----------------------------------------------------------

describe("findEmbeddedAssets", () => {
    test("抓出 libshell-<hash>.dll 与 index-<hash>.html", () => {
        const text =
            "...padding...libshell-a1b2c3d4.dll...more...index-9f8e7d6c.html...tail...";
        const bytes = new TextEncoder().encode(text);
        const found = findEmbeddedAssets(bytes, ["libshell-", "index-"]);
        expect(found).toContain("libshell-a1b2c3d4.dll");
        expect(found).toContain("index-9f8e7d6c.html");
    });

    test("hash 长度不是 8 位 → 不匹配", () => {
        const bytes = new TextEncoder().encode("libshell-abc.dll");
        expect(findEmbeddedAssets(bytes, ["libshell-"])).toEqual([]);
    });

    test("hash 含非小写字母数字 → 不匹配", () => {
        const bytes = new TextEncoder().encode("libshell-A1B2C3D4.dll");
        expect(findEmbeddedAssets(bytes, ["libshell-"])).toEqual([]);
    });

    test("没有扩展名 → 不匹配", () => {
        const bytes = new TextEncoder().encode("libshell-a1b2c3d4");
        expect(findEmbeddedAssets(bytes, ["libshell-"])).toEqual([]);
    });

    test("同一名字重复出现只报一次", () => {
        const one = "libshell-aaaa1111.dll";
        const bytes = new TextEncoder().encode(`${one} xxx ${one}`);
        expect(findEmbeddedAssets(bytes, ["libshell-"])).toEqual([one]);
    });

    test("空输入与空前缀列表都不炸", () => {
        expect(findEmbeddedAssets(new Uint8Array(0), ["libshell-"])).toEqual([]);
        expect(findEmbeddedAssets(new TextEncoder().encode("libshell-aaaa1111.dll"), [])).toEqual(
            [],
        );
    });

    test("真实 dll 里不该有 bun 的内嵌资源名（DLL 不是编译产物）", () => {
        const bytes = new Uint8Array(readFileSync(DLL));
        // dist/libshell.dll 是 C++ 编译的普通 DLL，不含 bun 加的内嵌资源
        expect(findEmbeddedAssets(bytes, ["libshell-", "index-"])).toEqual([]);
    });
});

// ---- 标签 -------------------------------------------------------------------

describe("subsystemLabel", () => {
    test("2 / 3 / null 都有可读文案", () => {
        expect(subsystemLabel(SUBSYSTEM_WINDOWS_GUI)).toContain("GUI");
        expect(subsystemLabel(SUBSYSTEM_WINDOWS_CUI)).toContain("Console");
        expect(subsystemLabel(null)).toBe("unknown");
    });

    test("未知数字原样显示，不编造名字", () => {
        expect(subsystemLabel(9)).toBe("9");
    });
});
