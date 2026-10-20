# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-20

### Changed

- The gate entry point moved from `scripts/gate.ps1` to `scripts/gate.ts`, run as `bun run scripts/gate.ts` (`--clean`, `--skip-pack`, `--keep-clone`). PowerShell-style `-Clean` / `-SkipPack` are accepted too. The reason is structural rather than aesthetic: `$LASTEXITCODE` is a global that only reflects the last native command, and every PowerShell function leaks its child-process output into the return-value pipeline — the exact mechanism behind the "reported GATE PASSED while the type check had failed" bug recorded in `docs/pitfalls.md` 5.3. `Bun.spawn`'s `exited` is bound per call, and `gate.ts` is itself covered by `bun check` (which caught a dead import on the first run). See ADR 0012.
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
- ADR 0012 records the move of the gate to TypeScript: the three PowerShell mechanisms it removes (`$LASTEXITCODE` as a global, function output leaking into the return-value pipeline, no static checker), the measured behaviour of shebangs on Windows, and the migration boundary — the 6 scripts that are pure process orchestration migrate, the 14 that need Win32 APIs (`Add-Type` P/Invoke, `System.Drawing`, the certificate store, CIM) stay where they are.

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

[Unreleased]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TiancongLx/bun-app-window/releases/tag/v0.1.0
