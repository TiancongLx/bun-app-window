# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-10-21

### Fixed

- **`bun-app-window/titlebar` no longer breaks `bun check` in your project.** Every consumer whose `tsconfig.json` includes `DOM` — that is, every project with a real page — was stopped by a `TS2352` error pointing at this package's own source, with no way to work around it:

    ```text
    node_modules/bun-app-window/src/ui/titlebar.ts(237,27): error TS2352:
    Conversion of type 'typeof globalThis' to type '{ document?: TitleBarDocument; }'
    may be a mistake because neither type sufficiently overlaps with the other.
    If this was intentional, convert the expression to 'unknown' first.
    ```

    `skipLibCheck: true` does not help, because this package ships `.ts` sources rather than `.d.ts` files, so the error is in compiled source and not in a declaration. The component reached `globalThis.document` through a single-layer type assertion; with `DOM` loaded, `globalThis.document` is a full `Document`, and the component's deliberately minimal `TitleBarDocument` does not overlap with it enough to satisfy the checker. It is now a two-layer assertion (`as unknown as`), which states the intent without making the component depend on DOM types. Runtime behaviour is unchanged. Existing code needs no edits — upgrading is enough.

### Changed

- **The three READMEs are corrected in six places.** Everything below was documentation, not code, but each item could cost a consumer real time by making them follow an example that does not work. The pages are `README.md`, `README.zh-CN.md` and `README.zh-TW.md`, and all six corrections are applied to all three.

    **The `titlebar` example contradicted itself.** One section showed the IPC service flat, another showed it nested under a `window` key — inside the same file. The nested form never worked: `service` is a flat method table. The example now uses the flat form, and because `close` is one of the client's reserved names, it exposes `winClose` and maps it back on the page side.

    **`debug.metrics()` and `debug.dpi()` were described as if they returned objects.** They return formatted text — `pos=196,196 win=1960x1400 client=1960x1400 work=3072x1824 border=13x13 round=1` and `awareness=-1 dpi=192 scale=200%`. The example shows the real output now, and says not to build a parser on it: the layout is not part of any contract.

    **`await app.wait()` was shown as the end of a program.** It resolves when the window closes but stops neither the event pump nor the server, and the pump's timer is pinned on purpose — so a program that ends on that line stays alive after the window is gone. The example follows it with `await app.stop()`, which is idempotent and returns immediately once the close has been observed.

    **The IPC client's reserved names were undocumented.** `on`, `off`, `close`, `connected`, `pending` and `then` resolve to the client itself and never reach a remote method. A service that defines one of them is silently unreachable, with no error on either end — and `close` in particular also tears down the channel for every later call. There is a table of them now, and a note that symbol keys are reserved as well.

    **Two traps that pass type checking but do not work** are documented together: the page bundle is an ES module, so a classic `<script>` tag executes nothing while the page still renders; and the title bar listens for `document` clicks on `data-act`, so a host binding `button[data-act]` receives every click twice.

    **The tarball figures were stale** — 19 files / ~0.36 MB against the measured 21 files / ~0.4 MB.

- **The `app` Quick Start no longer reads the HTML at run time.** The old snippet, `import html from "./index.html" with { type: "text" }`, did not compile under TypeScript 7.0.2, because `bun-types` gates the declaration that types this import behind `typesVersions: ">= 7.1"`. The obvious-looking repair, `await Bun.file(...).text()`, would have broken the property that section exists to demonstrate: a compile-time constant travels inside `bun build --compile`, a run-time read does not. The import stays and only the type is bridged, so a single-file executable still carries its HTML:

    ```ts
    import htmlText from "./index.html" with { type: "text" };
    const html = htmlText as unknown as string;
    ```

### Note

- **Nothing to do on upgrade.** No public API changed: the exported surface, the flags, the IPC protocol and `dist/libshell.dll` are byte-for-byte the same as 0.4.0, so `bun update bun-app-window` is the whole procedure. This is a patch because the only code change is the one assertion above, and the rest is documentation.

## [0.4.0] - 2026-10-21

### Added

- `bun-app-window/events` — window lifecycle events, and the end of polling. Until this release the host had exactly one way to learn that the window changed: ask again. `shell.isAlive()` every 50 ms to notice a close, and `attachPlacementStore` calling `getBounds()` every 700 ms. The module comment in `state.ts` gave the reason — "the native side pushes window state to the **page** (shell-msg); the host cannot see it, and adding a native→host callback channel means a whole lifecycle to manage".

    A callback is not available: `webview_run` blocks the native UI thread while `bun:ffi`'s `JSCallback` needs an idle JS thread, and the two together deadlock (ADR 0002). So the channel is a fixed ring plus a pull:

    ```text
    native: UI thread appends 32-byte records to a 128-slot ring,
            holding one SRWLOCK for at most a 4 KiB copy
    host:   shell_poll_events(buf, capacity) → shell.pollEvents() / attachEventPump()
    ```

    Four decisions, each with a failure mode behind it:

    **Capacity 128, drop the oldest.** A one-second drag at a 16 ms cadence is about 60 events, so 128 is a two-fold margin. Dropping the *newest* instead would freeze the ring at a stale state and the host would see "the window never changed" — far worse than losing history. Losses are reported as gaps in `seq` rather than synthesised into an overflow event: the gap carries the exact count, and no new `seq` special case is needed.

    **`CLOSED` is emitted after teardown completes.** That is the whole point: "saw `CLOSED`" must be equivalent to "the process-wide singleton is released, restart is safe". It follows that `shell_poll_events` must **not** return -1 when `g_webview` is null, unlike every other export — `CLOSED` is produced precisely after the handle is gone.

    **Both window procedures enqueue.** `shell_wnd_proc` is only registered for the `webview_shell` class, which only `FLAG_FRAMELESS` uses. A framed window is created by the webview library, and only the `toplevel_proc` subclass sees its `WM_SIZE`. Enqueueing next to `push_state()` alone would leave the **default** configuration permanently silent about size and maximize events, with every test green.

    **The event side keeps its own change-detection cache.** `push_state` compares against `g_pushed` to throttle cross-process `webview_eval`. Recording the same state into the ring is a memory write, and the consumers differ: sharing the cache would let the page push's "unchanged, skip" swallow the host's events too.

