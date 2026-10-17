import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * 这里的断言分三类，各自对应一种真实故障：
 *   1) 解析/形状校验 —— 配置文件被手改坏、被截断、旧版本写的
 *   2) 原子写 —— 关闭时被强杀，半截 JSON 让下次启动读不到位置
 *   3) 变化检测 —— 窗口静止时不该有磁盘写入（轮询 700 ms，一天能写十万次）
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

// ---- 轮询存储：变化检测 ----

test("attachPlacementStore 首次写一次，静止时不再重复写，变化后更新", async () => {
    const file = join(tmpDir(), "poll.json");
    const fake = { text: "100,200,800,600,0,96" };
    // 用一个最小壳替身：只提供 getBounds
    const shell = { getBounds: () => fake.text } as unknown as Parameters<
        typeof attachPlacementStore
    >[0];

    const store = attachPlacementStore(shell, file, { intervalMs: 20 });

    // 首次读数应该落盘一次：程序若在用户操作前崩溃，也还有初始位置可恢复
    await Bun.sleep(60);
    expect(await Bun.file(file).exists()).toBe(true);
    const first = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(first.x).toBe(100);

    // 静止：再不产生写入。用 mtime 判断——内容比较测不出「重复写了同样的值」
    const mtime = statSync(file).mtimeMs;
    await Bun.sleep(80);
    expect(statSync(file).mtimeMs).toBe(mtime);

    // 变化：应写出新值
    fake.text = "300,400,900,700,0,96";
    await Bun.sleep(80);
    store.dispose();
    await store.flush();

    const saved = JSON.parse(readFileSync(file, "utf8")) as WindowPlacement;
    expect(saved.x).toBe(300);
    expect(saved.width).toBe(900);
});

test("attachPlacementStore 忽略解析不出意义的读数（窗口建好前）", async () => {
    const file = join(tmpDir(), "zero.json");
    const shell = { getBounds: () => "0,0,0,0,0,0" } as unknown as Parameters<
        typeof attachPlacementStore
    >[0];
    const store = attachPlacementStore(shell, file, { intervalMs: 20 });
    await Bun.sleep(60);
    store.dispose();
    await store.flush();
    expect(await Bun.file(file).exists()).toBe(false);
});

test("capturePlacement 在读数无意义时返回 null", () => {
    const shell = { getBounds: () => "" } as unknown as Parameters<typeof capturePlacement>[0];
    expect(capturePlacement(shell)).toBeNull();
});
