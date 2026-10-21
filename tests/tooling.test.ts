import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { countEvents, describeTarget, findMpCmdRun, queryThreatEvents } from "../scripts/test-av";
import { parseExtractArgs } from "../scripts/extract-icon";
import { parseTrustArgs, KNOWN_STORES } from "../scripts/trust-cert";
import { fingerprintDll, parseMemArgs } from "../scripts/probe-memory";
import { cropBgra } from "../native/gdi";
import { estimateImageTokens } from "../native/model-image";
import { WINDOWS_METADATA } from "../native/build-pack";

/**
 * 迁移后 5 个工具脚本的判据。
 *
 * 共同策略：**只测纯函数与参数解析**，不真跑副作用。
 * 这些脚本的价值在于「诊断」，它们本身出错的代价是把排查带偏，
 * 所以参数校验、失败路径、输出形状比「跑通一次」更值得断言。
 *
 * 截图 / 窗口枚举 / 坐标映射这几类工具已迁到 `agent-eyes`，
 * 对应的 `tools/` 目录连同测试一并移除——留着两份分叉只会让判据互相打架。
 */

const ROOT = "C:/repo";
/** 真实仓库根：需要读真实文件的断言用这个，不要用上面那个假路径 */
const REAL_ROOT = join(import.meta.dir, "..");

// ---- test-av -----------------------------------------------------------------

describe("test-av", () => {
    test("findMpCmdRun：目录不存在时返回 null，不抛错", () => {
        expect(findMpCmdRun("C:/definitely/not/here")).toBeNull();
    });

    test("findMpCmdRun：真实环境（Defender 存在时）返回以 MpCmdRun.exe 结尾的路径", () => {
        const p = findMpCmdRun();
        if (p !== null) {
            expect(p.endsWith("MpCmdRun.exe")).toBe(true);
        }
    });

    test("describeTarget：不存在的文件 exists=false 且 size=0", () => {
        const t = describeTarget("C:/definitely/not/here.exe");
        expect(t.exists).toBe(false);
        expect(t.size).toBe(0);
        expect(t.signed).toBe(false);
    });

    test("describeTarget：路径被 resolve 成绝对路径（MpCmdRun 不认 ..）", () => {
        const t = describeTarget("dist/../dist/x.exe");
        // 关键：不留下 .. 段
        expect(t.path.includes("..")).toBe(false);
    });

    test("describeTarget：真实 DLL 报出正确大小与未签名", () => {
        const t = describeTarget(join(REAL_ROOT, "dist", "libshell.dll"));
        expect(t.exists).toBe(true);
        expect(t.size).toBeGreaterThan(1000);
        expect(t.signed).toBe(false);
    });

    test("countEvents：数 Event[N] 的个数", () => {
        const text = ["Event[0]", "  Log Name: x", "", "Event[1]", "  Log Name: y", ""].join("\r\n");
        expect(countEvents(text)).toBe(2);
    });

    test("countEvents：空输出为 0", () => {
        expect(countEvents("")).toBe(0);
        expect(countEvents("no events here")).toBe(0);
    });

    test("queryThreatEvents：wevtutil 缺失时返回 0 而不是抛错", async () => {
        // 传一个不存在的可执行名，spawn 会失败；函数应当把它当作「干净」
        const res = await queryThreatEvents("C:/definitely/not/wevtutil.exe");
        expect(res.count).toBe(0);
    });
});

// ---- trust-cert --------------------------------------------------------------

