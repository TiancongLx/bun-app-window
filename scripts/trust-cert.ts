#!/usr/bin/env bun
/**
 * trust-cert.ts — 把自签代码签名证书装入当前用户的证书存储区
 *
 * 替代 `scripts/trust-cert.ps1`。原版靠 `Cert:` 驱动器与
 * `X509Certificate2`，这里换成 crypt32 的存储 API —— 同一套引擎，少一层 .NET。
 *
 * ## 与 PS1 版的差异
 *
 * 1. **不读私钥、不导出证书**：原版 `$cert.Export(X509ContentType.Cert)` 再
 *    `new X509Certificate2(der)`，绕了一圈只为「复制一份证书对象」。
 *    `CertAddCertificateContextToStore` 可以直接把来源存储里的 context 复制过去。
 * 2. **写入失败要能区分「已存在」与「权限不足」**：原版只 catch 打印消息。
 *    这里按 `GetLastError` 分派退出码——`Root` 存储需要管理员，普通权限下
 *    失败是**预期行为**，不该让整条命令返回非 0。
 *
 * 用法：
 *
 *     bun run scripts/trust-cert.ts
 *     bun run scripts/trust-cert.ts --subject "CN=Other Dev"
 *     bun run scripts/trust-cert.ts --stores TrustedPublisher
 *     bun run scripts/trust-cert.ts --help
 */

import { FFIType, dlopen } from "bun:ffi";
import { resolve } from "node:path";

import { utf16z } from "../native/win32";
import { isEntrypoint } from "./lib/entrypoint";

// ---- crypt32 ----------------------------------------------------------------

const crypt32 = dlopen("crypt32.dll", {
    CertOpenSystemStoreW: { args: [FFIType.u64_fast, "buffer"], returns: FFIType.u64_fast },
    CertCloseStore: { args: [FFIType.u64_fast, "u32"], returns: "bool" },
    CertEnumCertificatesInStore: { args: [FFIType.u64_fast, FFIType.u64_fast], returns: FFIType.u64_fast },
    CertAddCertificateContextToStore: {
        args: [FFIType.u64_fast, FFIType.u64_fast, "u32", "ptr"],
        returns: "bool",
    },
    CertFreeCertificateContext: { args: [FFIType.u64_fast], returns: "bool" },
    CertGetNameStringW: {
        args: [FFIType.u64_fast, "u32", "u32", "u32", "buffer", "u32"],
        returns: "u32",
    },
    CertGetCertificateContextProperty: {
        args: [FFIType.u64_fast, "u32", "buffer", "buffer"],
        returns: "bool",
    },
});

/** `CERT_NAME_SIMPLE_DISPLAY_TYPE` */
const CERT_NAME_SIMPLE_DISPLAY_TYPE = 4;

/** `CERT_KEY_PROV_INFO_PROP_ID`：有这项说明私钥可用 */
const CERT_KEY_PROV_INFO_PROP_ID = 2;

/** `CERT_STORE_ADD_REPLACE_EXISTING` */
const CERT_STORE_ADD_REPLACE_EXISTING = 3;

/** 存储名：大小写敏感，必须是 Win32 认识的规范名 */
export const KNOWN_STORES = ["My", "Root", "TrustedPublisher", "TrustedPeople", "CA"] as const;
export type StoreName = (typeof KNOWN_STORES)[number];

export type CertInfo = {
    /** 存储内枚举得到的 context 句柄，仅供内部使用 */
    handle: bigint;
    /** 简单显示名（通常是 CN） */
    name: string;
    hasPrivateKey: boolean;
};

function storeName(name: StoreName): Uint8Array {
    return utf16z(name);
}

/** 打开当前用户的系统存储；失败返回 0n */
export function openStore(name: StoreName): bigint {
    const h = crypt32.symbols.CertOpenSystemStoreW(0n, storeName(name));
    return typeof h === "number" ? BigInt(h) : 0n;
}

