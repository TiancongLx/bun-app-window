import { expect, test } from "bun:test";

import {
    EVENT_CLOSED,
    EVENT_QUEUE_CAPACITY,
    EVENT_RECORD_BYTES,
    EVENT_STATE,
    EV_DARK,
    EV_FOCUSED,
    EV_MAXIMIZED,
    EV_MINIMIZED,
    EventCursor,
    attachEventPump,
    decodeEvents,
    type StateEvent,
    type WindowEvent,
} from "@/shell/events";

/**
 * 窗口生命周期事件的解码与游标。
 *
 * 这一层能测的部分恰好是最容易写错的部分：字节偏移、序号连续性、重启判定、
 * 「CLOSED 之后必须停」。剩下的一半（事件真的会被原生侧写进队列）只能端到端，
 * 见 `scripts/probe-window-events.ts`。
 */

/** 按原生 `EventRecord` 的布局拼一条记录（小端，32 字节定长） */
function record(f: { seq: number; type: number; a?: number; b?: number; c?: number; flags?: number }): Uint8Array {
    const buf = new Uint8Array(EVENT_RECORD_BYTES);
    const view = new DataView(buf.buffer);
    view.setUint32(0, f.seq, true);
    view.setUint32(4, f.type, true);
    view.setInt32(8, f.a ?? 0, true);
    view.setInt32(12, f.b ?? 0, true);
    view.setInt32(16, f.c ?? 0, true);
    view.setInt32(20, 0, true);
    view.setUint32(24, f.flags ?? 0, true);
    view.setUint32(28, 0, true);
    return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
    }
    return out;
}

const state = (seq: number): WindowEvent => ({
    type: EVENT_STATE,
    seq,
    width: 800,
    height: 600,
    dpi: 96,
    maximized: false,
    minimized: false,
    focused: false,
    dark: false,
});

const closed = (seq: number): WindowEvent => ({ type: EVENT_CLOSED, seq });

// ---- decodeEvents ----

test("记录布局是 32 字节", () => {
    // 与 shell.cc 的 static_assert(sizeof(EventRecord) == 32) 成对
    expect(EVENT_RECORD_BYTES).toBe(32);
});

test("decodeEvents 按偏移解出状态位与尺寸", () => {
    const flags = EV_MAXIMIZED | EV_DARK;
    const events = decodeEvents(concat(record({ seq: 3, type: EVENT_STATE, a: 1024, b: 768, c: 144, flags })), 1);
    expect(events).toEqual([
        {
            type: EVENT_STATE,
            seq: 3,
            width: 1024,
            height: 768,
            dpi: 144,
            maximized: true,
            minimized: false,
            focused: false,
            dark: true,
        },
    ]);
});

test("decodeEvents 区分四种状态位，不串位", () => {
    const one = (flags: number): StateEvent | undefined => {
        const e = decodeEvents(concat(record({ seq: 1, type: EVENT_STATE, flags })), 1)[0];
        return e?.type === EVENT_STATE ? e : undefined;
    };
    expect(one(EV_MAXIMIZED)?.maximized).toBe(true);
    expect(one(EV_MAXIMIZED)?.minimized).toBe(false);
    expect(one(EV_MINIMIZED)?.minimized).toBe(true);
    expect(one(EV_FOCUSED)?.focused).toBe(true);
    expect(one(EV_DARK)?.dark).toBe(true);
    expect(one(0)?.maximized).toBe(false);
});

test("decodeEvents 解出 CLOSED，且不带载荷", () => {
    expect(decodeEvents(concat(record({ seq: 9, type: EVENT_CLOSED, a: 111 })), 1)).toEqual([
        { type: EVENT_CLOSED, seq: 9 },
    ]);
});

test("decodeEvents 一次解多条，顺序与写入一致", () => {
    const buf = concat(
        record({ seq: 1, type: EVENT_STATE, a: 10 }),
        record({ seq: 2, type: EVENT_STATE, a: 20 }),
        record({ seq: 3, type: EVENT_CLOSED }),
    );
    const events = decodeEvents(buf, 3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[1]).toMatchObject({ width: 20 });
});

