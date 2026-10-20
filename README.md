# bun-app-window

[![npm version](https://img.shields.io/npm/v/bun-app-window?color=cb3837&logo=npm)](https://www.npmjs.com/package/bun-app-window)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.4.3-f472b6?logo=bun&logoColor=white)](https://bun.sh)
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

| Constraint | Implication |
| --- | --- |
| Windows x64 only | Enforced via `os` and `cpu` fields in `package.json` (the platform-neutral package name is reserved for future expansion). A prebuilt `libshell.dll` is shipped in the package; no install-time compilation is required |
| Bun runtime required | Ships raw TypeScript source files and requires Bun >= 1.4.3. While Node.js can install the package, it cannot execute it |
| Type-checking needs `@types/bun` | Because the package ships `.ts` sources, your own `bun check` compiles them too. Add `bun add -d @types/bun`; without it the checker reports `TS2868: Cannot find name 'Bun'` from inside `node_modules` |
| Built on `bun:ffi` | `bun:ffi` is marked as experimental in Bun. While Bun recommends Node-API for production stability, this library chooses `bun:ffi` to achieve a zero-dependency footprint |

Runtime prerequisites and non-goals:

- System WebView2 Runtime: Requires the evergreen WebView2 Runtime installed on the host machine (pre-installed on Windows 11).
- Interactive desktop session: Due to Windows Session 0 isolation, WebView2 cannot run inside non-interactive background services. However, running inside elevated (High Integrity Level) administrator processes is fully supported.
- Explicit non-goals: System tray icons, native application menu bars, auto-updaters, multi-window orchestration, and cross-platform abstractions.

## Installation

```bash
bun add bun-app-window
```

### What the tarball contains

The published package holds the prebuilt `dist/libshell.dll` plus the TypeScript sources — 19 files, ~0.36 MB packed. The native C++ layer (`native/`) and the vendored upstream headers (`vendor/`) are **not** shipped: they are only needed to rebuild `libshell.dll`, and rebuilding requires cloning the repository. `bun run build:native` and `build:exe` are therefore repository-only scripts that do nothing useful inside `node_modules`.

## Quick Start

```ts
import { openShell, serveOnSafePort, FLAG_FRAMELESS, FLAG_CENTER } from "bun-app-window";

const server = serveOnSafePort({
  fetch: () => new Response("<h1>Hello</h1>", {
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

shell.post(JSON.stringify({ t: "ready" }));   // Host -> Page one-way message
shell.setTitle("Doing work…");
```

Note: `createShell(opts)` only resolves and loads the native DLL without opening a window. `openShell(opts)` creates the instance, starts the window immediately, and throws an error on failure.

## Core API

### Instance Methods & Properties

| Member | Description |
| --- | --- |
| `start()` | Opens the window and returns `{ rc, error }`. Returns immediately while the UI message loop runs on a dedicated native thread |
| `stop()` | Destroys the window and releases native resources. Safe to call multiple times (idempotent) |
| `show()` | Reveals the window. Typically paired with `FLAG_DEFER_SHOW` to display the window only after the web UI is ready |
| `isAlive()` | Checks whether the native window still exists (unlike `state()`, which cannot distinguish between unstarted and destroyed states) |
| `state()` | Returns current window state: `{ maximized, minimized, focused, dark, raw }` |
| `lastError()` | Returns the most recent failure message, or an empty string if no error occurred |
| `setTitle` / `minimize` / `toggleMaximize` / `close` | Standard window control operations; each returns a status code `rc` |
| `setMinSize(w, h)` | Sets the minimum window dimensions in logical pixels |
| `drag()` | Initiates native window dragging from a page `pointerdown` event (preserves Windows Snap Layouts) |
| `beginResize(edge)` | Initiates native border resizing from a page `pointermove` event (`edge` uses `RESIZE_EDGE.*` constants) |
| `post(json)` | Sends a fire-and-forget JSON message from the host to the web page |
| `setZoom(f)` / `getZoom()` | Gets or sets the page zoom factor (clamped automatically to `0.25`–`3.0`) |
| `reload()` / `openDevTools()` / `toggleFullscreen()` | Equivalent to `Ctrl+R`, `F12`, and `F11` respectively |
| `setBrowserUi(mask)` | Disables specific default browser behaviors using a bitwise OR of `BROWSER_UI_*` flags |
| `showContextMenu(x, y, items)` | Displays a native Win32 context menu at the specified screen coordinates (see below) |
| `pickFolder(title?)` | Opens a native folder selection dialog (synchronously blocks the calling thread) |
| `libInfo` | Metadata of the resolved native library (file path, resolution source, SHA-256 hash) |
| `symbols` | Escape hatch providing direct access to the raw `dlopen` FFI symbols |

### Window Flags

Combine via bitwise OR (`|`) and pass to `opts.flags`:

| Flag | Description |
| --- | --- |
| `FLAG_FRAMELESS` | Creates a frameless window without the default system title bar, delegating title bar rendering to the web UI |
| `FLAG_RESIZABLE` | Allows user resizing |
| `FLAG_CENTER` | Centers the window within the active monitor work area on startup (works in both standard and frameless modes) |
| `FLAG_TOPMOST` | Keeps the window always on top |
| `FLAG_DEFER_SHOW` | Creates the window hidden initially until `show()` is explicitly called |
| `FLAG_ACCEPT_DROP` | Enables native file and folder drag-and-drop from Windows Explorer |
| `FLAG_START_MAXIMIZED` | Opens the window directly in a maximized state without an intermediate normal-sized frame flash |

## Subpath Exports

Additional capabilities outside core window management are modularized into dedicated subpath exports.

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
  fetch(req) { /* Serve assets & authenticate */ },
  websocket: {
    open: (ws) => ipc.attach(ws),
    message: (ws, raw) => ipc.handle(ws, raw),
    close: (ws) => ipc.detach(ws),
  },
});

