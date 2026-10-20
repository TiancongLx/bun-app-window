/**
 * `scripts/verify-dll.ts` 的判据。
 *
 * 这个工具回答的是「入库的 DLL 是不是用当前 shell.cc 编出来的」。它的核心逻辑
 * 是纯函数 `verifyCommittedDll`，`build` 由调用方注入 —— 所以这里不需要 clang，
 * 也不需要真的构建，可以用构造字节把每一条失败分支都钉死。
 *
 * 为什么要测：这条判据的失效方式是「假绿」——比如 `SOURCE_DATE_EPOCH` 没生效，
 * 两次构建字节相同，于是「差异集合」为空，无论入库的是什么都会判通过。
 * 那种情况必须**判失败**，否则工具比不存在更危险。
 */

import { describe, expect, test } from "bun:test";

import { diffOffsets, verifyCommittedDll } from "../scripts/verify-dll";

/** 造一份「产物」：前缀固定，尾部是可忽略的差异 */
function fakeDll(fill: number, length = 64): Uint8Array {
    return new Uint8Array(length).fill(fill);
}

/** 在给定偏移上打补丁 */
function patch(src: Uint8Array, changes: Record<number, number>): Uint8Array {
    const out = new Uint8Array(src);
    for (const [k, v] of Object.entries(changes)) out[Number(k)] = v;
    return out;
}

describe("diffOffsets", () => {
    test("相同字节返回空数组", () => {
        expect(diffOffsets(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toEqual([]);
    });

    test("返回每个不同的偏移", () => {
        expect(diffOffsets(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3]))).toEqual([1]);
        expect(diffOffsets(new Uint8Array([0, 0, 0]), new Uint8Array([1, 0, 2]))).toEqual([0, 2]);
    });

    test("长度不同直接抛错，不返回半截结论", () => {
        expect(() => diffOffsets(new Uint8Array([1]), new Uint8Array([1, 2]))).toThrow();
    });
});

describe("verifyCommittedDll", () => {
    // 模拟 clang 的「时间派生字节」：两个偏移随时间变，其余不变
    const TIME_OFFSETS = [8, 9, 40];

    function buildWith(epoch: string): Uint8Array {
        const base = fakeDll(0xaa);
        // 时间戳的低位随 epoch 变，模拟 TimeDateStamp 及其派生字段
        const n = Number(epoch) % 256;
        return patch(base, { 8: n, 9: (n + 1) % 256, 40: (n + 2) % 256 });
    }

    test("同源：时间派生字节之外逐字节相同 → ok", async () => {
        const built = buildWith("100");
        // 入库版只在时间字段上不同，其余与重建一致
        const committed = patch(built, { 8: 0x11, 9: 0x22, 40: 0x33 });

        const r = await verifyCommittedDll({ committed, build: async (e) => buildWith(e) });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.timeDerived).toEqual(TIME_OFFSETS);
            expect(r.size).toBe(64);
        }
    });

    test("陈旧：多一个非时间字节不同 → 判失败并指出偏移", async () => {
        const built = buildWith("100");
        const committed = patch(built, { 8: 0x11, 9: 0x22, 40: 0x33, 20: 0xff });

        const r = await verifyCommittedDll({ committed, build: async (e) => buildWith(e) });

        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toContain("不同源");
            expect(r.detail[0]).toContain("0x14"); // 20 = 0x14
            expect(r.detail[1]).toContain("build:native");
        }
    });

    test("长度不同 → 判失败，给两个长度", async () => {
        const r = await verifyCommittedDll({
            committed: fakeDll(0xaa, 32),
            build: async (e) => buildWith(e),
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toContain("长度不同");
            expect(r.detail[0]).toContain("32");
            expect(r.detail[0]).toContain("64");
        }
    });

    test("两次构建字节完全相同 → 判失败（说明 SOURCE_DATE_EPOCH 没生效）", async () => {
        // 这是最危险的失效模式：差异集合为空 → 无论入库是什么都会「通过」
        const same = fakeDll(0xaa);

        const r = await verifyCommittedDll({
            committed: patch(same, { 20: 0xff }), // 明明陈旧
            build: async () => same, // 但两次构建一样
        });

        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toContain("SOURCE_DATE_EPOCH");
        }
    });

    test("两次构建长度不同 → 判失败（构建不确定，无法判定）", async () => {
        const r = await verifyCommittedDll({
            committed: fakeDll(0xaa),
            build: async (e) => fakeDll(0xaa, e === "1" ? 64 : 32),
            epochA: "1",
            epochB: "2",
        });

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("不确定");
    });
});