test("decodeEvents 跳过未知类型而不是抛错", () => {
    // 旧宿主遇到将来新增的事件类型应当继续工作：跳过，不崩
    const buf = concat(
        record({ seq: 1, type: EVENT_STATE }),
        record({ seq: 2, type: 99 }),
        record({ seq: 3, type: EVENT_CLOSED }),
    );
    expect(decodeEvents(buf, 3).map((e) => e.seq)).toEqual([1, 3]);
});

test("decodeEvents 把 count 夹在缓冲能容纳的条数内", () => {
    // count 与 buf 由两处代码分别决定：原生改了布局、TS 忘了同步时不能越界读
    const buf = concat(record({ seq: 1, type: EVENT_STATE }), record({ seq: 2, type: EVENT_STATE }));
    expect(decodeEvents(buf, 5).length).toBe(2);
    expect(decodeEvents(buf, -1)).toEqual([]);
    expect(decodeEvents(new Uint8Array(0), 3)).toEqual([]);
});

test("decodeEvents 不因 byteOffset 非零而错位", () => {
    // 若用 buf.buffer 直接建 DataView，子视图会读到错位的字节
    const padding = new Uint8Array(8).fill(0xff);
    const inner = concat(padding, record({ seq: 7, type: EVENT_STATE, a: 640 }));
    const view = inner.subarray(8);
    expect(decodeEvents(view, 1)[0]).toMatchObject({ seq: 7, width: 640 });
});

// ---- EventCursor ----

test("EventCursor 连续事件不报缺口", () => {
    const c = new EventCursor();
    const batch = c.push([state(1), state(2), state(3)]);
    expect(batch.gaps).toEqual([]);
    expect(batch.restarted).toBe(false);
    expect(c.seq).toBe(3);
});

test("EventCursor 首条不是 1 也算缺口（宿主从未读过）", () => {
    // 环满丢了最旧 72 条之后，第一次拉到的就是 73
    const c = new EventCursor();
    expect(c.push([state(73)]).gaps).toEqual([72]);
});

test("EventCursor 中途断档报出丢了多少条", () => {
    const c = new EventCursor();
    c.push([state(1), state(2)]);
    const batch = c.push([state(10)]);
    expect(batch.gaps).toEqual([7]); // 3..9 共 7 条
    expect(c.seq).toBe(10);
});

test("EventCursor 一次拉取里的多段缺口各自成项", () => {
    const c = new EventCursor();
    const batch = c.push([state(1), state(5), state(9)]);
    expect(batch.gaps).toEqual([3, 3]);
});

test("EventCursor 序号回退判定为重启，且不跨重启点算缺口", () => {
    const c = new EventCursor();
    c.push([state(1), state(2), state(3)]);
    const batch = c.push([state(1), state(2)]);
    expect(batch.restarted).toBe(true);
    expect(batch.gaps).toEqual([]); // 重启后的 1 不是「丢了 2 条」
    expect(c.seq).toBe(2);
});

test("EventCursor 重启后继续正常计缺口", () => {
    const c = new EventCursor();
    c.push([state(5)]);
    c.push([state(1)]);
    expect(c.push([state(4)]).gaps).toEqual([2]); // 重启后 2、3 丢了
});

test("EventCursor 把 seq 不前进当作重启（拉取是消费式的，不会重复投递）", () => {
    // `shell_poll_events` 读走即推进读游标，同一条不会再来第二次。所以 seq
    // 不前进只有一种成因：原生层开了新一轮（`reset_events()` 把序号归零）。
    // 「重复投递算不算缺口」这个问题不存在，不要为它发明语义。
    const c = new EventCursor();
    c.push([state(1), state(2)]);
    const batch = c.push([state(2)]);
    expect(batch.restarted).toBe(true);
    expect(batch.gaps).toEqual([]);
    expect(c.seq).toBe(2);
});