ipc.emit("windowState", { maximized: false });   // Push event to connected pages
```

```ts
// Page
import { connect } from "bun-app-window/ipc";
import type { Api, Events } from "./api";

const api = await connect<Api, Events>();
await api.greet("Ada");                        // Inferred return type: string
api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

By default, `connect()` extracts the auth token from the page URL's `?t=` query parameter and connects to `/ws`. Pass a custom `url` or `channel` option to override this behavior.

### `bun-app-window/titlebar` — Windows 11 Title Bar

Mounts a customizable Windows 11 title bar inside frameless windows:

```ts
// Page
import { mountTitleBar, bridgeFromWindowService } from "bun-app-window/titlebar";

const bar = mountTitleBar({
  title: "My App",
  icon: "/icon.svg",
  bridge: bridgeFromWindowService(api.window),
});

api.on("windowState", (s) => bar.setMaximized(s.maximized));
```

Expose the four corresponding window control methods on the host IPC service:

```ts
// Host
createIpcServer({
  service: {
    window: {
      minimize: () => shell.minimize(),
      toggleMaximize: () => shell.toggleMaximize(),
      close: () => shell.close(),
      drag: () => shell.drag(),
    },
  },
});
```

Implementation notes:

- Native dragging: Calling `shell.drag()` dispatches a native `WM_NCLBUTTONDOWN` (`HTCAPTION`) message, preserving Windows 11 Snap Layouts and double-click maximize behavior.
- Theming & icons: Colors and dimensions are controlled via CSS custom properties (`--ws-tb-*`). Window control buttons default to geometric glyphs for universal compatibility; setting `icons: "fluent"` switches to `Segoe Fluent Icons` (note: missing fonts on older systems will render as missing-glyph boxes).

### `bun-app-window/state` — Window Placement Persistence

Automatically persists and restores window coordinates, dimensions, and maximized state across sessions:

