import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVENT_STATE, type EventPump, type WindowEvent } from "@/shell/events";
import {
    capturePlacement,
    loadPlacement,
    parseBounds,
    parsePlacement,
    savePlacement,
    attachPlacementStore,
    type WindowPlacement,
} from "@/shell/state";

/**
 * 窗口位置持久化。
 *
 * 这里的断言分四类，各自对应一种真实故障：
 *   1) 解析/形状校验 —— 配置文件被手改坏、被截断、旧版本写的
 *   2) 原子写 —— 关闭时被强杀，半截 JSON 让下次启动读不到位置
 *   3) 变化检测 —— 窗口静止时不该有磁盘写入
 *   4) 快照先于写盘 —— 窗口关闭后 `getBounds()` 立刻返回空串，若等防抖到点才去读，
 *      最后那次位置变化就永久丢了（「拖完立刻点 X」是最常见的关闭方式）
 *
 * 事件源用假泵注入，不靠真定时器：靠 sleep 竞速的断言在慢机器上会随机红。
 */

const dirs: string[] = [];
function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), "shell-state-"));
    dirs.push(d);
    return d;
}
afterEach(() => {
    while (dirs.length) {
        const d = dirs.pop();
        if (d) rmSync(d, { recursive: true, force: true });
    }
});

/** 一条 STATE 事件；载荷对本测试无意义，只有 `type` 与到达时机起作用 */
function stateEvent(seq: number): WindowEvent {
    return {
        type: EVENT_STATE,
        seq,
        width: 1,
        height: 1,
        dpi: 96,
        maximized: false,
        minimized: false,
        focused: false,
        dark: false,
    };
}

/** 可控的事件泵替身：`emit()` 就是「宿主拉到一条事件」 */
function fakePump(): { pump: EventPump; emit: (e: WindowEvent) => void } {
    const fns = new Set<(e: WindowEvent) => void>();
    let seq = 0;
    const pump: EventPump = {
        on(fn) {
            fns.add(fn);
            return () => {
                fns.delete(fn);
            };
        },
        onGap() {
            return () => {};
        },
        stop() {
            // 假泵没有定时器
        },
        running: true,
        get seq() {
            return seq;
        },
    };
    return {
        pump,
        emit(e) {
            seq = e.seq;
            for (const fn of fns) fn(e);
        },
    };
}

/** 只提供 getBounds 的壳替身（pollEvents 由注入的泵取代） */
function fakeShell(read: () => string): Parameters<typeof attachPlacementStore>[0] {
    return { getBounds: read, pollEvents: () => [] } as unknown as Parameters<typeof attachPlacementStore>[0];
}

// ---- parseBounds：原生文本 → 结构 ----

test("parseBounds 解析原生六字段", () => {
    expect(parseBounds("100,200,800,600,0,192")).toEqual({
        x: 100,
        y: 200,
        width: 800,
        height: 600,
        maximized: false,
        dpi: 192,
    });
});

test("parseBounds 识别最大化标记", () => {
    const p = parseBounds("-1920,0,1600,900,1,96");
    expect(p?.maximized).toBe(true);
    expect(p?.x).toBe(-1920); // 负坐标是合法的（副屏在左侧）
});

test("parseBounds 拒绝残缺与非法输入", () => {
    expect(parseBounds("")).toBeNull();
    expect(parseBounds("1,2,3")).toBeNull();
    expect(parseBounds("1,2,3,4,5,6,7")).toBeNull();
    expect(parseBounds("a,b,c,d,e,f")).toBeNull();
    // 窗口未建好时尺寸为 0
    expect(parseBounds("0,0,0,0,0,192")).toBeNull();
    // DPI 为 0 说明读不到，不可用于恢复
    expect(parseBounds("0,0,800,600,0,0")).toBeNull();
});

/**
 * 最小化时 `GetWindowRect` 给的是 Win32 哨兵坐标，不是真实位置。
 *
 * 这对值形状完全合法（整数坐标、正尺寸），所以只有专门的判据能拦住它。
 * 原生 `format_bounds` 只在 `IsZoomed` 为真时走 `WINDOWPLACEMENT`，最小化会
 * 落进 `GetWindowRect` 分支——`IsIconic` 从未被判断，于是 `-32000,-32000 314x50`
 * 会被原样写成 `{"x":-32000,...}`，下次启动恢复成一个畸形小窗。
 *
 * 实测现场：无边框窗口变成 666×471，页面被挤到换行并出现滚动条。
 */