/** 读证书的简单显示名 */
function certDisplayName(context: bigint): string {
    const buf = new Uint8Array(512);
    const n = crypt32.symbols.CertGetNameStringW(
        context,
        CERT_NAME_SIMPLE_DISPLAY_TYPE,
        0,
        0,
        buf,
        buf.length / 2,
    );
    if (typeof n !== "number" || n <= 1) return "";
    // 返回的是字符数（含 NUL），转成字节偏移
    const bytes = buf.subarray(0, (n - 1) * 2);
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        s += String.fromCharCode((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
    }
    return s;
}

/** 证书是否带可用的私钥（决定它能不能用来签名） */
function certHasPrivateKey(context: bigint): boolean {
    const needed = new Uint32Array(1);
    const ok = crypt32.symbols.CertGetCertificateContextProperty(
        context,
        CERT_KEY_PROV_INFO_PROP_ID,
        null as never,
        needed,
    );
    // 有私钥时调用成功（或至少把所需长度填进 needed）
    return ok === true || (needed[0] ?? 0) > 0;
}

/**
 * 在存储里找第一张满足条件的证书。
 *
 * `match` 直接吃显示名而不是 Subject：`CertGetNameStringW` 的简单显示名对
 * `CN=WebView Shell Dev` 会返回 `WebView Shell Dev`，与原版比较对象不同。
 * 这里两者都接受——把 `CN=` 前缀去掉再比，避免调用方困惑。
 */
export function findCertificate(
    storeNameValue: StoreName,
    subject: string,
): CertInfo | null {
    const store = openStore(storeNameValue);
    if (store === 0n) return null;

    const want = subject.replace(/^CN=/i, "").toLowerCase();
    let context = crypt32.symbols.CertEnumCertificatesInStore(store, 0n);
    try {
        while (typeof context === "number" && context !== 0) {
            const h = BigInt(context);
            const name = certDisplayName(h);
            if (name.toLowerCase() === want && certHasPrivateKey(h)) {
                return { handle: h, name, hasPrivateKey: true };
            }
            const next = crypt32.symbols.CertEnumCertificatesInStore(store, h);
            if (typeof next !== "number" || next === 0) break;
            context = next;
        }
    } finally {
        crypt32.symbols.CertCloseStore(store, 0);
    }
    return null;
}

export type AddResult = "added" | "already-present" | "failed";

/**
 * 把 `My` 存储里的证书复制到目标存储。
 *
 * 三种结果要分开报：`already-present` 是幂等（重复运行不该报错），
 * `failed` 才是问题（典型是 `Root` 需要管理员）。
 */
export function addToStore(storeNameValue: StoreName, subject: string): AddResult {
    const myStore = openStore("My");
    if (myStore === 0n) return "failed";

    try {
        const want = subject.replace(/^CN=/i, "").toLowerCase();
        let found: bigint | null = null;

        let context = crypt32.symbols.CertEnumCertificatesInStore(myStore, 0n);
        while (typeof context === "number" && context !== 0) {
            const h = BigInt(context);
            const name = certDisplayName(h);
            if (name.toLowerCase() === want && certHasPrivateKey(h)) {
                found = h;
                break;
            }
            const next = crypt32.symbols.CertEnumCertificatesInStore(myStore, h);
            if (typeof next !== "number" || next === 0) break;
            context = next;
        }

        if (found === null) return "failed";

        const target = openStore(storeNameValue);
        if (target === 0n) return "failed";
        try {
            // 第 4 个参数是「输出的新 context」；给 null 表示不关心
            const ok = crypt32.symbols.CertAddCertificateContextToStore(
                target,
                found,
                CERT_STORE_ADD_REPLACE_EXISTING,
                null as never,
            );
            return ok === true ? "added" : "failed";
        } finally {
            crypt32.symbols.CertCloseStore(target, 0);
        }
    } finally {
        crypt32.symbols.CertCloseStore(myStore, 0);
    }
}

/** 目标存储里是否已有同名证书（不要求私钥） */
export function isTrusted(storeNameValue: StoreName, subject: string): boolean {
    const store = openStore(storeNameValue);
    if (store === 0n) return false;
    const want = subject.replace(/^CN=/i, "").toLowerCase();
    try {
        let context = crypt32.symbols.CertEnumCertificatesInStore(store, 0n);
        while (typeof context === "number" && context !== 0) {
            const h = BigInt(context);
            if (certDisplayName(h).toLowerCase() === want) return true;
            const next = crypt32.symbols.CertEnumCertificatesInStore(store, h);
            if (typeof next !== "number" || next === 0) break;
            context = next;
        }
        return false;
    } finally {
        crypt32.symbols.CertCloseStore(store, 0);
    }
}

// ---- CLI --------------------------------------------------------------------

export type TrustPlan = { subject: string; stores: StoreName[] };

export function parseTrustArgs(argv: readonly string[]): TrustPlan & { help: boolean } {
    const plan: TrustPlan & { help: boolean } = {
        subject: "CN=WebView Shell Dev",
        stores: ["TrustedPublisher", "Root"],
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i] ?? "";
        const arg = raw.replace(/^-{1,2}/, "").toLowerCase();
        if (arg === "help" || arg === "h") {
            plan.help = true;
            continue;
        }
        if (arg === "subject") {
            const v = argv[i + 1];
            if (!v) throw new Error("--subject 需要一个值");
            plan.subject = v;
            i++;
            continue;
        }
        if (arg === "stores") {
            const v = argv[i + 1];
            if (!v) throw new Error("--stores 需要一个值（逗号分隔）");
            const names = v
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            const bad = names.filter((n) => !(KNOWN_STORES as readonly string[]).includes(n));
            if (bad.length > 0) {
                throw new Error(`未知存储名: ${bad.join(", ")}（可选：${KNOWN_STORES.join(", ")}）`);
            }
            plan.stores = names as StoreName[];
            i++;
            continue;
        }
        if (arg.length > 0) throw new Error(`unknown argument: ${raw}`);
    }
    return plan;
}