- `shell.pollEvents(max?)` on the main entry — the raw pull primitive. Synchronous, consuming, and documented as single-consumer: drained records never come back, so a process should have exactly one reader.

- `EventCursor` and `attachEventPump()` — the cursor turns `seq` into "how many did I miss", and the pump supplies a cadence with multi-subscriber fan-out (`on()` / `onGap()`), stopping itself once `CLOSED` arrives.

- `bun-app-window/app` — an application skeleton, and the answer to a specific number: **180**. That is how much host boilerplate a first app needed before this release, against roughly 30 lines of business code. Picking a browser-safe port, minting a per-run auth token, handling the WebSocket upgrade, serving HTML as a string, wiring `createIpcServer` into Bun's websocket callbacks, composing window flags, handling `openShell` failure, waiting for window close, and calling `stop()` on two things — each piece is easy, but they are only correct in one order. `createApp()` collapses it:

    ```ts
    const app = await createApp({ html, service: { greet: (n) => `hi ${n}` } });
    await app.wait();
    ```

    Three decisions worth recording:

    **It does not default to `FLAG_FRAMELESS`.** A frameless window has no system title bar, so it cannot be dragged until the page mounts `mountTitleBar`. A skeleton whose default value breaks the "hello world" case is worse than no skeleton, so the default is `FLAG_RESIZABLE | FLAG_CENTER` — the side that works even when the page does nothing.

    **It is not re-exported from the main entry.** `app.ts` imports `openShell` from `./index`; exporting it back from `index.ts` would make that a cycle. It is a subpath like `./state` and `./ipc`, and a static assertion in `tests/app.test.ts` keeps it that way.

    **Static assets are inline strings only.** `import html from "./index.html" with { type: "text" }` yields a compile-time constant: nothing touches the filesystem, no temp files, and it survives `bun build --compile`. Reading from a directory has to cope with `import.meta.dir` pointing at `B:\~BUN\root` after packing — the `PACKED` branch in `src/host.ts` exists precisely for that. Five lines in a `routes` callback is a better trade than leaking that problem into the skeleton.

- `decideWs()` — the `/ws` decision, extracted as a pure function because it is the only branch in the skeleton and it has three ways to be wrong. `/ws` with IPC disabled is a **404, not a 403**: a 403 advertises that a channel exists. The token check must happen **before** the upgrade — after upgrading there is no chance to refuse. And the path comparison must come first, or a caller's catch-all route (the usual SPA fallback) swallows the upgrade request, leaving a page that can never connect while HTTP looks perfectly healthy.

### Changed

- `attachPlacementStore` is now event-driven. It used to call `getBounds()` every 700 ms; it now takes a snapshot the moment a `STATE` event arrives and batches the disk write until 300 ms after the window settles. A window at rest costs zero native calls and zero disk writes, and a drag no longer writes on every frame. The `intervalMs` option is replaced by `debounceMs` (write delay) and `pumpMs` (internal pump cadence) — a 0.x minor is allowed to break that, and the old name would now be a lie.

    Snapshot and write are deliberately separate. Once the window is destroyed, `format_bounds()` returns an empty string because `!g_hwnd`; reading at debounce time would therefore drop the last change — exactly the one made by "drag, then immediately click X", which is how most people close a window.

- `createApp`'s `stop()` and `wait()` wait for `EVENT_CLOSED` instead of polling `isAlive()` every 50 ms. The 5-second ceiling stays: if the event channel ever fails, the host must not hang forever, and the timeout also resolves the close promise so `wait()` cannot hang on a dead channel. `isAlive()` keeps its symbol and its API — it is still a legitimate instant snapshot — but it is no longer the waiting criterion. `app.events` is exposed as the single consumer, so `attachPlacementStore(shell, file, { events: app.events })` reuses it instead of starting a second one.

- Exported symbols 33 → 34 and TypeScript declarations 32 → 33 (`shell_poll_events`). `native-surface.test.ts`'s hand-written `DECLARED` list and its total-count assertion moved with it.

- Twelve assertions in `tests/app.test.ts` plus seven in `scripts/consumer-probe.ts`. The probe now also exercises `bun-app-window/app` from the installed package.
- Three hardcoded counts in the docs are gone (`40 assertions`, `8 subpaths`, `182 test cases`): all three had already drifted. The consumer probe reports its own count now, and `AGENTS.md` says so.

### Note

- The pump timer's `unref` is not an implementation detail. An unref'd timer does not hold the event loop open, and a promise that never resolves does not either — so a host that `await`s for close while relying on an unref'd pump will exit with the window still open, which looks like "the app flashes and quits". `./state` unrefs (a persistence timer should not keep a process alive); `./app` pins the timer with `keepAlive: true` because waiting for close is exactly what it needs to survive.

- The acceptance for this release was bidirectional rather than one-sided. Commenting out `emit_event(SHELL_EVENT_STATE, ...)`, rebuilding, and running `scripts/probe-window-events.ts` turned it from 21/21 green to 11/21 red with `exit=1` — while the ten `CLOSED` assertions stayed green, confirming the injection was isolated to the state path. Restoring and rebuilding returned 21/21, and `verify-dll.ts` reported the same sha256 as before the injection, which also proves the build is reproducible. `docs/pitfalls.md` 2.4k records the four failure modes found along the way.

- This is **not** a competitor to `Bun.WebView`, and the READMEs now say so explicitly. `Bun.WebView` is a *headless* browser for automation, testing and scraping: it has no window, and it can only screenshot its own page. This package draws a real desktop window — system title bar, DPI awareness, snap layouts, taskbar identity — and its capture tool can photograph **any** window, which is the whole point for computer-use. Comparing API surface between the two is comparing different problems.

## [0.3.0] - 2026-10-21

### Fixed

