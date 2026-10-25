# bun-app-window

[![npm version](https://img.shields.io/npm/v/bun-app-window?color=cb3837&logo=npm)](https://www.npmjs.com/package/bun-app-window)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.4.4-f472b6?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-%3E%3D7.0.2-3178C6?logo=typescript&logoColor=white)](#requirements--design-boundaries)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#requirements--design-boundaries)
[![WebView2](https://img.shields.io/badge/WebView2-System%20Runtime-008080)](#requirements--design-boundaries)
[![License](https://img.shields.io/badge/License-MIT-2ea44f)](./LICENSE)

English | [简体中文](./README.zh-CN.md) | [正體中文](./README.zh-TW.md)

A native window shell for Bun applications on Windows, hosting web UIs via the system WebView2 runtime without bundling a browser.

This library maintains a strict, minimal scope: it handles window lifecycle, DPI-aware geometry, frameless chrome customization, and the native message channel. Business logic and UI rendering live entirely outside the shell.

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS } from "bun-app-window";

const server = serveOnSafePort({ fetch: () => new Response("<h1>Hello</h1>") });
await openShell({ url: `http://127.0.0.1:${server.port}`, flags: FLAG_FRAMELESS });
```

---

## Requirements & Design Boundaries

Before adopting this package, please review the following architectural constraints and trade-offs:

| Constraint                           | Implication                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64 only                     | Enforced via `os` and `cpu` fields in `package.json` (the platform-neutral package name is reserved for future expansion). A prebuilt `libshell.dll` is shipped in the package; no install-time compilation is required                                                                                               |
| Bun runtime required                 | Ships raw TypeScript source files and requires Bun >= 1.4.4. While Node.js can install the package, it cannot execute it                                                                                                                                                                                              |
| TypeScript >= 7.0.2 to type-check it | The API is designed and checked on TypeScript 7.0.2, pinned exactly in `devDependencies`; no compatibility work is done for older compilers. Above 7.0.2 the outcome is unasserted — `bun-types` only opens its `typesVersions: ">= 7.1"` gate there, which changes what a `with { type: "text" }` import resolves to |
| Type-checking needs `@types/bun`     | Because the package ships `.ts` sources, your own `bun check` compiles them too. Add `bun add -d @types/bun`; without it the checker reports `TS2868: Cannot find name 'Bun'` from inside `node_modules`                                                                                                              |
| Built on `bun:ffi`                   | `bun:ffi` is marked as experimental in Bun. While Bun recommends Node-API for production stability, this library chooses `bun:ffi` to achieve a zero-dependency footprint                                                                                                                                             |

Runtime prerequisites and non-goals:

- System WebView2 Runtime: Requires the evergreen WebView2 Runtime installed on the host machine (pre-installed on Windows 11).
- Interactive desktop session: Due to Windows Session 0 isolation, WebView2 cannot run inside non-interactive background services. However, running inside elevated (High Integrity Level) administrator processes is fully supported.
- Explicit non-goals: System tray icons, native application menu bars, auto-updaters, multi-window orchestration, and cross-platform abstractions.

## Installation

```bash
bun add bun-app-window
```

### What the tarball contains

The published package holds the prebuilt `dist/libshell.dll` plus the TypeScript sources — 22 files, 0.50 MB packed (1.47 MB unpacked). The native C++ layer (`native/`) and the vendored upstream headers (`vendor/`) are **not** shipped: they are only needed to rebuild `libshell.dll`, and rebuilding requires cloning the repository. `bun run build:native` and `build:exe` are therefore repository-only scripts that do nothing useful inside `node_modules`.

## Quick Start

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";

const server = serveOnSafePort({
    fetch: () =>
        new Response("<h1>Hello</h1>", {
            headers: { "content-type": "text/html; charset=utf-8" },
        }),
});

const shell = await openShell({
    url: `http://127.0.0.1:${server.port}`,
    title: "My App",
    width: 1000,
    height: 680,
    flags: FLAG_FRAMELESS | FLAG_CENTER,
    minWidth: 480,
    minHeight: 320,
});

shell.post(JSON.stringify({ t: "ready" })); // Host -> Page one-way message
shell.setTitle("Doing work…");
```

Note: `createShell(opts)` only resolves and loads the native DLL without opening a window. `openShell(opts)` creates the instance, starts the window immediately, and throws an error on failure.

## Core API

`ackOf(shell, rc)` turns a bare status code into `{ rc, err }` and only reads `lastError()` on
failure — the native error slot is not cleared by a successful call, so reading it afterwards
returns a stale message that looks like a fresh failure.

### Instance Methods & Properties

| Member                                               | Description                                                                                                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                                            | Opens the window and returns `{ rc, error }`. Returns immediately while the UI message loop runs on a dedicated native thread                                                                                                     |
| `stop()`                                             | Destroys the window and releases native resources. Safe to call multiple times (idempotent)                                                                                                                                       |
| `show()`                                             | Reveals the window. Typically paired with `FLAG_DEFER_SHOW` to display the window only after the web UI is ready                                                                                                                  |
| `isAlive()`                                          | Checks whether the native window still exists (unlike `state()`, which cannot distinguish between unstarted and destroyed states). To wait for close, use `pollEvents()` and watch for `CLOSED` instead of polling this           |
| `pollEvents(max?)`                                   | Drains window lifecycle events (`STATE` / `CLOSED`); synchronous and consuming. See "Window events" below                                                                                                                         |
| `state()`                                            | Returns current window state: `{ maximized, minimized, focused, dark, raw }`                                                                                                                                                      |
| `lastError()`                                        | Returns the most recent failure message, or an empty string if no error occurred                                                                                                                                                  |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | Standard window control operations; each returns a status code `rc`                                                                                                                                                               |
| `setMinSize(w, h)`                                   | Sets the minimum window dimensions in logical pixels                                                                                                                                                                              |
| `drag()`                                             | Initiates native window dragging from a page `pointerdown` event (preserves Windows Snap Layouts)                                                                                                                                 |
| `beginResize(edge)`                                  | Initiates native border resizing from a page `pointermove` event (`edge` uses `RESIZE_EDGE.*` constants)                                                                                                                          |
| `post(json)`                                         | Sends a fire-and-forget JSON message from the host to the web page                                                                                                                                                                |
| `setZoom(f)` / `getZoom()`                           | Gets or sets the page zoom factor (clamped automatically to `0.25`–`3.0`)                                                                                                                                                         |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | Equivalent to `Ctrl+R`, `F12`, and `F11` respectively                                                                                                                                                                             |
| `setFrameless(frameless)` / `isFrameless()`          | Switches the window form at runtime and reports the current one. Only a window **created** with `FLAG_FRAMELESS` can switch; a framed-created window refuses with `rc=-1` and a reason in `lastError()`. See "Window Flags" below |
| `setBrowserUi(mask)`                                 | Disables specific default browser behaviors using a bitwise OR of `BROWSER_UI_*` flags                                                                                                                                            |
| `showContextMenu(x, y, items)`                       | Displays a native Win32 context menu at the specified screen coordinates (see below)                                                                                                                                              |
| `pickFolder(title?)`                                 | Opens a native folder selection dialog (synchronously blocks the calling thread; **when exposed over IPC, pair it with `timeoutMs: 0`**, see below)                                                                               |
| `libInfo`                                            | Metadata of the resolved native library (file path, resolution source, SHA-256 hash)                                                                                                                                              |
| `symbols`                                            | Escape hatch providing direct access to the raw `dlopen` FFI symbols                                                                                                                                                              |

### Window Flags

Combine via bitwise OR (`|`) and pass to `opts.flags`:

| Flag                      | Description                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLAG_FRAMELESS`          | Creates a frameless window without the default system title bar, delegating title bar rendering to the web UI. A window created this way can switch back to framed at runtime with `setFrameless(false)`                                                                                                                                                                                |
| `FLAG_RESIZABLE`          | Allows user resizing                                                                                                                                                                                                                                                                                                                                                                    |
| `FLAG_CENTER`             | Centers the window within the active monitor work area on startup (works in both standard and frameless modes)                                                                                                                                                                                                                                                                          |
| `FLAG_TOPMOST`            | Keeps the window always on top                                                                                                                                                                                                                                                                                                                                                          |
| `FLAG_DEFER_SHOW`         | Creates the window hidden initially until `show()` is explicitly called                                                                                                                                                                                                                                                                                                                 |
| `FLAG_ACCEPT_DROP`        | Enables native file and folder drag-and-drop from Windows Explorer                                                                                                                                                                                                                                                                                                                      |
| `FLAG_START_MAXIMIZED`    | Opens the window directly in a maximized state without an intermediate normal-sized frame flash                                                                                                                                                                                                                                                                                         |
| `FLAG_ALLOW_EXTERNAL_NAV` | Opts out of external-navigation interception — for apps that genuinely are browsers                                                                                                                                                                                                                                                                                                     |
| `FLAG_TITLEBAR_RESERVE`   | In frameless mode, shifts the web content down by one title-bar height so the top strip belongs to the native window. Superseded by `FLAG_NATIVE_CAPTIONS`: the caption hit zone is pinned to client `y ∈ [0, 32)`, so this variant puts the page's own title bar 32 px away from where clicks are actually routed                                                                      |
| `FLAG_NATIVE_CAPTIONS`    | In frameless mode, draws the three caption buttons on a layered child window owned by the shell and answers `HTMAXBUTTON` there. This is the only way Snap Layouts can trigger: the WebView2 render child lives in another process and always returns `HTCLIENT`. Pair it with `mountTitleBar({ captions: "native" })` so the page reserves `46 × 3` instead of drawing its own buttons |

### External navigation is blocked by default

Without `FLAG_ALLOW_EXTERNAL_NAV`, a cross-origin link can no longer navigate the app away.
The shell cancels the navigation and hands the URL to the system browser instead:

- **Same origin** (or, for `file://` / other origin-less startup URLs, the same document
  ignoring the `#fragment`) stays inside the window. In-app routing keeps working.
- **Cross origin** is cancelled and opened externally — but only for `http:` / `https:`.
  `file:`, `javascript:`, `ms-*:` and custom schemes are cancelled silently and never
  reach a protocol handler. `mailto:` / `tel:` are deliberately not allowed.
- **`window.open` / `target=_blank`** is always cancelled and opened externally, even with
  `FLAG_ALLOW_EXTERNAL_NAV`. That is a capability boundary, not a policy: the shell owns a
  single top-level window (native side is a process-level singleton), so a second window
  would have no host API to manage it.

A desktop shell has no address bar and no back button, and no host API can navigate the page
back — so a single mis-click would otherwise replace the app with that website. That is why
the default picks the safe side.

## Subpath Exports

Additional capabilities outside core window management are modularized into dedicated subpath exports.

### `bun-app-window/app` — Application Skeleton

The first app you write with this package is about 30 lines of business code and **180 lines of
host boilerplate**: picking a safe port, minting an auth token, handling the WebSocket upgrade,
serving the HTML as a string, wiring `createIpcServer` into Bun's websocket callbacks, composing
window flags, handling `openShell` failure, waiting for close (`EVENT_CLOSED`), and calling
`stop()` on two things in the right order. Each piece is easy; they are only correct in a specific
order (`stop()` must wait for the window to actually die before closing the server, or the next
start hits "already started"). `app` collapses all of it into one call:

```ts
// main.ts
import { createApp } from "bun-app-window/app";
import { BROWSER_UI_ALL, FLAG_FRAMELESS } from "bun-app-window";
import htmlText from "./index.html" with { type: "text" };

// `with { type: "text" }` inlines the file at build time, so it survives `bun build --compile`.
// TS 7.0.2 cannot see that declaration — bun-types gates it behind `typesVersions >= 7.1`,
// so the import resolves to `HTMLBundle` instead of `string`. Hence the bridge.
const html = htmlText as unknown as string;

const app = await createApp({
    html,
    title: "My App",
    flags: FLAG_FRAMELESS, // opt in to a self-drawn title bar
    browserUi: BROWSER_UI_ALL,
    service: {
        greet: (name: string) => `hi ${name}`,
        pickFolder: () => app.shell.pickFolder(),
    },
});

await app.wait(); // resolves when the window closes
await app.stop(); // releases the event pump and the server; idempotent
```

Pass `page` to serve a bundled page script without writing a route yourself. `createApp` answers
`PAGE_JS_PATH` (`/page.js`) with the right `content-type`, which is the part that silently breaks:
a module script served as `text/plain` is refused with no syntax error, so the page renders and
nothing runs.

```ts
import { bundlePage } from "bun-app-window/pack";

// Build time, not startup — see the `pack` section below.
const { code } = await bundlePage({ entry: "src/ui/page.ts" });

const app = await createApp({ html, page: code, service });
```

Two more things on `App` that save a call and a subpath import:

- `app.debug` — the same object `debugOf(app.shell)` returns. Still outside the stability contract.
- `app.attachPlacement(file)` — wires placement persistence to the skeleton's **single** event pump.
  Call `attachPlacementStore` yourself and forget `{ events: app.events }`, and it starts a second
  pump; since `shell.pollEvents()` is consumptive, the two split the stream and window position is
  dropped at random with no error on either side. This method makes that mistake unrepresentable.

```ts
// page.ts — inside index.html's bundle
import { connect } from "bun-app-window/ipc";
const api = await connect(); // token comes from the page URL's ?t=
await api.greet("Ada");
```

What it does for you:

- Binds a browser-safe port (never one that yields `ERR_UNSAFE_PORT`) and serves your HTML.
- Generates a per-run token and guards `/ws` with it **before** the upgrade — after upgrading there
  is no chance to refuse. `/ws` with IPC disabled is a `404`, not a `403`: a 403 would advertise
  that a channel exists.
- Wires `createIpcServer` into the websocket `open` / `message` / `close` callbacks so
  `ipc.emit()` reaches the page.
- `stop()` is ordered and idempotent: `shell.stop()` → wait for `EVENT_CLOSED` (5 s ceiling) →
  `server.stop()`.
- Starts exactly one window-event pump: `app.events`. It is also what waits for close, so it is
  the single consumer. Pass `{ events: app.events }` when you need `attachPlacementStore`.
- Reports page-side errors back to the host. Uncaught exceptions and unhandled rejections are
  captured by an injected listener and posted over HTTP — not over the WebSocket, which does not
  exist yet when a page script fails during evaluation. Pass `onPageError` to receive them; without
  a callback they go to the host's stderr rather than being discarded.
- Checks `html` against `page` before starting. Supplying one without the other is a configuration
  error whose only symptom is a window that renders and responds to nothing, so it throws. A
  reference without `type="module"` produces a warning instead: the legal ways to write a
  `<script>` tag are too varied for a string match to justify blocking startup.
- Serves extra static files with `assets`. A compiling framework usually emits more than one
  artifact — typically a script plus a stylesheet — and `assets` is a path-to-text map with the
  `content-type` inferred from the extension. Before this, every consumer hand-wrote a `routes`
  callback for the stylesheet, and the usual mistake (a wrong MIME type) makes the browser drop the
  stylesheet silently. Unrecognised extensions fall back to `application/octet-stream` rather than
  guessing. A caller's `routes` still wins, and unregistered paths are 404.
- Startup failures leave nothing half-started: if `openShell` throws, the bound port is released.

Notes:

- **Does not default to `FLAG_FRAMELESS`.** A frameless window has no system title bar, so it cannot
  be dragged until the page mounts `mountTitleBar`. The default is the side that works even when the
  page does nothing.
- **`wait()` only waits.** It resolves on `EVENT_CLOSED` but does not stop the event pump or the
  server — and the pump timer is ref'd (`keepAlive: true`), so a process that stops at `wait()`
  keeps running after the window is gone. Always follow it with `stop()`: it is idempotent and
  returns immediately once the close has already been observed.
- **Static assets are inline strings only.** `with { type: "text" }` yields a compile-time constant:
  nothing touches the filesystem, no temp files, and it survives `bun build --compile`. TS 7.0.2
  resolves that import to `HTMLBundle` rather than `string` — `bun-types` gates the correct
  declaration behind `typesVersions >= 7.1` — which is what the `as unknown as string` in the
  example is for. Do not "fix" it with `Bun.file().text()`: that reads at run time, and the HTML
  would no longer travel inside the compiled executable. For anything read from disk, write a
  `routes` function — five lines, and the path-resolution problem stays yours instead of leaking
  into the skeleton.
- **Not re-exported from the main entry.** It is a subpath like `./state` and `./ipc`. It imports
  `openShell` from `./index`; exporting it from `index.ts` would make that a cycle.

This is **not** a replacement for `Bun.WebView`. That one is a _headless_ browser for automation,
testing and scraping — it has no window, and it can only screenshot its own page. This package
draws a real desktop window with a system title bar, DPI awareness, snap layouts and taskbar
identity. The two do not compete.

### `bun-app-window/ipc` — Typed RPC & Event Bus

Share a single TypeScript contract between the host and the web page for compile-time verification of method signatures and event payloads:

```ts
// api.ts — Imported by both host and page
export type Api = { greet(name: string): string };
export type Events = { windowState: { maximized: boolean } };
```

```ts
// Host
import { createIpcServer } from "bun-app-window/ipc";

const ipc = createIpcServer({
    service: { greet: (name: string) => `Hello ${name}` },
});

serveOnSafePort({
    fetch(req) {
        /* Serve assets & authenticate */
    },
    websocket: {
        open: (ws) => ipc.attach(ws),
        message: (ws, raw) => ipc.handle(ws, raw),
        close: (ws) => ipc.detach(ws),
    },
});

ipc.emit("windowState", { maximized: false }); // Push event to connected pages
```

#### Delivering state to late connections

A page loads _after_ the window is created. Anything the host emits between `createApp` returning
and the page's WebSocket opening is delivered to zero connections and is not replayed — so a page
that reads its initial state from events alone stays empty, with no error on either side.

Mark state-shaped events as sticky and the server replays the last payload to each new connection:

```ts
ipc.emit("windowState", { maximized: false }, { sticky: true }); // Replayed on attach()
```

Sticky is **opt-in** and keeps one payload per event name, not a history. Events that are
notifications rather than state should stay non-sticky: a late connection would otherwise receive
one stale message that reads like a fresh one.

```ts
// Page
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada"); // Inferred return type: string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

By default, `connect()` extracts the auth token from the page URL's `?t=` query parameter and connects to `/ws`. Pass a custom `url` or `channel` option to override this behavior.

#### `timeoutMs` — long-running human interaction must opt out

Calls time out after **30 seconds** by default. That is right for ordinary methods and wrong for anything a human sits in front of:

```ts
// Host: pickFolder wraps SHBrowseForFolder — synchronous, and however long the user takes
const service = { pickFolder: () => shell.pickFolder() };

// Page: you must disable the timeout, or the client rejects while the host is still working
const api = await connect<Api, Events>({ timeoutMs: 0 });
```

`0` means **no timeout** (not "a zero-millisecond timeout"). Two ways this bites, neither caught by any gate:

- The page forgets `.catch` → the rejection is completely silent; the UI just does nothing after the user picks.
- Cancelling returns quickly, so only a **slow** pick reproduces it — easy to write off as flaky.

One more layer worth knowing: `shell.pickFolder()` **blocks the Bun main thread**. While the dialog is open, timers in that process do not fire and other IPC calls queue up (they are not rejected — they simply get no answer). The client's 30-second timer lives in the browser renderer process and is unaffected, so lowering the timeout does not fix the blocking, only surfaces it sooner. Real concurrency means running `pickFolder` in a Worker.

#### Reserved client names

The client is a `Proxy`: a handful of names resolve to the client itself and never reach a remote
method. If your service exposes a method under one of these names, **the server-side method becomes
unreachable** — the page calls the client's own member instead, and neither end reports an error.

| Name         | What the page actually gets                                              |
| ------------ | ------------------------------------------------------------------------ |
| `on` / `off` | Event subscription helpers                                               |
| `close()`    | Closes the WebSocket channel — every later call is rejected              |
| `connected`  | `boolean`: whether the channel is open                                   |
| `pending`    | `number` of calls still awaiting a reply                                 |
| `then`       | `undefined`, so `await client` cannot hang on a never-resolving thenable |

Symbol keys are reserved as well. Pick a different service name (`winClose` instead of `close`) and
map it back on the page side — see the title bar section below.

Because the failure above is invisible at runtime, `createIpcServer` **throws at creation time** when
the service table contains any of these names. The error names the offending keys and suggests a
replacement. Pass `{ rejectReservedNames: false }` only when the table is generated from external
input and validated by other means.

### `bun-app-window/titlebar` — Windows 11 Title Bar

Mounts a customizable Windows 11 title bar inside frameless windows. The IPC service is **flat** —
there is no `window` namespace — and one of the four natural names is taken by the client itself,
so the host exposes `winClose` and the page maps it back:

```ts
// Host — flat service; `close` is reserved by the IPC client
createIpcServer({
    service: {
        minimize: () => shell.minimize(),
        toggleMaximize: () => shell.toggleMaximize(),
        winClose: () => shell.close(),
        drag: () => shell.drag(),
    },
});
```

```ts
// Page — build the bridge explicitly
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
    title: "My App",
    icon: "/icon.svg",
    bridge: bridgeFromWindowService({
        minimize: () => api.minimize(),
        toggleMaximize: () => api.toggleMaximize(),
        close: () => api.winClose(), // mapped back to the bridge's own name
        drag: () => api.drag(),
    }),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

Implementation notes:

- Native dragging: Calling `shell.drag()` dispatches a native `WM_NCLBUTTONDOWN` (`HTCAPTION`) message, preserving Windows 11 Snap Layouts and double-click maximize behavior.
- Theming: Colors and dimensions are controlled via CSS custom properties (`--ws-tb-*`). `titleBarCss()` is exported if you need to inject the stylesheet yourself instead of letting `mountTitleBar` do it once.
- Glyphs: the default is `detectIconSet()`, which asks `document.fonts` for `Segoe Fluent Icons` (Win 11) or `Segoe MDL2 Assets` (Win 10) and picks `fluent` when either is present — the same code points exist in both fonts, so one table covers both systems. It only falls back to the `unicode` geometric set (`─ □ ❐ ✕`) when neither font is found. Pass `icons: "unicode" | "fluent"` to override the probe.
- Let the shell draw the buttons: pass `captions: "native"` and the component renders **no** buttons at all, reserving `46 × 3` on the right for the shell's own layered child window. Pair it with `FLAG_NATIVE_CAPTIONS` — enabling only one of the two gives you either two overlapping button sets or an empty strip that cannot be clicked. Note that clicks on those buttons arrive as non-client messages, so `bridge.minimize` / `toggleMaximize` / `close` are not called on the mouse path; the shell performs the action itself. Keyboard Tab + Enter still goes through the bridge.

### `bun-app-window/state` — Window Placement Persistence

Automatically persists and restores window coordinates, dimensions, and maximized state across sessions:

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE); // Subscribes to window events; writes once the drag settles
process.on("beforeExit", () => store.flush());
```

The native placement layer handles edge cases automatically:

- Captures the normal restore rectangle (`rcNormalPosition`) when maximized rather than full-screen bounds.
- Translates coordinates across monitors with different DPI scaling factors.
- Validates and clamps off-screen coordinates when monitor topology changes.

Writes are event-driven: a state change takes a snapshot **immediately** (a microsecond-scale
read), and the disk write is batched 300 ms after the window settles. A window at rest costs
neither a native call nor a disk write. Tune the write delay with `debounceMs`; tune the
internal event pump's cadence with `pumpMs`.

If you already have an event pump (for example from `createApp`), pass it in so two consumers
do not race for the same events:

```ts
import { createApp } from "bun-app-window/app";
import { attachPlacementStore } from "bun-app-window/state";

const app = await createApp({ html });
const store = attachPlacementStore(app.shell, FILE, { events: app.events });
```

For one-off reads and writes without any subscription, use `capturePlacement` and
`savePlacement` directly.

### Window events

The host does not have to poll to learn that the window changed — `pollEvents()` returns the
event stream directly:

```ts
import { EVENT_CLOSED, EVENT_STATE } from "bun-app-window/events";

for (const e of shell.pollEvents()) {
    if (e.type === EVENT_CLOSED) break; // window is gone, the native singleton is released
    if (e.type === EVENT_STATE && e.maximized) {
        /* ... */
    }
}
```

`pollEvents()` is **consuming**: drained records never come back, so a process should have
exactly one consumer. For a fixed cadence plus multi-subscriber fan-out, use
`attachEventPump()` from `./events`:

```ts
import { EVENT_CLOSED, attachEventPump } from "bun-app-window/events";

const pump = attachEventPump(shell, { intervalMs: 16 });
pump.on((e) => {
    if (e.type === EVENT_CLOSED) pump.stop();
});
pump.onGap((missing) => console.warn(`missed ${missing} events`));
```

- A `STATE` payload is a **snapshot**: `width` / `height` / `dpi` plus four flags
  (`maximized` / `minimized` / `focused` / `dark`).
- `CLOSED` is terminal. It is emitted by the native layer after teardown has fully completed
  and the window handle is gone, so "seeing `CLOSED`" is equivalent to "safe to restart the
  window" — that is what makes it stronger than `isAlive()`.
- The native ring buffer holds 128 records and drops the oldest when full. Losses are reported
  faithfully as gaps in `seq` (via `onGap`), never disguised as "nothing happened".
- The pump timer is `unref`'d by default (it will not keep the process alive). Pass
  `keepAlive: true` when you rely on it to wait for window close.

### `bun-app-window/debug` — Diagnostics

Exposes internal metrics and hit-testing utilities. Note: This module is excluded from semver stability guarantees and may change at any time.

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics(); // → "pos=196,196 win=1960x1400 client=1960x1400 work=3072x1824 border=13x13 round=1"
d.dpi(); // → "awareness=-1 dpi=192 scale=200%"
d.hittest(x, y);
```

`metrics()` and `dpi()` return **formatted text**, not objects. Parse it in throwaway tooling if you
must; do not put a parser in production code, because the layout is not part of any contract.

### `bun-app-window/types` — Constants, Safe for the Browser

A zero-dependency module holding the whole constant surface: `FLAG_*` (all ten, including
`FLAG_TITLEBAR_RESERVE` and `FLAG_NATIVE_CAPTIONS`), `BROWSER_UI_*`, `RESIZE_EDGE`, `RESIZE_INDEX`,
`resizeIndex`, `ZOOM_LADDER`, `ZOOM_MIN`, `ZOOM_MAX`, `STATE_MAXIMIZED` / `STATE_MINIMIZED` /
`STATE_FOCUSED`, and the caption geometry trio `CAPTION_BAR_HEIGHT` (32) / `CAPTION_BUTTON_WIDTH` (46)
/ `CAPTION_BUTTONS` — the last of which is ordered `close`, `maximize`, `minimize` from right to left,
and that order is load-bearing: if a page draws its buttons in a different order than
`caption_button_at()` reports them, clicking "close" maximizes the window.

**Use this subpath on the page side.** The main entry imports `bun:ffi` through `./native`, which a
browser bundle cannot resolve — so `import { BROWSER_UI_ALL } from "bun-app-window"` inside page code
fails at bundle time. This subpath exists precisely so the same constants can be shared instead of
hand-copied:

```ts
import { BROWSER_UI_ALL, ZOOM_LADDER, RESIZE_EDGE, resizeIndex } from "bun-app-window/types";
```

Its only invariant is that `src/shell/types.ts` must stay import-free; a static assertion enforces it.

### `bun-app-window/pack` — Bundling the Page Script

Pages have to be bundled before the browser can load them: they import bare module names like
`bun-app-window/ipc`, which a browser cannot resolve. Do it at **build time**, not at startup —
after `bun build --compile`, `import.meta.dir` points inside the archive (`B:\~BUN\root`) and the
`.ts` source is no longer there.

```ts
import { bundlePage, writePageBundle } from "bun-app-window/pack";

// In memory — hand the string to createApp({ page })
const { code, bytes } = await bundlePage({ entry: "src/ui/page.ts" });

// Or write it out, e.g. from a `bundle:page` npm script
await writePageBundle({ entry: "src/ui/page.ts", out: "src/ui/page.bundle.txt" });
```

`target: "browser"` and `format: "esm"` are fixed, not configurable — that is what a page script is.
`bytes` is a UTF-8 byte count, not `string.length`; the two differ on any source containing non-ASCII
text, and a reported size that only looks right is worse than no reported size.

#### Compiling frameworks: `plugins`, `define`, `loader`

These three are passed straight through to `Bun.build`; nothing about them is specific to any
framework, and this package ships no plugins of its own.

```ts
const built = await bundlePage({
    entry: "src/main.ts",
    plugins: [myFrameworkPlugin()], // .vue / .svelte / .tsx — whatever your plugin handles
    define: { __VUE_OPTIONS_API__: "false" }, // compile-time constants
    loader: { ".thing": "ts" }, // custom extensions
});
```

#### `alias` is implemented here, because Bun has no such option

`BuildConfig` in Bun 1.4.4 has no `alias` property, and passing one is not an error — it is silently
ignored. Four forms were tried and all failed to resolve. So this package backs `alias` with its own
`onResolve` plugin:

```ts
await bundlePage({ entry, alias: { "@": "./src", lib: "./src/lib" } });
```

| Specifier                             | Rewritten? |
| ------------------------------------- | ---------- |
| equal to a key, or prefixed by `key/` | yes        |
| starts with `.` or `/`                | no         |
| has a `scheme:` prefix                | no         |

**The default is empty.** `$lib` is a SvelteKit convention and `@/` is some project's `tsconfig`
alias; neither belongs here. Aliases merge with your plugins rather than replacing them, and the
plugin is only registered when you pass `alias`.

#### Multiple outputs

A compiling framework often produces more than one artifact — a script plus a stylesheet is the
common shape. `outputs` lists all of them with `path` / `kind` / `code` / `bytes`, and `code` /
`bytes` refer to the `entry-point` artifact specifically (not `outputs[0]`, because output order is
not a contract).

`writePageBundle` writes every artifact: the entry to `out`, the rest to the same directory with the
extension substituted. `page.bundle.txt` therefore yields `page.bundle.css`, **not** `main.css` — the
entry's filename must not leak into a path that HTML and `assets` reference. It returns
`written: Array<{ path, bytes }>` so cleanup removes every file it created.

```text
$ bun run bundle:page
109,888 B  dist/page.bundle.txt     ← entry-point
    133 B  dist/page.bundle.css     ← asset
```

Serve the extra files with `createApp({ assets })` — see the `app` section above.

Failure throws with Bun's full diagnostics. Both shapes are handled: compile-time problems come back
as `{ success: false, logs }`, while an unreachable entry point **throws an `AggregateError`** whose
`message` is only `Bundle failed` and whose detail lives on `.errors`.

### `bun-app-window/native` — The Prebuilt DLL

Resolves to `dist/libshell.dll` itself, so `import.meta.resolve()` hands you a real path you can copy next to your executable:

```ts
import nativeLibPath from "bun-app-window/native" with { type: "file" };

await Bun.write(join(dirname(process.execPath), "libshell.dll"), Bun.file(nativeLibPath));
```

The `with { type: "file" }` attribute is required — without it the bundler tries to parse the DLL as a module. This subpath is for hand-rolled packaging; if you use `bun build --compile`, `bun-app-window/embedded` does the same job without touching the filesystem.

## Common Recipes & Best Practices

### 1. Disabling Browser-Specific UI

WebView2 enables standard browser interactions by default. Desktop applications typically disable all of them:

```ts
import { BROWSER_UI_ALL } from "bun-app-window";

const shell = await openShell({ url, browserUi: BROWSER_UI_ALL });
```

Individual flags can also be combined via bitwise OR:

| Flag                   | Disabled Behavior                                         |
| ---------------------- | --------------------------------------------------------- |
| `BROWSER_UI_MENU`      | Default Edge right-click context menu                     |
| `BROWSER_UI_KEYS`      | Built-in browser shortcuts (`Ctrl+P`, `Ctrl+F`, `Ctrl+S`) |
| `BROWSER_UI_STATUSBAR` | Bottom-left URL hover status bar                          |
| `BROWSER_UI_SWIPE`     | Trackpad horizontal swipe back/forward navigation         |
| `BROWSER_UI_AUTOFILL`  | Form autofill popups                                      |

Note: `F11`, `F12`, and `Ctrl±` zoom shortcuts are handled directly by the native shell and remain active regardless of these flags.

### 2. Native Context Menu

After disabling the default browser menu, render native Win32 popup menus (`TrackPopupMenu`) via `showContextMenu`. The page cannot call it directly — expose it through the IPC service first:

```ts
// Host: expose the menu capability on the flat service
createIpcServer({
    service: {
        showContextMenu: (x: number, y: number, items: string) => shell.showContextMenu(x, y, items),
    },
});
```

```ts
// Page: trigger the native menu
document.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    await api.showContextMenu(Math.round(e.screenX), Math.round(e.screenY), "open|Open\nrefresh|Refresh\n-\nquit|Quit");
});

// Page: handle menu item selection
window.addEventListener("shell-msg", (e) => {
    if (e.detail.t === "menu") console.log("Selected ID:", e.detail.id);
});
```

Menu items are specified as a newline-delimited string: `id|Label` per line, or `-` for a separator line.

### 3. File Drag and Drop

Pass `FLAG_ACCEPT_DROP` to receive file and folder drops from Windows Explorer:

```ts
// Host
import { openShell, FLAG_ACCEPT_DROP } from "bun-app-window";

const shell = await openShell({ url, flags: FLAG_ACCEPT_DROP });
```

```js
// Page
window.addEventListener("shell-msg", (e) => {
    if (e.detail.t === "drop") console.log("Dropped paths:", e.detail.paths);
});
```

Files **and folders** are forwarded by a script the shell injects, so the page does **not** need its own `drop` handler. Every entry is an **absolute path** (from `ICoreWebView2File::get_Path`), and `dirs` tells you which of them are directories:

```js
window.addEventListener("shell-msg", (e) => {
    if (e.detail.t !== "drop") return;
    for (const p of e.detail.paths) {
        console.log(e.detail.dirs.includes(p) ? "folder" : "file", p);
    }
});
```

When running in an elevated administrator process (High Integrity Level) while Explorer runs at Medium Integrity Level, the shell automatically whitelists drop messages across UIPI via `ChangeWindowMessageFilterEx`.

### 4. Recommended Desktop CSS Reset

The shell does not inject any implicit DOM nodes or stylesheets into your page. To make your web UI feel like a native desktop app, include the following baseline rules:

```css
html,
body {
    cursor: default;
}
body {
    user-select: none;
}
input,
textarea,
.log {
    user-select: text;
    cursor: auto;
}
button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" />
```

Setting `spellcheck="false"` is particularly important—red squiggly underlines beneath file paths and numeric inputs immediately give away a web view.

### 5. Compiling to a Standalone Executable (.exe)

When bundling with `bun build --compile`, import `bun-app-window/embedded` to embed `libshell.dll` directly inside the single-file executable:

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded"; // Embeds the DLL into the binary

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

Tips:

- A side-effect import `import "bun-app-window/embedded";` also works automatically.
- Always pass `--windows-hide-console` for GUI builds; omitting it will spawn a black command prompt window alongside your application.

### 6. Two Traps That Type-Check

Neither of these fails `bun check`; both produce a window that renders and then does nothing.

- **The page bundle is an ES module, so the `<script>` tag needs `type="module"`.** A build with a
  top-level `await` is a syntax error inside a classic `<script>`, and the **whole script never
  runs** — while the page still renders, because the markup is static. Nothing on screen points at
  the cause.
- **Namespace your own `data-*` selectors.** The title bar renders buttons with
  `data-act="minimize|maximize|close"` and listens for clicks on `document`. A host that also binds
  `button[data-act]` receives the same click twice and logs its own "unknown action: maximize".
  Prefix your attributes (`data-mvp-act`): a generic name is a shared namespace, not yours.

## Internals & Reference

### Native Library Resolution Order

At runtime, `libshell.dll` is located in the following order:

1. Explicit path: `opts.nativeLibPath`, bypassing all fallback heuristics.
2. Embedded payload: Extracted to `%LOCALAPPDATA%\<appName>\runtime` named by content hash (stale versions are automatically pruned).
3. Executable directory: `libshell.dll` located next to the running `.exe`.
4. Development paths: `.build/libshell.dll` followed by `dist/libshell.dll` relative to the package root.

### Built-in Keyboard & Mouse Shortcuts

| Input                                 | Behavior                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `Ctrl +` / `Ctrl -` / `Ctrl 0`        | Zoom in / Zoom out / Reset zoom to 100%                              |
| `Ctrl + Mouse Wheel`                  | Zoom in / Zoom out                                                   |
| `F11`                                 | Toggle fullscreen mode (hides window borders and covers the taskbar) |
| `F5` / `Ctrl + R`                     | Reload page                                                          |
| `F12`                                 | Open WebView2 Developer Tools                                        |
| `Alt + Space` / Right-click title bar | Open native Windows system menu                                      |

## Development & Verification

Built with Bun 1.4.4 and TypeScript 7.0.2 with full strict type-checking enabled.

**This project has no remote CI.** GitHub Actions cannot allocate runners for this account (billing lock), and the project is a single-platform, single-developer package with no external service dependencies — so the gates run locally instead. The recommended entry point is:

```powershell
bun run scripts/gate.ts              # bun check + bun test + consumer acceptance
bun run scripts/gate.ts --clean      # same gates, but inside a fresh clone of HEAD
```

`-Clean` reproduces the conditions a hosted runner would provide: it clones `HEAD` into `%TEMP%`, installs from the lockfile, and runs the gates there, so local artefacts (`.build/`, `node_modules/`, `vendor/webview2/`) cannot mask a missing file. Uncommitted changes are reported and excluded — run without `-Clean` to verify the working tree as-is.

The gate has three stages: `bun check`, `bun test`, and consumer acceptance (`scripts/verify-pack.ts`). The third packs the tarball, installs it into a scratch project under `%TEMP%`, type-checks that project, and runs `scripts/consumer-probe.ts` against the installed package — assertions covering every subpath, the DLL actually being `dlopen`-ed out of `node_modules`, and `libInfo.source === "package"` (the probe reports its own count). It runs offline and denies by default: a file packed without being listed in the allow-list fails the gate. Pass `-SkipPack` only when the gate itself is what you are changing.

The underlying commands remain available directly:

```bash
bun check          # Run TypeScript type checker
bun test           # Run automated test suite (tests/)
bun run demo       # Launch interactive self-test demo (requires desktop session)
```

Note that `bun run demo` and the single-file `.exe` acceptance both need an interactive desktop, so they were never CI-capable — they are local-only by construction. For the `.exe`, the whole check is: compile it, copy the result into an empty directory, launch it, and confirm the window comes up with `libInfo.source === "embedded"`.

Whenever `src/shell/` or `package.json` is modified, the consumer acceptance stage already covers the installed-package path; it runs as part of the gate, so there is nothing to remember. Only the `.exe` build still needs a manual run inside a desktop session.

For window enumeration (`EnumWindows`) or automated screenshot scripts, filter by the corresponding Win32 window class name:

| Window Mode                                | Window Class Name |
| ------------------------------------------ | ----------------- |
| Standard framed (without `FLAG_FRAMELESS`) | `webview`         |
| Frameless (with `FLAG_FRAMELESS`)          | `webview_shell`   |

## Acknowledgments

- Platform windowing layer based on [webview/webview](https://github.com/webview/webview) `0.12.0` (MIT License, Serge Zaitsev & Steffen André Langnes). `vendor/webview/` contains an unmodified upstream copy.
- WebView2 SDK provided by [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.4258.31` (NuGet package vendored for offline builds). The WebView2 Runtime is provided by the OS.
- Co-authored-by DeepSeek

## License

Released under the [MIT License](./LICENSE). `vendor/webview/` is also MIT-licensed with original copyright notices retained in source files.