```ts
import { attachPlacementStore, loadPlacement, restorePlacement } from "bun-app-window/state";

const FILE = "C:\\Users\\me\\AppData\\Roaming\\MyApp\\window.json";
const shell = await openShell({ url, flags: FLAG_DEFER_SHOW });

const saved = await loadPlacement(FILE);
if (saved) restorePlacement(shell, saved);

shell.show();

const store = attachPlacementStore(shell, FILE);   // Polls state; skips disk writes when idle
process.on("beforeExit", () => store.flush());
```

The native placement layer handles edge cases automatically:

- Captures the normal restore rectangle (`rcNormalPosition`) when maximized rather than full-screen bounds.
- Translates coordinates across monitors with different DPI scaling factors.
- Validates and clamps off-screen coordinates when monitor topology changes.

For one-off reads and writes without polling timers, use `capturePlacement` and `savePlacement` directly.

### `bun-app-window/debug` — Diagnostics

Exposes internal metrics and hit-testing utilities. Note: This module is excluded from semver stability guarantees and may change at any time.

```ts
import { debugOf } from "bun-app-window/debug";

const d = debugOf(shell);
d.metrics();   // Returns pos / win / client / work / border / round geometry
d.dpi();       // Returns DPI awareness level and scaling factor
d.hittest(x, y);
```

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

| Flag | Disabled Behavior |
| --- | --- |
| `BROWSER_UI_MENU` | Default Edge right-click context menu |
| `BROWSER_UI_KEYS` | Built-in browser shortcuts (`Ctrl+P`, `Ctrl+F`, `Ctrl+S`) |
| `BROWSER_UI_STATUSBAR` | Bottom-left URL hover status bar |
| `BROWSER_UI_SWIPE` | Trackpad horizontal swipe back/forward navigation |
| `BROWSER_UI_AUTOFILL` | Form autofill popups |

Note: `F11`, `F12`, and `Ctrl±` zoom shortcuts are handled directly by the native shell and remain active regardless of these flags.

### 2. Native Context Menu

After disabling the default browser menu, render native Win32 popup menus (`TrackPopupMenu`) via `showContextMenu`. The page cannot call it directly — expose it through the IPC service first:

```ts
// Host: expose the menu capability on the window service
createIpcServer({
  service: {
    window: {
      showContextMenu: (x: number, y: number, items: string) =>
        shell.showContextMenu(x, y, items),
    },
  },
});
```