- **A page link could navigate the app away, permanently.** In a desktop shell there is no address bar, no back button, and no host API that can navigate the page back — so one mis-click on an ordinary `<a href="https://example.com">` replaced the application with that website, and the only recovery was to close and relaunch. The native layer could not stop it either: `NavigationStarting` was never subscribed, `NewWindowRequested` was never subscribed, and `g_origin` was never assigned.

    This is worth describing precisely, because the failure was not a wrong decision — it was **241 lines of correct-looking code that had never been compiled**. `NavigationGuard`, `NewWindowGuard`, `open_external()`, `install_nav_guard()` and `uninstall_nav_guard()` were all present and heavily commented, but: `install_nav_guard()` had **no call site anywhere in the tree**; `SHELL_FLAG_ALLOW_EXTERNAL_NAV = 128` was declared in the C++ enum with **no parsing site**, and the TypeScript side had no corresponding constant at all, so a caller could not even express the intent; and `g_origin` carried a comment saying it was "computed by `shell_start_ex` from `g_url`" while never being assigned — which alone would have made `install_nav_guard()`'s first guard clause return early forever. Type checking, 532 test cases and the full gate were green throughout. The first `bun run build:native` produced six compile errors and settled it: `NavEventBase` existed to hold the refcount and `QueryInterface` plumbing, and **neither guard inherited it**.

    Two independent guards now install before `webview_navigate` and uninstall before `webview_destroy` (after destroy, `core_webview()` returns `nullptr` and `remove_` is unreachable). Verified end-to-end on a real window: a cross-origin navigation is cancelled and handed to the system browser — which then actually loaded the URL — while a same-origin navigation in the same run went through untouched.

### Changed

- **`FLAG_ALLOW_EXTERNAL_NAV` (new, `128`) opts out of navigation interception** for applications that genuinely are browsers. This is the release's one breaking-in-effect change: without the flag, a cross-origin top-level navigation now opens the system browser instead of replacing the app. Nothing else about the flag's surrounding policy moved — `window.open` / `target=_blank` is still cancelled and opened externally **even with this flag**, because that is a capability boundary rather than a safety policy: the shell owns exactly one top-level window (the native side is a process-level singleton), so a second window would have no host API able to close, read or message it.
- Only `http:` / `https:` ever reach `ShellExecuteW`. `file:`, `javascript:`, `ms-*:` and custom schemes are cancelled silently and never touch a protocol handler, and `mailto:` / `tel:` are deliberately **not** on the list either — a dead `mailto:` link is preferable to handing a page an arbitrary protocol dispatcher.
- **An origin-less startup URL is no longer a free pass.** The old predicate returned "same origin" whenever `g_origin` was empty, which meant `file://`, `about:blank` and custom-scheme apps — the most common shape for a desktop shell — were the least protected. That branch now degrades to a *same-document* test: a navigation stays inside the window only if it matches the startup URL after stripping the `#fragment`. In-app hash routing keeps working; anything else is external.

### Added

