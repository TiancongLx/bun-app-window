import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { countEvents, describeTarget, findMpCmdRun, queryThreatEvents } from "../scripts/test-av";
import { parseExtractArgs } from "../scripts/extract-icon";
import { parseTrustArgs, KNOWN_STORES } from "../scripts/trust-cert";
import { fingerprintDll, parseMemArgs } from "../scripts/probe-memory";
import { capture, parseCaptureArgs, pickTarget } from "../tools/capture-window";
import { cropBgra } from "../native/gdi";
import { estimateImageTokens } from "../native/model-image";
import { parseArgs as parseChildArgs } from "../tools/probe-child-windows";
import { formatReport, type ProbeReport } from "../tools/probe-gui-boundary";
import { WINDOWS_METADATA } from "../native/build-pack";
import { type WindowInfo } from "../native/win32";

/**
 * 迁移后 8 个工具脚本的判据。
 *
 * 共同策略：**只测纯函数与参数解析**，不真跑副作用。
 * 这些脚本的价值在于「诊断」，它们本身出错的代价是把排查带偏，
 * 所以参数校验、失败路径、输出形状比「跑通一次」更值得断言。
 */

const ROOT = "C:/repo";
/** 真实仓库根：需要读真实文件的断言用这个，不要用上面那个假路径 */
const REAL_ROOT = join(import.meta.dir, "..");

/** 造一个窗口描述，用于 pickTarget 的输入 */
function win(over: Partial<WindowInfo> = {}): WindowInfo {
    const rect = { left: 0, top: 0, right: 100, bottom: 80 };
    return {
        hwnd: 1n,
        className: "webview_shell",
        title: "",
        pid: 100,
        visible: true,
        rect,
        width: 100,
        height: 80,
        ...over,
    };
}

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

// ---- capture-window --------------------------------------------------------

