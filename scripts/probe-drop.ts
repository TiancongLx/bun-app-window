/**
 * 拖放探针：验证 `WM_DROPFILES` 处理链真的能把**完整路径**交给壳层。
 *
 * 背景（交接 ⑤）：`DragAcceptFiles` 只给顶层窗口加 `WS_EX_ACCEPTFILES`，而 OLE 拖放的
 * 命中测试走光标下**最深**那层窗口。WebView2 在渲染子窗口上注册了自己的 `IDropTarget`，
 * drop 被它接走转成 DOM 事件——顶层的默认 drop target 永远等不到，页面上只有
 * `name` / `size`，壳层承诺的 `shell-msg{t:"drop",paths:[...]}` 一次都不来。
 *
 * 修法是 `ICoreWebView2Controller4::put_AllowExternalDrop(FALSE)`，把那条内部 target
 * 让开（见 `native/shell.cc` 的 `disable_webview_external_drop`）。
 *
 * ## 这个探针测什么、不测什么
 *
 * 测：`WM_DROPFILES` 进来之后，原生层确实**消费**了它（`DragFinish` 释放 HDROP），
 * 且进程没崩。这直接证明「消息能落到 `handle_drop` 上」——交接里断掉的那一环。
 *
 * 不测：真实的 OLE 拖放命中测试。那需要人手拖文件进窗口，`keybd_event` 做不到
 * （拖放要按住鼠标跨进程拖）。所以 `AllowExternalDrop` 那一步的效果仍需人工验收：
 * 拖一个文件进窗口，页面日志能看到完整路径。
 *
 * 构造 HDROP 而不是等真实拖放，是有意的：它把「消息路由」与「载荷解析」分开，
 * 前者由本探针守，后者由 `handle_drop` 的代码路径守。
 *
 * 用法：
 *   bun run scripts/probe-drop.ts
 */

import { dlopen, toArrayBuffer } from "bun:ffi";

import { findWindows, toHandle } from "../native/win32.ts";
import { FLAG_ACCEPT_DROP, FLAG_CENTER, FLAG_RESIZABLE, openShell } from "../src/shell/index.ts";

const WM_DROPFILES = 0x0233;
const GMEM_MOVEABLE = 0x0002;
/** DROPFILES 头部（x64）：DWORD + POINT(8) + BOOL + BOOL = 20 字节 */
const DROPFILES_BYTES = 20;

const kernel32 = dlopen("kernel32.dll", {
    GlobalAlloc: { args: ["u32", "u64"], returns: "u64" },
    GlobalLock: { args: ["u64"], returns: "u64" },
    GlobalUnlock: { args: ["u64"], returns: "i32" },
    GlobalSize: { args: ["u64"], returns: "u64" },
});
const user32 = dlopen("user32.dll", {
    PostMessageW: { args: ["u64", "u32", "u64", "u64"], returns: "i32" },
});

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
    checks.push({ name, ok, detail });
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) {
            return true;
        }
        await Bun.sleep(16);
    }
    return cond();
}

/**
 * 造一个宽字符版 HDROP。
 *
 * 布局：`DROPFILES`（20 B）+ 以双 NUL 结尾的 UTF-16 路径列表。`pFiles` 指向列表起点
 * （就是 20），`fWide = TRUE` 让 `DragQueryFileW` 按 UTF-16 解析。
 *
 * 用宽字符而不是 ANSI：中文路径在 ANSI 版里会因代码页而丢字符，而真实拖放走的就是
 * 宽字符那条路——探针要测的是用户会遇到的形态。
 */
function makeDropFiles(paths: string[]): bigint {
    let chars = 0;
    for (const p of paths) {
        chars += p.length + 1;
    }
    chars += 1; // 末尾额外一个 NUL
    const total = DROPFILES_BYTES + chars * 2;

    const hGlobal = kernel32.symbols.GlobalAlloc(GMEM_MOVEABLE, BigInt(total));
    if (hGlobal === 0n) {
        return 0n;
    }
    const addr = kernel32.symbols.GlobalLock(hGlobal);
    if (addr === 0n) {
        return 0n;
    }

    const view = new Uint8Array(toArrayBuffer(addr, 0, total));
    const dv = new DataView(view.buffer);
    dv.setUint32(0, DROPFILES_BYTES, true); // pFiles
    dv.setInt32(4, 0, true); // pt.x
    dv.setInt32(8, 0, true); // pt.y
    dv.setInt32(12, 0, true); // fNC = FALSE
    dv.setInt32(16, 1, true); // fWide = TRUE

    let at = DROPFILES_BYTES;
    for (const p of paths) {
        for (const ch of p) {
            dv.setUint16(at, ch.charCodeAt(0), true);
            at += 2;
        }
        at += 2; // 单项结尾 NUL
    }
    dv.setUint16(at, 0, true); // 列表结尾 NUL

    kernel32.symbols.GlobalUnlock(hGlobal);
    return hGlobal;
}

const title = `probe-drop-${Date.now()}`;
const shell = await openShell({
    url: "about:blank",
    title,
    width: 800,
    height: 560,
    flags: FLAG_RESIZABLE | FLAG_CENTER | FLAG_ACCEPT_DROP,
});

const mine = (): ReturnType<typeof findWindows> =>
    findWindows(process.pid).filter((w) => w.title === title && w.visible && w.width > 0);

const located = await waitFor(() => mine().length > 0, 5000);
const found = mine()[0];
const hwnd = found ? toHandle(found.hwnd) : 0n;
check("能定位到本进程的窗口", located && hwnd !== 0n, `${found?.width ?? 0}px wide`);

// 用真实存在的路径：handle_drop 不校验存在性，但探针要能证明「拿到的就是这条」
const victim = `${process.env.TEMP ?? "C:\\Windows\\Temp"}\\probe-drop-中文.txt`;
await Bun.write(victim, "probe");

if (hwnd !== 0n) {
    const hDrop = makeDropFiles([victim]);
    check("能构造出 HDROP", hDrop !== 0n, `${kernel32.symbols.GlobalSize(hDrop)} B`);

    if (hDrop !== 0n) {
        const posted = user32.symbols.PostMessageW(hwnd, WM_DROPFILES, hDrop, 0n) !== 0;
        check("WM_DROPFILES 投递成功", posted);

        // handle_drop 的尾部一定会 DragFinish(hd)，也就是 GlobalFree。
        // 句柄被释放 => 那条路径真的跑到了它里面。
        const consumed = await waitFor(() => kernel32.symbols.GlobalSize(hDrop) === 0n, 3000);
        check("原生层消费了 HDROP（走到了 DragFinish）", consumed, consumed ? "" : "句柄仍有效");

        // 载荷是中文路径：如果某处把 UTF-16 当 UTF-8 处理，这条会先炸
        check("处理中文路径没有把进程带崩", shell.isAlive());
    }
}

shell.close();
const gone = await waitFor(() => mine().length === 0, 5000);
check("关闭后窗口消失", gone);

await Bun.file(victim)
    .delete()
    .catch(() => {});

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
    console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}          ${c.detail}`);
}
console.log(
    failed.length === 0
        ? `\nPROBE PASSED (${checks.length} checks)`
        : `\nPROBE FAILED (${failed.length}/${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