test("parseBounds 拒绝最小化哨兵坐标", () => {
    // 实测读到的原值
    expect(parseBounds("-32000,-32000,314,50,0,192")).toBeNull();
    // 带几个像素偏移的变体（不同 DPI / 主题下会出现）
    expect(parseBounds("-31996,-31996,160,28,0,96")).toBeNull();
    // 只有一维是哨兵也要拒——两维本来同时写，出现单边说明数据已经坏了
    expect(parseBounds("-32000,100,800,600,0,96")).toBeNull();
    // 但合法的负坐标必须继续通过：主屏在右、副屏在左时 x 真的是负数
    expect(parseBounds("-1920,0,1600,900,1,96")?.x).toBe(-1920);
    expect(parseBounds("-3840,120,1920,1080,0,96")?.x).toBe(-3840);
});

// ---- parsePlacement：磁盘 JSON → 结构 ----

test("parsePlacement 接受合法对象", () => {
    const ok: WindowPlacement = { x: 10, y: 20, width: 900, height: 700, maximized: true, dpi: 144 };
    expect(parsePlacement(ok)).toEqual(ok);
});

test("parsePlacement 拒绝缺字段 / 类型错 / 越界", () => {
    expect(parsePlacement(null)).toBeNull();
    expect(parsePlacement("x")).toBeNull();
    expect(parsePlacement({})).toBeNull();
    expect(parsePlacement({ x: 0, y: 0, width: 800, height: 600 })).toBeNull(); // 缺 dpi
    expect(parsePlacement({ x: "0", y: 0, width: 800, height: 600, dpi: 96 })).toBeNull();
    expect(parsePlacement({ x: 0, y: 0, width: 0, height: 600, dpi: 96 })).toBeNull();
    // 8K 也只有 7680，20000 以上一定是坏数据
    expect(parsePlacement({ x: 0, y: 0, width: 99999, height: 600, dpi: 96 })).toBeNull();
    expect(parsePlacement({ x: 1e9, y: 0, width: 800, height: 600, dpi: 96 })).toBeNull();
});

test("parsePlacement 把非 true 的 maximized 一律视为 false", () => {
    const base = { x: 0, y: 0, width: 800, height: 600, dpi: 96 };
    expect(parsePlacement({ ...base, maximized: "yes" })?.maximized).toBe(false);
    expect(parsePlacement({ ...base, maximized: 1 })?.maximized).toBe(false);
    expect(parsePlacement({ ...base, maximized: true })?.maximized).toBe(true);
});

/**
 * 已写进磁盘的哨兵坐标同样要判否。
 *
 * 修好抓取端只解决「以后不再写坏值」，磁盘上那些旧文件还是会存在——不判否的话，
 * 用户升级后第一次启动仍会恢复成畸形小窗，看起来像「根本没修」。
 */
test("parsePlacement 拒绝磁盘上的最小化哨兵坐标", () => {
    expect(parsePlacement({ x: -32000, y: -32000, width: 314, height: 50, dpi: 192 })).toBeNull();
    expect(parsePlacement({ x: -32000, y: 0, width: 800, height: 600, dpi: 96 })).toBeNull();
    // 合法负坐标不受影响
    const left = { x: -1920, y: 0, width: 1600, height: 900, dpi: 96 };
    expect(parsePlacement(left)).toEqual({ ...left, maximized: false });
});

// ---- 读写盘 ----

test("savePlacement 写入后 loadPlacement 能读回", async () => {
    const file = join(tmpDir(), "win.json");
    const p: WindowPlacement = { x: 623, y: 56, width: 1826, height: 1711, maximized: false, dpi: 192 };
    await savePlacement(file, p);
    expect(await loadPlacement(file)).toEqual(p);
});

test("savePlacement 不留下 .tmp 残件（改名是原子的）", async () => {
    const dir = tmpDir();
    const file = join(dir, "win.json");
    await savePlacement(file, { x: 1, y: 2, width: 300, height: 200, maximized: false, dpi: 96 });
    const leftovers = [...new Bun.Glob("*.tmp").scanSync({ cwd: dir })];
    expect(leftovers).toEqual([]);
});

test("loadPlacement 对不存在 / 损坏 / 形状错的文件返回 null", async () => {
    const dir = tmpDir();
    expect(await loadPlacement(join(dir, "nope.json"))).toBeNull();

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ 这不是 JSON");
    expect(await loadPlacement(broken)).toBeNull();

    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ hello: 1 }));
    expect(await loadPlacement(wrong)).toBeNull();
});

test("loadPlacement 容忍手改后多余字段", async () => {
    const file = join(tmpDir(), "extra.json");
    writeFileSync(
        file,
        JSON.stringify({ x: 5, y: 6, width: 700, height: 500, maximized: false, dpi: 96, note: "手改" }),
    );
    expect(await loadPlacement(file)).toEqual({
        x: 5,
        y: 6,
        width: 700,
        height: 500,
        maximized: false,
        dpi: 96,
    });
});

// ---- 事件驱动的存储：变化检测 ----