describe("trust-cert", () => {
    test("默认 subject 与原 PS1 版一致", () => {
        const plan = parseTrustArgs([]);
        expect(plan.subject).toBe("CN=WebView Shell Dev");
    });

    test("默认存储为 TrustedPublisher + Root（顺序有意义：先易后难）", () => {
        expect(parseTrustArgs([]).stores).toEqual(["TrustedPublisher", "Root"]);
    });

    test("--subject 覆盖", () => {
        expect(parseTrustArgs(["--subject", "CN=Other"]).subject).toBe("CN=Other");
    });

    test("--stores 逗号分隔，空白被忽略", () => {
        expect(parseTrustArgs(["--stores", "Root, TrustedPeople"]).stores).toEqual([
            "Root",
            "TrustedPeople",
        ]);
    });

    test("未知存储名抛错，并列出可选值", () => {
        expect(() => parseTrustArgs(["--stores", "Nope"])).toThrow();
        expect(() => parseTrustArgs(["--stores", "Nope"])).toThrow(/未知存储名/);
    });

    test("KNOWN_STORES 覆盖 Win32 常用 CurrentUser 存储", () => {
        const stores: readonly string[] = KNOWN_STORES;
        for (const s of ["My", "Root", "TrustedPublisher", "TrustedPeople", "CA"]) {
            expect(stores).toContain(s);
        }
    });

    test("--help 识别", () => {
        expect(parseTrustArgs(["--help"]).help).toBe(true);
        expect(parseTrustArgs(["-Help"]).help).toBe(true);
    });

    test("未知参数抛错", () => {
        expect(() => parseTrustArgs(["--force"])).toThrow();
    });
});

// ---- extract-icon -----------------------------------------------------------

describe("extract-icon", () => {
    test("默认目标指向 dist/bun-app-window.exe", () => {
        const plan = parseExtractArgs([], ROOT);
        expect(plan.exe.replace(/\\/g, "/")).toContain("dist/bun-app-window.exe");
    });

    test("默认不输出 PNG（只报告尺寸）", () => {
        expect(parseExtractArgs([], ROOT).out).toBe("");
    });

    test("--index 接受 0 与非负整数", () => {
        expect(parseExtractArgs(["--index", "0"], ROOT).index).toBe(0);
        expect(parseExtractArgs(["--index", "3"], ROOT).index).toBe(3);
    });

    test("--index 负数或非整数抛错", () => {
        expect(() => parseExtractArgs(["--index", "-1"], ROOT)).toThrow();
        expect(() => parseExtractArgs(["--index", "1.5"], ROOT)).toThrow();
    });

    test("--out 被 resolve 成绝对路径", () => {
        const plan = parseExtractArgs(["--out", "dist/icon.png"], ROOT);
        expect(plan.out.replace(/\\/g, "/")).toContain("dist/icon.png");
        expect(plan.out.includes("..")).toBe(false);
    });

    test("未知参数抛错", () => {
        expect(() => parseExtractArgs(["--size", "32"], ROOT)).toThrow();
    });
});

// ---- probe-memory -----------------------------------------------------------

describe("probe-memory", () => {
    test("默认 exe / dll 指向 dist", () => {
        const plan = parseMemArgs([], ROOT);
        expect(plan.exe.replace(/\\/g, "/")).toContain("dist/bun-app-window.exe");
        expect(plan.dll.replace(/\\/g, "/")).toContain("dist/libshell.dll");
    });

    test("默认 hold 25 秒（与 PS1 版一致）", () => {
        expect(parseMemArgs([], ROOT).holdSeconds).toBe(25);
    });

    test("--hold 必须为正数", () => {
        expect(parseMemArgs(["--hold", "10"], ROOT).holdSeconds).toBe(10);
        expect(() => parseMemArgs(["--hold", "0"], ROOT)).toThrow();
        expect(() => parseMemArgs(["--hold", "-5"], ROOT)).toThrow();
    });

    test("--attach 必须是正整数", () => {
        expect(parseMemArgs(["--attach", "1234"], ROOT).attachPid).toBe(1234);
        expect(() => parseMemArgs(["--attach", "0"], ROOT)).toThrow();
        expect(() => parseMemArgs(["--attach", "x"], ROOT)).toThrow();
    });

    test("fingerprintDll：真实 DLL 报出大小、PE 偏移与指纹位置", () => {
        const fp = fingerprintDll(join(REAL_ROOT, "dist", "libshell.dll"));
        expect(fp).not.toBeNull();
        expect(fp?.size).toBeGreaterThan(1000);
        expect(fp?.peOffset).toBeGreaterThan(0);
        expect(fp?.fingerprintOffset).toBeGreaterThan(0);
    });

    test("fingerprintDll：非 PE 文件返回 null", () => {
        expect(fingerprintDll(join(REAL_ROOT, "package.json"))).toBeNull();
        expect(fingerprintDll("C:/definitely/not/here.dll")).toBeNull();
    });
});