test("EventCursor 记 CLOSED，并保持序号", () => {
    const c = new EventCursor();
    c.push([state(1), closed(2)]);
    expect(c.seq).toBe(2);
    expect(c.push([closed(3)]).gaps).toEqual([]);
});

test("EventCursor reset 之后从零开始看", () => {
    const c = new EventCursor();
    c.push([state(50)]);
    c.reset();
    expect(c.seq).toBe(0);
    expect(c.push([state(1)]).gaps).toEqual([]);
});

// ---- attachEventPump ----

/** 可控事件源：`feed()` 排一批，`pollEvents()` 取走 */
function fakeSource() {
    const batches: WindowEvent[][] = [];
    let throws = false;
    return {
        pollEvents(): WindowEvent[] {
            if (throws) {
                throw new Error("native gone");
            }
            return batches.shift() ?? [];
        },
        feed(...events: WindowEvent[]): void {
            batches.push(events);
        },
        breakIt(): void {
            throws = true;
        },
    };
}

test("attachEventPump 按节奏把事件分发给订阅者", async () => {
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    const seen: number[] = [];
    pump.on((e) => seen.push(e.seq));

    src.feed(state(1), state(2));
    await Bun.sleep(30);
    pump.stop();

    expect(seen).toEqual([1, 2]);
    expect(pump.seq).toBe(2);
});

test("attachEventPump 支持多路订阅同一批事件", async () => {
    // 一个窗口只该有一个消费者：多路关心时用多个 on()，不是多个泵
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    let a = 0;
    let b = 0;
    pump.on(() => {
        a++;
    });
    pump.on(() => {
        b++;
    });

    src.feed(state(1), state(2), state(3));
    await Bun.sleep(30);
    pump.stop();

    expect(a).toBe(3);
    expect(b).toBe(3);
});

test("attachEventPump 把缺口交给 onGap 而不是静默吞掉", async () => {
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    const gaps: number[] = [];
    pump.onGap((n) => gaps.push(n));

    src.feed(state(1), state(9)); // 2..8 丢了
    await Bun.sleep(30);
    pump.stop();

    expect(gaps).toEqual([7]);
});

test("attachEventPump 收到 CLOSED 后自动停止", async () => {
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    let closedSeen = 0;
    pump.on((e) => {
        if (e.type === EVENT_CLOSED) closedSeen++;
    });

    src.feed(closed(1));
    await Bun.sleep(30);

    expect(closedSeen).toBe(1);
    // 终态之后留着定时器只是白烧 CPU
    expect(pump.running).toBe(false);

    pump.stop(); // 幂等
    expect(pump.running).toBe(false);
});

test("attachEventPump 的退订立即生效", async () => {
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    let hits = 0;
    const off = pump.on(() => {
        hits++;
    });
    off();

    src.feed(state(1));
    await Bun.sleep(30);
    pump.stop();

    expect(hits).toBe(0);
});

test("attachEventPump 不被事件源的异常打死", async () => {
    // 定时器回调里抛出的异常会终止进程，而「原生库已卸载」不该让宿主崩
    const src = fakeSource();
    const pump = attachEventPump(src, { intervalMs: 5 });
    let hits = 0;
    pump.on(() => {
        hits++;
    });

    src.breakIt();
    await Bun.sleep(20);
    expect(pump.running).toBe(true);

    pump.stop();
    expect(hits).toBe(0);
});

test("attachEventPump 把 maxBatch 夹在原生容量内", async () => {
    const src = fakeSource();
    const asked: number[] = [];
    const spy = {
        pollEvents(max?: number): WindowEvent[] {
            asked.push(max ?? -1);
            return src.pollEvents();
        },
    };
    const pump = attachEventPump(spy, { intervalMs: 5, maxBatch: 9999 });
    await Bun.sleep(20);
    pump.stop();

    expect(asked.length).toBeGreaterThan(0);
    // 要超过 128 条只会开到永远填不满的缓冲
    expect(asked.every((n) => n >= 1 && n <= EVENT_QUEUE_CAPACITY)).toBe(true);
});