test("attachPlacementStore 首次写一次，静止时不再重复写，变化后更新", async () => {
    const file = join(tmpDir(), "event.json");
    const text = { value: "100,200,800,600,0,96" };
    const { pump, emit } = fakePump();

    const store = attachPlacementStore(
        fakeShell(() => text.value),
        file,
        {
            debounceMs: 10,
            events: pump,
        },
    );

    // 首次快照应该落盘一次：程序若在用户操作前崩溃，也还有初始位置可恢复
    await store.flush();
    expect(await Bun.file(file).exists()).toBe(true);
    const first = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(first.x).toBe(100);

    // 静止：事件到了但读数没变，不产生写入。
    // 用 mtime 判断——内容比较测不出「重复写了同样的值」
    const mtime = statSync(file).mtimeMs;
    emit(stateEvent(1));
    await Bun.sleep(40);
    expect(statSync(file).mtimeMs).toBe(mtime);

    // 变化：事件到达即取快照，防抖到点写盘
    text.value = "300,400,900,700,0,96";
    emit(stateEvent(2));
    await Bun.sleep(40);
    store.dispose();

    const saved = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(saved.x).toBe(300);
    expect(saved.width).toBe(900);
});

test("attachPlacementStore 忽略解析不出意义的读数（窗口建好前）", async () => {
    const file = join(tmpDir(), "zero.json");
    const { pump, emit } = fakePump();
    const store = attachPlacementStore(
        fakeShell(() => "0,0,0,0,0,0"),
        file,
        {
            debounceMs: 10,
            events: pump,
        },
    );
    emit(stateEvent(1));
    await Bun.sleep(40);
    store.dispose();
    await store.flush();
    expect(await Bun.file(file).exists()).toBe(false);
});

/**
 * 最小化读数到达时，必须保留上一次的**真实**位置。
 *
 * 这是那个 bug 的完整现场：拖好窗口 → 最小化 → 位置变化事件到达 →
 * `window.json` 变成 `{"x":-32000,"width":314,"height":50}` → 下次启动一个畸形小窗。
 *
 * 判据取「文件里仍是旧值」而不是「文件没被写」：`flush()` 会重写一次，
 * 要求「完全不写」会把实现细节焊死；要求「值没被污染」才是我们要的性质。
 */
test("attachPlacementStore 在最小化读数到达时保留上一次真实位置", async () => {
    const file = join(tmpDir(), "minimized.json");
    const text = { value: "300,400,900,700,0,96" };
    const { pump, emit } = fakePump();

    const store = attachPlacementStore(
        fakeShell(() => text.value),
        file,
        {
            debounceMs: 10,
            events: pump,
        },
    );
    await store.flush();
    expect((JSON.parse(readFileSync(file, "utf8")) as WindowPlacement).x).toBe(300);

    // 窗口被最小化：原生 format_bounds 落进 GetWindowRect 分支，给出哨兵坐标
    text.value = "-32000,-32000,314,50,0,96";
    emit(stateEvent(2));
    await Bun.sleep(40);
    await store.flush();
    store.dispose();

    const saved = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(saved.x).toBe(300);
    expect(saved.y).toBe(400);
    expect(saved.width).toBe(900);
    expect(saved.height).toBe(700);
});

/**
 * 快照必须早于写盘。
 *
 * 反过来的写法（防抖到点才去 `getBounds()`）在真机上会静默丢掉最后一次变化：
 * 窗口一旦销毁，原生侧 `format_bounds()` 里 `!g_hwnd` 直接返回 0 长度文本。
 * 用户「拖完立刻点 X」正好命中这个窗口期。
 */
test("getBounds 变空之后，已取到的快照仍会落盘", async () => {
    const file = join(tmpDir(), "close.json");
    const text = { value: "10,20,700,500,0,96" };
    const { pump, emit } = fakePump();

    const store = attachPlacementStore(
        fakeShell(() => text.value),
        file,
        {
            debounceMs: 30,
            events: pump,
        },
    );

    text.value = "40,50,900,700,0,96";
    emit(stateEvent(2)); // 快照在这一刻取到真实值
    text.value = ""; // 窗口随即销毁，之后再读是空串
    await Bun.sleep(60);
    store.dispose();

    const saved = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(saved.x).toBe(40);
    expect(saved.width).toBe(900);
});

test("dispose 之后不再写盘", async () => {
    const file = join(tmpDir(), "disposed.json");
    const text = { value: "1,2,300,200,0,96" };
    const { pump, emit } = fakePump();
    const store = attachPlacementStore(
        fakeShell(() => text.value),
        file,
        {
            debounceMs: 10,
            events: pump,
        },
    );
    await store.flush();
    store.dispose();

    text.value = "9,9,999,999,0,96";
    emit(stateEvent(2));
    await Bun.sleep(30);
    const saved = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(saved.x).toBe(1);
});

test("capturePlacement 在读数无意义时返回 null", () => {
    const shell = { getBounds: () => "" } as unknown as Parameters<typeof capturePlacement>[0];
    expect(capturePlacement(shell)).toBeNull();
});