- `tests/nav-guard.test.ts` — eleven assertions, written against the **call-site and assignment-site** shapes rather than identifier presence, because `toContain("install_nav_guard")` passes on the definition alone and the definition was never the problem. It also pins the two `FLAG_*` tables together in both directions: every type constant must exist in the C++ enum **and** every C++ flag constant must exist in the type table. The forward assertion alone would not have caught this release's failure — the C++ side was written first and the TypeScript side was simply missing.
- `docs/pitfalls.md` 2.11 (declared-but-not-wired) and 2.12 (a probe's own criterion can lie), the latter recording two false criteria written during this work: a placeholder expression dressed as an assertion, and a "did the system browser load the page" check that cannot distinguish the browser from an in-webview navigation because both hit the same endpoint.

### Note

- The published tarball gains one exported constant (`FLAG_ALLOW_EXTERNAL_NAV`) and one `dist/libshell.dll` rebuild. Native exports are unchanged at 33 symbols.
- The behaviour change is observable without a flag: an app that was silently relying on external links navigating its own window will now see them open in the browser instead. That is the intent, and it is why this is a minor rather than a patch.

## [0.2.2] - 2026-10-21

### Fixed

- **The PNG encoder produced IDAT chunks that were not zlib.** `Bun.deflateSync` is byte-identical to `zlib.deflateRawSync`, so the output was **raw deflate**, while the specification requires zlib framing (`0x78` header plus an adler32 trailer). What made this expensive to find is that **three decoders gave two different answers**: `System.Drawing` opened the files, and our own decoder plus `Bun.inflateSync` decompressed them — because they share the same raw-deflate assumption as the encoder. Only the strict decoder rejected them: `Bun.Image` (libspng) returned `ERR_IMAGE_DECODE_FAILED`, and so did the upstream validator behind `read_file`. Worse, `Bun.Image.metadata()` still succeeded, because it reads only the header and never touches the IDAT payload — so the failure looked like "correct size, correct format, just won't open". `native/png.ts` now imports `deflateSync` from `node:zlib` (Bun's built-in node compat module, not an external node runtime), and `tests/png.test.ts` asserts both that the first IDAT byte is `0x78` and that the payload decompresses under **strict** zlib inflate — never `Bun.inflateSync`, which would make the assertion vacuous. Recorded as `docs/pitfalls.md` 3.11.
- **`Bun.Image.resize(w)` limits the width, not the longest edge.** The documented semantics are `resize(800)` → "width 800, keep aspect ratio". `native/model-image.ts` was calling `resize(maxEdge, undefined, { withoutEnlargement: true })`, which is correct for landscape images and silently wrong for portrait ones: `300×600` with `maxEdge: 100` produced `100×200`, four times the intended pixel count, with the token estimate and byte size inflated to match. The fix passes both dimensions with `fit: "inside"`. Caught by asserting on a **portrait** image; a landscape-only test would have stayed green. Recorded as `docs/pitfalls.md` 3.15.
- Six references in `AGENTS.md` and `docs/pitfalls.md` pointed at files that no longer exist: `tools/capture-window.ps1` (three occurrences), `probe-memory.ps1`, `src/safe-port.ts` (the module is actually `src/shell/port.ts`), and `src/gui/page-script.test.ts` (the whole `src/gui/` directory was removed when the UI became a static `src/ui/index.html`). A migration leaves legitimate historical references behind, so the fix is not to delete them but to make the decision explicit — see the guard under *Added*.

### Added

- `native/resample.ts` — area-average (box) downscaling over BGRA, and the reason `--max-edge` no longer goes through `Bun.Image` at all. Measured on a real 3098×1850 window scaled to 1300×776, median of five runs:

    | route | ms | bytes |
    | --- | --- | --- |
    | **our `downscaleBgra` + our encoder** | **45.9** | **102,036** |
    | `Bun.Image` resize + png | 95.9 | 222,621 |

    **2.1× faster and 2.2× smaller — both directions, not a trade-off.** It is faster because `Bun.Image` takes a PNG as input, so it must encode and then decode again before it can resample; we hold the raw `CreateDIBSection` pointer and never pay that. It is smaller because its default filter is `lanczos3` — a **sharpening** filter that rings around text edges, and the resulting high-frequency detail is exactly what DEFLATE compresses worst. Area averaging is inherently smooth, so the correct algorithm saves both costs at once. A prefix-sum variant was tried and came out **slower** (51.3 vs 39.1 ms for the resample alone): the extra full-width pass and the larger intermediate buffer cost more in cache locality than the inner-loop subtraction saves. Recorded as `docs/pitfalls.md` 3.16.
- `native/resample.ts` weights the average by alpha (`Σ(b·a)/Σa`) whenever any pixel is transparent, because a plain average mixes the RGB of fully transparent pixels — usually `0` — into the result and grows a black fringe around rounded corners and shadows. `scripts/make-icon.ts` produces exactly such rounded corners. Fully opaque input takes a fast path where the arithmetic is exact. `tests/resample.test.ts` pins this with a 2×2 → 1×1 construction (one opaque black pixel, three opaque whites): the right answer is white at alpha 191, the wrong one is grey 191.
- `cropBgra` in `native/gdi.ts` — cropping is a per-row `memcpy` over the raw pointer, so it costs no FFI and no resample. It is deliberately applied **before** encoding: once the pixels are handed to `Bun.Image` they are an opaque object and can no longer be cut. `--crop x,y,w,h` exposes it, and the rectangle is clamped to the image rather than producing a malformed one.
- `native/model-image.ts` — narrowed to the three things the in-repo code cannot do: **enlarging** (box averaging cannot interpolate), **palette** quantisation, and **jpeg / webp** encoding. Everything else on the PNG path now stays inside `native/`.
- A **two-way** guard on the `AGENTS.md` directory tree. The existing assertion ("everything declared must exist on disk") cannot catch the opposite failure, and `native/model-image.ts` sat outside the tree for a whole round while the gate was green — an unlisted file is invisible to an agent reading the tree as its map. Writing the reverse assertion also exposed a blind spot in the forward one: the tree is aligned by longest name, so `probe-child-windows.ts` is followed by a **single** space, and the parser's `\s{2,}` separator meant that line had never been parsed — and therefore never checked — since the guard was written.
- A guard for script paths referenced in the docs, backed by an explicit *deleted* allow-list (same orientation as `verify-pack.ts`'s `ALLOW`: adding an entry must be a deliberate decision). A second assertion fails if a listed-deleted file reappears, so the list cannot rot unnoticed.

### Changed

- `tools/capture-window.ts` defaults are now set by measurement rather than intuition: `--format png`, `--level 6`, `--max-edge 0`, plus a new `--level <1-9>` and `--crop <x,y,w,h>`. Level 6 is the knee — 31% smaller than level 1 for about 3 ms, and 4× faster than level 9 for 13% more bytes. End-to-end on a real window (including Bun startup and `PrintWindow`):

    | command | bytes | end-to-end ms |
    | --- | --- | --- |
    | `--level 1` | 704,353 | 148 |
    | default (level 6) | 439,347 | 170 |
    | `--level 9` | 411,366 | 330 |
    | `--crop 700,300,800,600` | **50,836** | 170 |

    Level 9 buys 6% for double the time; cropping buys **88%** and also drops the token estimate from 1024 to 291. Recorded as `docs/pitfalls.md` 3.14.
- The choice between the in-repo encoder and `Bun.Image` is now two conditions rather than one: **downscale *and* png** together keep the whole path inside `native/`; anything else (enlarging, palette, jpeg, webp) still goes to `Bun.Image`. Previously a crop was enough to trigger the `Bun.Image` detour, which re-encoded through it for no benefit — 50.0 ms / 84 KiB against 6.0 ms / 62 KiB for the same crop. **Cropping is a pixel operation and must not change the encoding route.**

### Note

- The published tarball is unchanged again: `native/` and `tools/` are repository-only. What a repository user will notice is that `bun run demo` screenshots are now roughly half the size at the same readable resolution.
- A screenshot is now cheap enough to be the primary feedback channel for agent work: a 3098×1850 window at full size is 212 KB, and the same view scaled to the vision model's 1300 normalisation ceiling is 102 KB — with text still legible, as the byte count alone cannot prove. That is the prerequisite for driving a GUI from an agent loop rather than for looking at a window once.

## [0.2.1] - 2026-10-21

### Changed

- **The PowerShell tool layer is gone: 14 scripts down to 2.** Everything that could move did. The remaining `scripts/test-sign.ps1` and `scripts/verify-sign-crypto.ps1` need CNG key generation and `SignedCms`, where a hand-written `bun:ffi` structure that is off by one field is a process-level segfault rather than an exception — a cost that buys nothing for two scripts run once per release. The decision and its evidence are in ADR 0014.
- `native/build-pack.ps1` → `native/build-pack.ts`, run as `bun run build:exe`. Three external tools disappeared with it: `llvm-objdump -p` (Subsystem), `rg -a -o` (embedded asset names) and `Get-AuthenticodeSignature` (signature presence) are now pure byte reads in `native/pe.ts`. Removing them is not about dependency count — the parsing is a pure function, so all three became `bun test` assertions (`tests/pe.test.ts`) instead of output a human has to eyeball.
- `scripts/make-icon.ps1` → `scripts/make-icon.ts`, and it no longer needs `System.Drawing`. The rounded rectangle is an SDF, the gradient is a projection, and anti-aliasing is 4×4 supersampling — `renderIcon(size)` is a pure function returning pixels, so `tests/make-icon.test.ts` asserts the corner alpha is 0, the centre alpha is 255, and that 16px omits the stroke and the three dots (below that size they smear into grey). The output ICO is 15,605 bytes against the previous 17,429; `System.Drawing.Icon` reads it back at 32×32 and the sampled centre pixel is the brand colour.
- The other five moved too: `scripts/trust-cert.ts`, `scripts/extract-icon.ts`, `scripts/probe-memory.ts`, `scripts/test-av.ts`, `tools/capture-window.ts`, `tools/probe-child-windows.ts`, `tools/probe-gui-boundary.ts`. `scripts/test-av-runtime.ps1` was **deleted rather than migrated** — its premise was a Session 0 agent observing a Session 1 GUI process through `schtasks /IT`, which stopped being true when OTT moved to Session 1 (`ADR 0005`). Its two remaining abilities moved into `probe-memory.ts` (module enumeration, WebView2 child processes) and `test-av.ts` (Defender scan plus event log).

### Added

- `native/png.ts` — a PNG writer, and the single reason three of those scripts could move. `System.Drawing.Bitmap.Save(ImageFormat.Png)` was the only genuine blocker; what it actually did was four chunks and a zlib call, and `Bun.deflateSync` already supplies the zlib. `tests/png.test.ts` round-trips every image it encodes back through a minimal decoder and compares pixels byte for byte, because asserting the signature `89 50 4E 47` would stay green even if the channel order were wrong.
- `native/win32.ts` and `native/gdi.ts` — the Win32 surface the diagnostic scripts need, grouped by the DLL each symbol actually lives in rather than by meaning. `EnumWindows` and `EnumChildWindows` are replaced by `GetTopWindow` + `GetWindow` iteration, so no C→JS callback is involved at all.
- `native/pe.ts` — read-only PE parsing: Subsystem, certificate table, and embedded asset names.
- 324 new test cases across `tests/png.test.ts`, `tests/make-icon.test.ts`, `tests/win32.test.ts`, `tests/pe.test.ts`, `tests/build-pack.test.ts`, `tests/tooling.test.ts`. Total is now 456 across 25 files.

### Fixed

- **`u64_fast` returns `number` or `bigint` — and which one is not stable.** The same declaration returned `number 1694568820` from one `CreateCompatibleDC` call and `bigint 18446744073676065759n` from the next. Code that checked `typeof h === "number"` to detect a null handle therefore treated a valid DC as `0`, and `extract-icon` silently produced a fully transparent PNG. Every handle return now goes through `toHandle()`; the pitfall is recorded as `docs/pitfalls.md` 3.7.
- **`DrawIconEx` has nine parameters, and the first version declared eight.** The missing `hbrFlickerFreeDraw` shifted `diFlags` to zero, so the call returned `true` and drew nothing. `bun:ffi` moves arguments as declared and does not check arity — a wrong parameter count is as silent as a wrong type, not only as fatal as a wrong pointer. Recorded as `docs/pitfalls.md` 3.9.
- **Two symbols were declared in the wrong DLL.** `DestroyIcon` and `DrawIconEx` both live in `user32.dll`, not `shell32.dll` or `gdi32.dll`, and `dlopen` refuses the whole descriptor when any symbol is missing — so one wrong DLL disables every symbol in that block. Recorded as `docs/pitfalls.md` 3.10.
- `native/build-pack.ts` computed the repository root with `resolve(dirname(import.meta.dir), "..")`, one level too far, so `bun run build:exe` resolved the entry as `_Repositories/src/host.ts`. The gate was fully green at the time: every `main()` test passed `root` as an argument, and no test asked what the entry point computes for itself. The fix exports `REPO_ROOT` and pins it with three assertions, including the reverse one — the parent directory must **not** contain a `package.json`.
- The pitfalls guard compared section numbers as floats: `Number("3.10")` is `3.1`, which sorts before `3.9`. Nothing noticed until this release introduced the first two-digit minor number. Now encoded as `major * 1000 + minor`.
- `scripts/test-av.ts` treated a missing `wevtutil` as a thrown `ENOENT` from `Bun.spawn` rather than as a reportable state; the spawn wrapper now returns a negative exit code instead of propagating.

### Note

- Nothing in the published tarball changes: `files` still ships `src/shell`, `src/ui/titlebar.ts`, `dist/libshell.dll` and the docs. This release is entirely about the tooling that builds and verifies it. `bun run build:exe` is the one behaviour a repository user will notice — it no longer needs pwsh.

## [0.2.0] - 2026-10-20

### Changed

- The gate entry point moved from `scripts/gate.ps1` to `scripts/gate.ts`, run as `bun run scripts/gate.ts` (`--clean`, `--skip-pack`, `--keep-clone`). PowerShell-style `-Clean` / `-SkipPack` are accepted too. The reason is structural rather than aesthetic: `$LASTEXITCODE` is a global that only reflects the last native command, and every PowerShell function leaks its child-process output into the return-value pipeline — the exact mechanism behind the "reported GATE PASSED while the type check had failed" bug recorded in `docs/pitfalls.md` 5.3. `Bun.spawn`'s `exited` is bound per call, and `gate.ts` is itself covered by `bun check` (which caught a dead import on the first run). See ADR 0012.
- Four more PowerShell scripts moved to TypeScript: `install-hooks`, `native/build`, `run`, and `bump-version`. All now accept both `--kebab-case` and `-PascalCase` flags, are covered by `bun check`, and are behind the entry-point guard. Only the 14 scripts that genuinely need Win32 APIs (`Add-Type` P/Invoke, `System.Drawing`, the certificate store, `Get-CimInstance`) remain as `.ps1`. Total: 18 files / 1361 lines down to 14 files, with the four ordinary ones gone.
    - `bun run build:native` now runs `bun run native/build.ts`. The clang++ argument list became a pure function (`clangArgs`) asserted by `tests/build.test.ts`: a missing `-l` or a misplaced `-I` used to surface only as a C++ link error pointing at the compiler rather than at the script.
    - `scripts/install-hooks.ts` writes the hook as raw UTF-8 bytes with no EOL translation — the failure mode the `.ps1` version had (`Set-Content` rewrites to CRLF, which makes `sh` unable to execute the hook) is structurally impossible here, and `tests/install-hooks.test.ts` asserts the template contains no CRLF.
    - `run.ts` drops the hardcoded `C:\Users\root\scoop\shims\bun.exe` and uses `process.execPath` — the running interpreter is by definition the bun to use.
    - `scripts/bump-version.ts` replaces only the version literal and asserts the file's original EOL survived; the `.ps1` version used `-replace` (regex engine) plus `Set-Content` (CRLF rewrite), so a one-token edit could rewrite every byte of the file.
    - Verified equivalent output: `build.ts` produces a byte-identical-size `libshell.dll` (940,032 bytes, 33 exported symbols) and `.build/` and `dist/` copies hash equal.
- A shebang was verified rather than assumed: `#!/usr/bin/env bun` does nothing in PowerShell (Windows does not parse shebangs — `./gate.ts` is opened as a document), but it **does** work under the `sh` that Git ships, which is the environment `pre-push` runs in. The hook therefore calls `bun run scripts/gate.ts` explicitly, which is correct on every platform.
- The published tarball now carries only the shipping surface: 19 files (1.1 MB unpacked) instead of 101 (2.40 MB). The native C++ layer (`native/`) and the vendored upstream headers (`vendor/`) are no longer packed — they are only needed to rebuild `libshell.dll`, which requires cloning the repository. `bun run build:native` and `build:exe` are therefore repository-only entry points and do nothing useful inside `node_modules`.

### Fixed

- `bun-app-window/native` had no type declaration, so the documented `with { type: "file" }` import failed `bun check` with `TS2307` in any consumer. The subpath now uses a conditional export (`types` → `src/shell/native-asset.d.ts`, `default` → the DLL), leaving the runtime resolution unchanged: `import.meta.resolve()` still yields the real DLL path.
- Type-checking a project that depends on this package requires `@types/bun`; the requirement is now stated in the requirements table of all three READMEs, together with the exact error you get without it.
- `native/fetch.ps1` never worked on a fresh clone. Its first step gated on whether `vendor/webview/.git` existed, but the vendored copy is committed as plain files with no `.git` — so the condition was always true, `git clone` was attempted into a non-empty directory, `git` returned 128, and the script threw before ever reaching the SDK extraction step. The criterion is now the same three files `native/build.ps1` validates (`webview.h`, `EventToken.h`, `WebView2.h`), so the two scripts can no longer disagree about what "ready" means. **The script is now `native/fetch.ts`** (see below).
- Building the native layer on a fresh clone is now fully offline by default: `vendor/webview` ships in the repository and `vendor/webview2` is extracted from the also-committed `Microsoft.Web.WebView2.1.0.1150.38.nupkg`. Network access became opt-in via `-Webview` (re-clone upstream, overwriting 145 tracked files) and `-Sdk` (re-download and re-extract); `-Force` keeps the old "do everything" meaning. `-Webview` also drops the staged `.git` so the result stays identical in shape to the committed copy, instead of nesting a second repository inside this one.
- `fetch.ps1` now reports the three inputs with sizes plus the upstream `WEBVIEW_VERSION_*` values, and exits 2 when a required tool (`git.exe` / `aria2c.exe` / `7z.exe`) is missing rather than failing halfway through.
- `native/fetch.ps1` was migrated to `native/fetch.ts`, run as `bun run native/fetch.ts` (`--root`, `--webview`, `--sdk`, `--force`; PowerShell-style `-Webview` etc. are accepted too). Behaviour is unchanged, but the decision logic — four directory states for `vendor/webview`, four for the SDK — is now two pure functions (`decideWebview`, `decideSdk`) covered by 14 cases in `tests/fetch.test.ts`. The state that had never been verified before, "directory exists but inputs are incomplete", is now pinned: it must refuse with exit 1 and leave the tree untouched. A static assertion also reads `native/build.ps1` and requires every entry of `INPUTS` to appear in its pre-flight checks, so the two scripts cannot drift apart again. That assertion failed on its first run for a real reason — `build.ps1` builds those paths by joining `$wv` with a relative tail, so the full string never appears contiguously.
- `scripts/verify-pack.ts` leaked its temp workspace on every run. Two independent causes: `process.exit()` was called inside the `try` block, which terminates the process immediately and skips `finally`; and the success path's cleanup failure was swallowed by `.catch(() => {})`. All paths now funnel through `finally`, the exit code is set via `process.exitCode` instead of an immediate exit, and a failed removal prints a warning rather than disappearing. Verified on both paths — a normal run and an injected failure (a disallowed file added to `files`) each leave `%TEMP%` with zero `baw-pack-*` directories.
- The gate's third stage failed inside the `pre-push` hook with `tar (child): Cannot connect to C: resolve failed`, while passing in pwsh. `Bun.which("tar")` resolves to different binaries in the two environments: Git ships **GNU tar 1.35**, which reads `C:/...` as a `host:path` remote; pwsh resolves to `%SystemRoot%\System32\tar.exe` (bsdtar), which understands drive letters. Fixed with two independent layers — prefer System32's bsdtar on win32, and pass a bare filename with `cwd` instead of an absolute path, so a relative name never contains a colon.
- Entry-point detection could silently disable a script. `import.meta.main` becomes `false` under `bun run <path>` when the caller's cwd differs from the real directory only in letter case (`_repositories` vs `_Repositories`), which is exactly what Git's `sh` produces. The guard then skipped the whole entry block and the script exited `0` having done nothing — a gate that runs nothing and reports success. Detection is now `import.meta.main || argv[1]` matching `import.meta.path` after normalisation (`scripts/lib/entrypoint.ts`).
- The first version of that helper was itself the bug: it read `import.meta.main` / `import.meta.path` inside the imported module, where `main` is always `false` and `path` points at the helper. It returned `false` unconditionally and turned off all three entry points — silently. It is now a pure function taking both values from the caller, pinned by `tests/entrypoint.test.ts` (11 cases, including a regression test that the guard can never be constantly false).

### Added

- `tests/gate.test.ts` and `tests/verify-pack.test.ts` close the gap that mattered most: the gate had no tests of its own. `gate.ts` is where every other guarantee enters, so a quiet regression there — a stage that always reports success, a short-circuit that stops short-circuiting — disables everything downstream while still printing `GATE PASSED`. The decision logic is now split into exported pure functions (`normalizeArg`, `parseGateArgs`, `checkedFileCount`, `parseTestCounts`, `parsePackSummary`, `parsePs1Summary`, `planStages`, `formatStage`, `summarize`) with execution injected through `GateDeps`, so the short-circuit itself is asserted by handing `runGate` a fake runner rather than by spawning four child processes. `checkPayload` — the deny-by-default allow-list that decides what may be published — is covered the same way. 49 new cases; both entry points are behind an entry-point guard, so importing them in tests has no side effects.
- `tests/entrypoint.test.ts` (11 cases) pins the entry-point guard, including a regression test that it can never be constantly false — the first implementation was, and it silently disabled all three scripts.
- The gate gained a second stage: syntax-checks every remaining `.ps1` with `[System.Management.Automation.Language.Parser]::ParseFile`. The 18 PowerShell scripts that stay have neither type checking nor tests, so this is the cheapest available guard — it catches unbalanced braces and misspelled keywords, not semantic errors. It is explicitly a migration-period fence: when those scripts are migrated or formally kept, the stage should be deleted rather than left as permanent weight. Missing `pwsh` counts as a skip, not a failure.
- `scripts/verify-pack.ts` and `scripts/consumer-probe.ts`: consumer acceptance as an executable gate. It packs the tarball, asserts every file against a deny-by-default allow-list, installs it into a scratch project under `%TEMP%`, type-checks that project, and runs 40 runtime assertions against the installed package — all eight subpaths resolving, the DLL actually being `dlopen`-ed out of `node_modules`, `libInfo.source === "package"`, IPC request/reply and event push, and a real `serveOnSafePort` bind. Offline, about 0.4 s.
- The gate gains a third stage that runs the above, on by default. `--skip-pack` exists for bootstrapping changes to the gate itself.
- `docs/pitfalls.md` 5.6 records that PowerShell's `Set-Content` rewrites line endings to CRLF regardless of the original, so a script that edits and then "restores" a file leaves a byte-level diff with an empty content diff. Encountered while smoke-testing the new `.ps1` syntax stage.
- `bun-app-window/native` is documented in all three READMEs (`import.meta.resolve` gives the DLL path; use `bun-app-window/embedded` for `bun build --compile` instead).
- ADR 0010 records the publish-surface decision, the conditional-export fix, and why `sideEffects: false` must not be added (it would let a bundler shake away the DLL embedding import in `embedded.ts`).
- ADR 0011 records the `fetch` criteria change: why the criterion must equal the files `build.ps1` actually validates, and why the network-touching steps became opt-in switches. The operational version lives in `docs/pitfalls.md` 5.5.
- ADR 0012 records the move of the gate to TypeScript: the three PowerShell mechanisms it removes (`$LASTEXITCODE` as a global, function output leaking into the return-value pipeline, no static checker), the measured behaviour of shebangs on Windows, and the migration boundary — scripts that are pure process orchestration migrate, those that need Win32 APIs (`Add-Type` P/Invoke, `System.Drawing`, the certificate store, CIM) stay where they are. The migration is now complete on the orchestration side: only those 14 Win32 scripts remain as `.ps1`.

## [0.1.0] - 2026-10-20

First public release.

### Added

#### Window shell

- `createShell()` builds a shell from `ShellOptions` without starting it; `openShell()` starts it and throws on failure. `Shell.start()` returns `{ rc, error }` instead of throwing, and the native layer creates the UI thread itself, so the caller's main thread is never blocked.
- Window flags, composable with bitwise OR: `FLAG_FRAMELESS` (1), `FLAG_TOPMOST` (2), `FLAG_CENTER` (4), `FLAG_RESIZABLE` (8), `FLAG_DEFER_SHOW` (16), `FLAG_ACCEPT_DROP` (32), `FLAG_START_MAXIMIZED` (64). `FLAG_CENTER` and `FLAG_START_MAXIMIZED` work in both decorated and frameless modes.
- Window controls: `setTitle`, `minimize`, `toggleMaximize`, `close`, `drag`, `beginResize(edge)` with `RESIZE_EDGE` matching the Win32 `HT*` constants, `setMinSize` (logical pixels, converted per current DPI), `show`, `setAppId`.
- `state()` reports `maximized` / `minimized` / `focused` / `dark`; `isAlive()` distinguishes "destroyed" from "never started"; `lastError()` copies the shared error slot instead of returning its pointer, so concurrent writers cannot corrupt the read.
- `stop()` is idempotent. Termination is dispatched to the UI thread, because `PostQuitMessage` only affects the calling thread's queue.

#### Desktop behaviour

- First frame without a white flash, via three cooperating mechanisms: subclassing installed before sizing, the initial size call kept (it sets the internal `m_is_size_set` flag), and the WebView2 default background replaced before navigation. Omitting any one of them reintroduces the flash.
- Frameless windows keep DPI-correct hit testing, edge resize, and snap layout support.
- Window state push with change detection plus a 16 ms trailing throttle, so drag-resizing does not flood the renderer over the cross-process bridge. Both window procedures keep their `WM_TIMER` branch.
- Zoom from `Ctrl` `+` / `-` / `0` and `Ctrl`+wheel, clamped to 0.25–3.0, with `setZoom` / `getZoom` for programmatic control. Scale factors cross the native boundary as milli-units because `wsprintfA` cannot format floats.
- File drop, reload, DevTools, and fullscreen toggles, all routed through one shared input pre-handler instead of being duplicated per window procedure.

#### Application chrome

- `setBrowserUi(mask)` and `ShellOptions.browserUi`, with `BROWSER_UI_MENU` (1), `BROWSER_UI_KEYS` (2), `BROWSER_UI_STATUSBAR` (4), `BROWSER_UI_SWIPE` (8), `BROWSER_UI_AUTOFILL` (16), and `BROWSER_UI_ALL`. The swipe switch lives on `ICoreWebView2Settings6`, not `Settings5`.
- `showContextMenu(x, y, items)` renders a native Win32 menu from a line-based `id|label` protocol, where a lone `-` is a separator. The selection comes back as `{ t: "menu", id }`.
- `pickFolder()` calls `SHBrowseForFolder` directly — no child process, no temporary script, no execution-policy dependency — and binds the dialog to the host window so it cannot fall behind it. It is synchronous and blocks the calling thread.

#### Typed IPC (`bun-app-window/ipc`)

- `createIpcServer({ service })` derives a route table from a plain object; `connect()` and `webSocketChannel()` hand the client a generic proxy typed against the service.
- Request/reply over WebSocket with per-call ids and concurrency-safe matching. Unknown methods and methods inherited from the prototype chain are rejected as errors returned to the caller, never thrown into the host.
- `undefined` returns normalize to `null`, because JSON drops the field. Error stacks are withheld unless `exposeStack` is enabled.
- Events broadcast to every attached peer; writes to dead connections are skipped without disturbing live ones. A throwing handler does not prevent the other handlers from running.
- Timeouts reject the pending call and late replies are discarded. Closing the channel rejects everything in flight, and calling after close fails immediately without writing.

#### Windows 11 title bar (`bun-app-window/titlebar`)

- `mountTitleBar()` with `TITLEBAR_GLYPHS` in both `unicode` and `fluent` sets, accessible labels that track the maximized state, drag and double-click-to-maximize, and control-area exclusion so pressing a button does not drag the window.
- `titleBarCss()` injects the stylesheet once and shares it across instances; themes switch through attribute selectors. `bridgeFromWindowService()` forwards the four window methods.
- Zero external dependencies and no access to shell internals — the component only needs the DOM and the bridge.

#### Placement persistence (`bun-app-window/state`)

- `savePlacement` / `loadPlacement` / `capturePlacement` / `restorePlacement` / `attachPlacementStore`, plus `parseBounds` / `parsePlacement` for the raw formats.
- Writes are atomic (temporary file plus rename, no `.tmp` residue). Reads validate the shape, so a hand-edited, truncated, or missing file degrades to `null` instead of throwing.
- `attachPlacementStore` polls at 700 ms and does not touch the disk while the window is at rest.
- Maximized windows persist their restore rectangle; coordinates are converted across DPI changes and corrected when the monitor they were saved on is gone.

#### Diagnostics (`bun-app-window/debug`)

- `debugOf(shell)` exposes `hittest`, `metrics`, `dpi`, `selfBase`, and `selfPath`. Deliberately kept off the main facade so the diagnostic shape can evolve without becoming part of the public contract.

#### Packaging and distribution

- `resolveNativeLib()` follows a four-level priority: explicit `nativeLibPath`, embedded bytes released to `%LOCALAPPDATA%\<appName>\runtime\` and named by content hash, a `libshell.dll` next to the executable, then the development layout (`.build/` before `dist/`). The reported `source` distinguishes `explicit` / `embedded` / `package` / `dev`.
- `bun-app-window/embedded` bundles the DLL into `bun build --compile` output. `embeddedDll()` returns `null` outside a compiled binary rather than throwing.
- Released copies are written atomically, reused when an existing file already matches by size (`reused: true`), and stale hashed copies are pruned without failing on files still mapped by another process.
- `serveOnSafePort()` avoids the browser-restricted port list that causes `ERR_UNSAFE_PORT`, binding inside 40000–60000; `isRestrictedPort()` exposes the check.
- The `bun-app-window/native` subpath resolves to the shipped `dist/libshell.dll`.

#### Quality gates

- `bun check` type-checks 21 files and `bun test` runs 103 cases across 10 files, covering exports, first paint, capabilities, IPC, the native surface, ports, library resolution, placement, the title bar, and agreement between TypeScript constants and their Win32 counterparts.
- TypeScript strict mode with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noImplicitOverride`, and `noUnusedLocals` / `noUnusedParameters`.
- The 33 exported symbols of `libshell.dll` are pinned by a hand-written list in the native surface test, so a symbol cannot silently drop out of coverage.

### Known limitations

- Windows x64 only. The `os` and `cpu` fields in `package.json` reject every other platform at install time. Cross-platform support is a reservation in the design, not a capability: `shell.cc` is Win32 and WebView2 throughout.
- TypeScript sources are published, not compiled. Consumers need Bun 1.4.3 or newer. Installing under Node succeeds but nothing runs.
- `bun:ffi` is marked experimental in Bun, and the entire native boundary depends on it.
- `pickFolder()` blocks the calling thread. The modal loop inside `SHBrowseForFolder` keeps timers on that thread from firing, and the call cannot be cancelled or timed out. Run it in a worker if you need concurrency.
- One window per process. The native layer keeps a process-wide singleton, so a second `start()` fails until the previous window is observed dead through `isAlive()`.
- Not yet verified in managed environments that enforce AppLocker, WDAC, or third-party EDR behaviour blocking.
- No commercially trusted code signing: only a self-signed certificate has been exercised end to end.

[Unreleased]: https://github.com/TiancongLx/bun-app-window/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TiancongLx/bun-app-window/releases/tag/v0.1.0