```ts
// Page: trigger the native menu
document.addEventListener("contextmenu", async (e) => {
  e.preventDefault();
  await api.window.showContextMenu(
    Math.round(e.screenX),
    Math.round(e.screenY),
    "open|Open\nrefresh|Refresh\n-\nquit|Quit"
  );
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

When running in an elevated administrator process (High Integrity Level) while Explorer runs at Medium Integrity Level, the shell automatically whitelists drop messages across UIPI via `ChangeWindowMessageFilterEx`.

### 4. Recommended Desktop CSS Reset

The shell does not inject any implicit DOM nodes or stylesheets into your page. To make your web UI feel like a native desktop app, include the following baseline rules:

```css
html, body { cursor: default; }
body { user-select: none; }
input, textarea, .log { user-select: text; cursor: auto; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

```html
<input type="text" spellcheck="false" autocomplete="off" autocapitalize="off">
```

Setting `spellcheck="false"` is particularly important—red squiggly underlines beneath file paths and numeric inputs immediately give away a web view.

### 5. Compiling to a Standalone Executable (.exe)

When bundling with `bun build --compile`, import `bun-app-window/embedded` to embed `libshell.dll` directly inside the single-file executable:

```ts
import { createShell } from "bun-app-window";
import { embeddedDll } from "bun-app-window/embedded";   // Embeds the DLL into the binary

const shell = await createShell({ url, embedded: embeddedDll });
```

```bash
bun build --compile --windows-hide-console src/index.ts --outfile dist/app.exe
```

Tips:

- A side-effect import `import "bun-app-window/embedded";` also works automatically.
- Always pass `--windows-hide-console` for GUI builds; omitting it will spawn a black command prompt window alongside your application.

## Internals & Reference

### Native Library Resolution Order

At runtime, `libshell.dll` is located in the following order:

1. Explicit path: `opts.nativeLibPath`, bypassing all fallback heuristics.
2. Embedded payload: Extracted to `%LOCALAPPDATA%\<appName>\runtime` named by content hash (stale versions are automatically pruned).
3. Executable directory: `libshell.dll` located next to the running `.exe`.
4. Development paths: `.build/libshell.dll` followed by `dist/libshell.dll` relative to the package root.

### Built-in Keyboard & Mouse Shortcuts

| Input | Behavior |
| --- | --- |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | Zoom in / Zoom out / Reset zoom to 100% |
| `Ctrl + Mouse Wheel` | Zoom in / Zoom out |
| `F11` | Toggle fullscreen mode (hides window borders and covers the taskbar) |
| `F5` / `Ctrl + R` | Reload page |
| `F12` | Open WebView2 Developer Tools |
| `Alt + Space` / Right-click title bar | Open native Windows system menu |

## Development & Verification

Built with Bun 1.4.3 and TypeScript 7.0.2 with full strict type-checking enabled.

**This project has no remote CI.** GitHub Actions cannot allocate runners for this account (billing lock), and the project is a single-platform, single-developer package with no external service dependencies — so the gates run locally instead. The recommended entry point is:

```powershell
pwsh -File scripts/gate.ps1          # bun check + bun test against the working tree
pwsh -File scripts/gate.ps1 -Clean   # same gates, but inside a fresh clone of HEAD
```

`-Clean` reproduces the conditions a hosted runner would provide: it clones `HEAD` into `%TEMP%`, installs from the lockfile, and runs the gates there, so local artefacts (`.build/`, `node_modules/`, `vendor/webview2/`) cannot mask a missing file. It takes about two seconds. Uncommitted changes are reported and excluded — run without `-Clean` to verify the working tree as-is.

The gate has three stages: `bun check`, `bun test`, and consumer acceptance (`scripts/verify-pack.ts`). The third packs the tarball, installs it into a scratch project under `%TEMP%`, type-checks that project, and runs `scripts/consumer-probe.ts` against the installed package — 40 assertions covering every subpath, the DLL actually being `dlopen`-ed out of `node_modules`, and `libInfo.source === "package"`. It runs offline in about 0.4 s and denies by default: a file packed without being listed in the allow-list fails the gate. Pass `-SkipPack` only when the gate itself is what you are changing.

The underlying commands remain available directly:

```bash
bun check          # Run TypeScript type checker
bun test           # Run automated test suite (tests/, 108 test cases)
bun run demo       # Launch interactive self-test demo (requires desktop session)
```

Note that `bun run demo` and the compiled-executable acceptance (shape B in `AGENTS.md`) both need an interactive desktop, so they were never CI-capable — they are local-only by construction.

Whenever `src/shell/` or `package.json` is modified, the consumer acceptance stage already covers the installed-package path (shape A in `AGENTS.md`); it runs as part of the gate, so there is nothing to remember. Only shape B — building the single-file `.exe` — still needs a manual run inside a desktop session.

For window enumeration (`EnumWindows`) or automated screenshot scripts, filter by the corresponding Win32 window class name:

| Window Mode | Window Class Name |
| --- | --- |
| Standard framed (without `FLAG_FRAMELESS`) | `webview` |
| Frameless (with `FLAG_FRAMELESS`) | `webview_shell` |

## Acknowledgments

- Platform windowing layer based on [webview/webview](https://github.com/webview/webview) `0.12.0` (MIT License, Serge Zaitsev & Steffen André Langnes). `vendor/webview/` contains an unmodified upstream copy.
- WebView2 SDK provided by [Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2) `1.0.1150.38` (NuGet package vendored for offline builds). The WebView2 Runtime is provided by the OS.
- Co-authored-by DeepSeek

## License

Released under the [MIT License](./LICENSE). `vendor/webview/` is also MIT-licensed with original copyright notices retained in source files.