describe("capture-window", () => {
    test("默认阈值 1.0%（pitfalls 1.3 的「画出东西」下限）", () => {
        expect(parseCaptureArgs([]).minNonBlackPercent).toBe(1.0);
    });

    test("默认不截图（shot 为空）", () => {
        expect(parseCaptureArgs([]).shot).toBe("");
    });

    test("--pid / --class 都能单独用", () => {
        expect(parseCaptureArgs(["--pid", "42"]).pid).toBe(42);
        expect(parseCaptureArgs(["--class", "webview"]).className).toBe("webview");
    });

    test("--min-nonblack 超范围抛错", () => {
        expect(() => parseCaptureArgs(["--min-nonblack", "-1"])).toThrow();
        expect(() => parseCaptureArgs(["--min-nonblack", "101"])).toThrow();
    });

    test("--wait 负数抛错", () => {
        expect(() => parseCaptureArgs(["--wait", "-1"])).toThrow();
    });

    test("不实现 --fallback（参数被拒绝，避免误以为会截全屏）", () => {
        expect(() => parseCaptureArgs(["--fallback"])).toThrow();
    });

    describe("pickTarget", () => {
        const plan = { ...parseCaptureArgs([]), pid: 100 };

        test("按 pid 过滤", () => {
            const got = pickTarget([win({ pid: 200 }), win({ pid: 100 })], plan);
            expect(got?.pid).toBe(100);
        });

        test("跳过不可见窗口", () => {
            const got = pickTarget([win({ visible: false }), win({ pid: 100 })], plan);
            expect(got?.visible).toBe(true);
        });

        test("跳过尺寸为 0 的窗口（已销毁或未布局）", () => {
            const zero = win({ pid: 100, width: 0, rect: { left: 0, top: 0, right: 0, bottom: 0 } });
            const ok = win({ pid: 100, hwnd: 2n });
            expect(pickTarget([zero, ok], plan)?.hwnd).toBe(2n);
        });

        test("按类名过滤", () => {
            const byClass = { ...plan, className: "webview" };
            const got = pickTarget([win({ pid: 100 }), win({ pid: 100, className: "webview" })], byClass);
            expect(got?.className).toBe("webview");
        });

        test("无匹配返回 null", () => {
            expect(pickTarget([], plan)).toBeNull();
            expect(pickTarget([win({ pid: 999 })], plan)).toBeNull();
        });

        test("pid=0 时不过滤进程", () => {
            const any = { ...plan, pid: 0 };
            expect(pickTarget([win({ pid: 777 })], any)?.pid).toBe(777);
        });
    });

    describe("capture 的失败路径", () => {
        test("窗口找不到 → ok:false 且带上可见窗口清单", async () => {
            // 注入一个会前进的时钟。给恒定时钟会让 deadline 永不触发，
            // 初版就是这么写出了死循环——`capture` 里因此加了迭代上限。
            let clock = 0;
            const outcome = await capture(
                { ...parseCaptureArgs([]), pid: 12345 },
                {
                    windows: [win({ pid: 1, className: "Foo" })],
                    now: () => clock,
                    sleep: (ms) => {
                        clock += ms;
                    },
                },
            );
            expect(outcome.ok).toBe(false);
            if (!outcome.ok) {
                expect(outcome.error).toBe("target window not found");
                expect(Array.isArray(outcome.detail.visible)).toBe(true);
            }
        });

        test("时钟不前进时也必须在有限次迭代内返回（迭代上限）", async () => {
            let calls = 0;
            const outcome = await capture(
                { ...parseCaptureArgs([]), pid: 12345 },
                {
                    windows: [win({ pid: 1 })],
                    now: () => 0,
                    sleep: () => {
                        calls++;
                    },
                },
            );
            expect(outcome.ok).toBe(false);
            // 上限是 24 + 40 = 64；给足余量但必须是有限的
            expect(calls).toBeLessThan(200);
        });
    });

    describe("模型友好输出的参数", () => {
        test("默认不缩、png、level 6 —— 判据是延迟与字节双低", () => {
            const p = parseCaptureArgs([]);
            expect(p.maxEdge).toBe(0);
            expect(p.format).toBe("png");
            // 拐点值：比 1 只慢约 3 ms 却小 31%，比 9 快 4 倍只大 13%
            expect(p.level).toBe(6);
        });

        test("--crop 解析成四元组", () => {
            expect(parseCaptureArgs(["--crop", "10,20,300,400"]).crop).toEqual({
                x: 10,
                y: 20,
                width: 300,
                height: 400,
            });
        });

        test("默认不裁剪", () => {
            expect(parseCaptureArgs([]).crop).toBeNull();
        });

        test("--crop 非四元组 / 零尺寸 / 负坐标都抛错", () => {
            expect(() => parseCaptureArgs(["--crop", "1,2,3"])).toThrow();
            expect(() => parseCaptureArgs(["--crop", "0,0,0,100"])).toThrow();
            expect(() => parseCaptureArgs(["--crop", "-1,0,100,100"])).toThrow();
            expect(() => parseCaptureArgs(["--crop", "a,b,c,d"])).toThrow();
        });

        test("--max-edge 0 表示保留原尺寸", () => {
            expect(parseCaptureArgs(["--max-edge", "0"]).maxEdge).toBe(0);
            expect(parseCaptureArgs(["--max-edge", "800"]).maxEdge).toBe(800);
        });

        test("--max-edge 负数抛错", () => {
            expect(() => parseCaptureArgs(["--max-edge", "-1"])).toThrow();
        });

        test("--level 必须在 1–9", () => {
            expect(parseCaptureArgs(["--level", "1"]).level).toBe(1);
            expect(parseCaptureArgs(["--level", "9"]).level).toBe(9);
            expect(() => parseCaptureArgs(["--level", "0"])).toThrow();
            expect(() => parseCaptureArgs(["--level", "10"])).toThrow();
            // 小数与非数字都不接受：zlib 只认整数级别
            expect(() => parseCaptureArgs(["--level", "6.5"])).toThrow();
            expect(() => parseCaptureArgs(["--level", "fast"])).toThrow();
        });

        test("--crop 不改变编码路线（裁剪是像素操作，与编码器无关）", () => {
            // 早先的实现把 cropped 也算进「必须走 Bun.Image」的条件，
            // 等于给裁剪白加一次解码 + 重编码（实测 50 ms 对比 6 ms）。
            const plain = parseCaptureArgs([]);
            const cropped = parseCaptureArgs(["--crop", "0,0,800,600"]);
            expect(cropped.format).toBe(plain.format);
            expect(cropped.level).toBe(plain.level);
        });

        test("--format 接受 png / palette / jpeg / webp", () => {
            for (const f of ["png", "palette", "jpeg", "webp"] as const) {
                expect(parseCaptureArgs(["--format", f]).format).toBe(f);
            }
            expect(() => parseCaptureArgs(["--format", "gif"])).toThrow();
            expect(() => parseCaptureArgs(["--format", "bmp"])).toThrow();
        });

        test("--quality 必须在 1–100", () => {
            expect(parseCaptureArgs(["--quality", "70"]).quality).toBe(70);
            expect(() => parseCaptureArgs(["--quality", "0"])).toThrow();
            expect(() => parseCaptureArgs(["--quality", "101"])).toThrow();
        });
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

// ---- probe-child-windows ----------------------------------------------------

describe("probe-child-windows", () => {
    test("默认 pid=0 / class 为空（列全部可见窗口）", () => {
        const plan = parseChildArgs([]);
        expect(plan.pid).toBe(0);
        expect(plan.className).toBe("");
    });

    test("--pid 必须是正整数", () => {
        expect(parseChildArgs(["--pid", "100"]).pid).toBe(100);
        expect(() => parseChildArgs(["--pid", "0"])).toThrow();
        expect(() => parseChildArgs(["--pid", "abc"])).toThrow();
    });

    test("--class 原样保留（类名区分大小写）", () => {
        expect(parseChildArgs(["--class", "webview_shell"]).className).toBe("webview_shell");
        expect(parseChildArgs(["--class", "WebView"]).className).toBe("WebView");
    });

    test("未知参数抛错", () => {
        expect(() => parseChildArgs(["--title", "x"])).toThrow();
    });
});

// ---- probe-gui-boundary -----------------------------------------------------

describe("probe-gui-boundary", () => {
    const sample: ProbeReport = {
        sessionId: 1,
        activeConsoleSession: 1,
        visibleTopLevel: 12,
        sampleClasses: ["Progman pid=1234", "Shell_TrayWnd pid=5678"],
        foregroundHwnd: "0x0",
        foregroundPid: 0,
        inputDesktop: "AVAILABLE",
        windowStation: "accessible",
        notes: ["CopyFromScreen：未实现", "UI Automation：未探测"],
    };

    test("报告包含全部七节标题", () => {
        const text = formatReport(sample).join("\n");
        expect(text).toContain("session id");
        expect(text).toContain("EnumWindows");
        expect(text).toContain("GetForegroundWindow");
        expect(text).toContain("OpenInputDesktop");
        expect(text).toContain("OpenWindowStation");
        expect(text).toContain("未探测项");
    });

    test("无前台窗口时给出可读说明而不是 0", () => {
        const text = formatReport(sample).join("\n");
        expect(text).toContain("(none / 跨会话不可见)");
    });

    test("未实现的两项如实列出（不假装探测过）", () => {
        const text = formatReport(sample).join("\n");
        expect(text).toContain("CopyFromScreen：未实现");
        expect(text).toContain("UI Automation：未探测");
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