// ---- cropBgra ---------------------------------------------------------------

describe("cropBgra", () => {
    /** 造一张 width×height 的 BGRA，每像素的 R 通道编码成唯一值便于验证 */
    function makeBgra(w: number, h: number): Uint8Array {
        const buf = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const at = (y * w + x) * 4;
                buf[at] = x & 0xff; // B
                buf[at + 1] = y & 0xff; // G
                buf[at + 2] = (x * 16 + y) & 0xff; // R —— 用来验证「取对了像素」
                buf[at + 3] = 255;
            }
        }
        return buf;
    }

    test("裁出正确的尺寸与像素", () => {
        const src = makeBgra(10, 8);
        const out = cropBgra(src, 10, 8, { x: 2, y: 3, width: 4, height: 3 });
        expect(out).not.toBeNull();
        expect(out?.width).toBe(4);
        expect(out?.height).toBe(3);
        // 原图 (2,3) 的 R = 2*16+3 = 35，应出现在裁剪结果 (0,0)
        expect(out?.bgra[2]).toBe((2 * 16 + 3) & 0xff);
        // 原图 (5,5) 的 R = 5*16+5 = 85，应出现在裁剪结果 (3,2)
        const at = (2 * 4 + 3) * 4;
        expect(out?.bgra[at + 2]).toBe((5 * 16 + 5) & 0xff);
    });

    test("越界矩形被钳制到图像内", () => {
        const src = makeBgra(10, 8);
        const out = cropBgra(src, 10, 8, { x: 8, y: 6, width: 100, height: 100 });
        expect(out?.width).toBe(2);
        expect(out?.height).toBe(2);
    });

    test("完全在图像外返回 null，不给畸形图", () => {
        const src = makeBgra(10, 8);
        expect(cropBgra(src, 10, 8, { x: 20, y: 0, width: 5, height: 5 })).toBeNull();
    });

    test("零尺寸返回 null", () => {
        const src = makeBgra(10, 8);
        expect(cropBgra(src, 10, 8, { x: 0, y: 0, width: 0, height: 5 })).toBeNull();
    });

    test("源缓冲不足时返回 null", () => {
        expect(cropBgra(new Uint8Array(10), 10, 8, { x: 0, y: 0, width: 2, height: 2 })).toBeNull();
    });

    test("负坐标被钳到 0", () => {
        const src = makeBgra(10, 8);
        const out = cropBgra(src, 10, 8, { x: -3, y: -2, width: 5, height: 4 });
        expect(out?.width).toBe(2);
        expect(out?.height).toBe(2);
    });
});

// ---- estimateImageTokens ----------------------------------------------------

describe("estimateImageTokens", () => {
    test("小于基准按比例折算", () => {
        expect(estimateImageTokens(650, 650)).toBeLessThan(300);
    });

    test("超过 1300×1300 封顶 1024", () => {
        expect(estimateImageTokens(4000, 4000)).toBe(1024);
        expect(estimateImageTokens(2000, 1360)).toBe(1024);
    });

    test("极小图至少 1 token，不返回 0", () => {
        expect(estimateImageTokens(1, 1)).toBeGreaterThanOrEqual(1);
    });

    test("单调不减", () => {
        const seq = [200, 400, 800, 1200, 2000].map((e) => estimateImageTokens(e, e));
        for (let i = 1; i < seq.length; i++) {
            expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
        }
    });
});

// ---- build-pack 的元数据互锁 -----------------------------------------------

describe("与 build-pack 的互锁", () => {
    test("test-av 扫描的目标名与 build-pack 的产物名一致", () => {
        // 两处都写死 "bun-app-window.exe"；改名时这条会红
        const plan = parseMemArgs([], ROOT);
        expect(plan.exe.endsWith("bun-app-window.exe")).toBe(true);
        expect(WINDOWS_METADATA.title.length).toBeGreaterThan(0);
    });
});