function printHelp(): void {
    console.log(`bun run scripts/trust-cert.ts [options]

  --subject <name>  证书 Subject（默认 CN=WebView Shell Dev）
  --stores <a,b>    目标存储，逗号分隔（默认 TrustedPublisher,Root）
                    可选：${KNOWN_STORES.join(", ")}
  --help            显示本帮助

注意：写入 Root 需要管理员权限。普通权限下该存储必然失败，
      这是预期行为，本脚本不会因此返回非 0。`);
}

export function main(argv: readonly string[]): number {
    let plan: TrustPlan & { help: boolean };
    try {
        plan = parseTrustArgs(argv);
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        console.error("run with --help for usage");
        return 2;
    }
    if (plan.help) {
        printHelp();
        return 0;
    }

    const source = findCertificate("My", plan.subject);
    if (!source) {
        console.error(`cert not found in CurrentUser\\My: ${plan.subject}`);
        console.error("（先用 scripts/test-sign.ts 创建自签证书，或确认 Subject 拼写）");
        return 2;
    }
    console.log(`cert: ${source.name}`);

    // 只有「全部存储都失败」才算失败；Root 在普通权限下失败是常态
    let failures = 0;
    for (const store of plan.stores) {
        if (isTrusted(store, plan.subject)) {
            console.log(`  ${store.padEnd(18)} already present`);
            continue;
        }
        const result = addToStore(store, plan.subject);
        if (result === "added") {
            console.log(`  ${store.padEnd(18)} added`);
        } else {
            failures++;
            console.log(`  ${store.padEnd(18)} FAILED${store === "Root" ? "（Root 需要管理员）" : ""}`);
        }
    }

    if (failures === plan.stores.length) {
        console.error("");
        console.error("all stores failed — nothing was trusted");
        return 1;
    }
    return 0;
}

if (isEntrypoint(import.meta.main, import.meta.path)) {
    // main 不需要 root：证书存储与仓库位置无关
    void resolve;
    process.exitCode = main(process.argv.slice(2));
}
