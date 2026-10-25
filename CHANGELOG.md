# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Shell.getRect()` reads the window rectangle as a structure.** `getBounds()` has always returned
  the native line `"x,y,w,h,maximized,dpi"` as a string, so every consumer had to split and validate
  it themselves — and the minimised sentinel rectangle (`-32000,-32000` plus an icon-sized box)
  passes a naive shape check while being a completely fake position. Reading geometry from the host
  also meant importing `bun-app-window/state` (which pulls in `node:fs`) for a single value.

    `getRect()` returns `{ x, y, width, height, maximized, dpi } | null`, applying the same three
    rejections as `parseBounds()`: window not started, zero size or DPI, or the sentinel rectangle.
    All six fields come from one native read, so a caller asking "is this the whole screen?" does not
    need a second FFI call that could observe a different state.

- **`parseBounds` and `WindowRect` moved to `bun-app-window/types`.** `bun-app-window/state` still
  re-exports both — `WindowPlacement` is now an alias of `WindowRect`, not a second structurally
  identical type — so existing imports keep working. The move lets the main entry use the parser
  without depending on `node:fs`, and both paths expose the same function object.

## [0.8.0] - 2026-10-25

### Added

- **`bundlePage` passes `plugins`, `define` and `loader` through to `Bun.build`.** These are the
  generic fields a compiling frontend framework needs; before this release `BundlePageOptions` had
  only `entry` and `minify`, so Svelte and Vue could only be built by calling `Bun.build` directly
  and giving up the failure diagnostics and byte accounting this module exists to provide.

    Measured on a real Svelte 5 component (`bun-plugin-svelte` 0.0.6): 109,888 B entry script plus a
    133 B stylesheet, with the component's render code present in the output.

- **`PageBundle` now reports every output, and `writePageBundle` writes them all.** `outputs` lists
  each artifact with its `path` / `kind` / `code` / `bytes`; `code` and `bytes` keep their previous
  meaning and now come from the `entry-point` artifact rather than `outputs[0]` — output order is
  not a contract, and stylesheets can sort first.

    The second artifact used to be dropped silently. The symptom was a page that rendered correctly
    with no styling, and nothing anywhere reported a missing file. `writePageBundle` now returns
    `written: Array<{ path, bytes }>` so a caller's cleanup can remove every file it produced, not
    just the entry one.

    Placement rule: the entry artifact goes to `out`; every other artifact goes to the same
    directory with its extension substituted. `page.bundle.txt` therefore yields
    `page.bundle.css`, not `main.css` — the entry's filename is an implementation detail and must
    not leak into a path that HTML and `assets` reference.

- **`createApp({ assets })` serves extra static files.** A path-to-text map with `content-type`
  inferred from the extension. Multiple artifacts meant every consumer had to hand-write a `routes`
  callback to serve the stylesheet, and the usual mistake — a wrong MIME type — makes the browser
  drop the stylesheet silently. Unrecognised extensions fall back to `application/octet-stream`
  rather than guessing: a wrong MIME type means the file is not executed, while a fallback means it
  is downloaded, and the latter is immediately visible.

    A caller's `routes` still wins, and paths that are not registered are 404 — `assets` is a
    convenience, not a catch-all.

- **Page-side errors are now reported to the host.** An injected listener captures `error` and
  `unhandledrejection` and posts them to the host over HTTP — deliberately not over the WebSocket,
  which does not exist yet when a page script fails during evaluation, and that is the case worth
  observing most. Pass `onPageError` to receive a `PageError`; without a callback the host prints
  them to stderr rather than discarding them.

    Measured on a real window: a page script that throws at module evaluation used to produce a
    blank window and a single "window ready" line in the host log. It now produces
    `kind=error message=Uncaught Error: … source=…/page.js:1:7` in the host log within the same
    startup.

- **`emit()` accepts `{ sticky: true }`.** A page loads after the window is created, so anything
  broadcast between `createApp` returning and the page's WebSocket opening is delivered to zero
  connections and never replayed — a page that reads its initial state from events alone stays
  empty, with no error at either end. Sticky events keep the last payload per event name and replay
  it in `attach()`. It is opt-in: a notification-shaped event that turns sticky gives late
  connections one stale message that reads like a fresh one.

### Changed

- **The gate gains a third stage: `bun fmt --check --no-script`.** Four stages now — `check` →
  `test` → `fmt` → `pack`. The formatting check costs about 50 ms on 92 files, and it sits before
  the consumer acceptance stage because a formatting problem is local code quality, not a
  distribution question. `--skip-fmt` exists for the same reason `--skip-pack` does; `--skip-test`
  does **not** skip it, since formatting and tests have no dependency between them.

    Two criteria this stage depends on, each measured rather than assumed:

    **`--no-script` is mandatory.** When `package.json` has a `fmt` script, `bun fmt --check` hands
    the whole command to that script and returns its exit code verbatim. Measured with a script that
    only prints one line: `bun fmt --check` exited 0 and printed that line, having inspected no files
    at all. The criterion would silently degrade to "did that script succeed". This repository has no
    `fmt` script today, so the flag changes nothing right now — which is exactly why it needs a
    static assertion: the failure point is the day someone adds the script, and nothing would turn
    red then.

    **The file count has to be checked.** If `.prettierignore` is ever written as `*`, the command
    exits 0 and reports everything compliant while having looked at nothing. `fmtVerdict()` therefore
    treats "exit 0 but no file count parsed" as a failure, the same way `bun check` treats "checked 0
    files".

    **The judgement is a pure function because it had no guard.** Reverse verification ran before
    this was written: removing "non-zero exit means failure" and removing the "count below 1" guard
    each left the entire suite green — `runFmt` can only be reached by spawning a real subprocess,
    and the short-circuit tests use a fake runner. The logic was lifted into `fmtVerdict()` so both
    defences have cases; removing either now turns the corresponding assertion red, verified in both
    directions.

- **The declared toolchain baseline is Bun 1.4.4.** `engines.bun` is `>=1.4.4` and `@types/bun` is
  `^1.4.4`; the three READMEs, the requirement table and the badge follow. The declaration is backed
  by the gate run recorded at the end of this entry, not inherited from an earlier release.

    Two behaviours were re-measured on this baseline rather than assumed unchanged:

    | Probe                                  | Result                              |
    | -------------------------------------- | ----------------------------------- |
    | `FFIType.buffer` as `args` / `returns` | throws `invalid ABI type`           |
    | `"buffer"` string literal as `args`    | accepted, and rejected as `returns` |

    So the `bun:ffi` constraint in `AGENTS.md` §5.1 holds on this baseline unchanged.

    `bun-types@1.4.4` gates its import-attribute declarations behind
    `typesVersions: { ">=7.1": ... }`, and its root `index.d.ts` is 1,306 B with no
    `import-attributes` reference. The TypeScript 7.0.2 limitation documented in the requirements
    table therefore still holds; nothing about it changed with this baseline.

    Full regression: `bun check` 80 files, `bun test` 683 pass / 0 fail across 36 files,
    `VERIFY-PACK PASSED` (7 checks), consumer probe 70 checks with `source=package`.

- **`alias` is implemented by this package, not passed through.** The plan was to forward it like
  the other three fields; measurement said otherwise. Bun 1.4.4's `BuildConfig` has no `alias`
  property, and passing one is not an error — it is silently ignored. Four forms were tried
  (absolute path to a file, relative path to a file, relative path to a directory, trailing-slash
  key) and all four failed to resolve, each reporting only `Bundle failed`.

    It is now backed by a small `onResolve` plugin with a specified boundary: a specifier equal to a
    key or prefixed by `key/` is rewritten; relative paths, absolute paths and `scheme:` specifiers
    are left alone. The plugin is only registered when `alias` is supplied, so its hook does not sit
    in every resolution path. When the alias target cannot be resolved, the candidate path is
    handed back unchanged so Bun reports its own error rather than a rewritten one.

    Aliases merge with, rather than replace, the caller's plugins — the two are orthogonal, and
    replacing would make "using alias means you cannot use a framework plugin" a hidden rule.

- **BREAKING: `createIpcServer` throws when the service table contains a reserved client name.**
  `on` / `off` / `close` / `connected` / `pending` / `then` resolve to the IPC client's own members,
  so a service method under one of those names is unreachable and neither end reports anything.
  Measured before this change: `client.close()` returned `undefined` — not a Promise — and the
  server-side method was invoked zero times, with no exception raised, because `await undefined` is
  a legal expression. The check runs at creation and names the offending keys. Pass
  `{ rejectReservedNames: false }` only when the table is generated from external input and
  validated elsewhere.

- **`createApp` validates `html` against `page`.** Supplying one without the other produced a window
  that rendered normally, loaded no script, and responded to nothing, with an empty host log.
  Both directions now throw before the server starts; a reference that lacks `type="module"`
  produces a warning instead, because the legal ways to write a `<script>` tag are too varied for a
  string match to justify blocking startup.

- **Release verification split into two points around the irreversible step.** A release writes three carriers: the git commit, the GitHub tag + release, and the npm tarball. The first three actions can all be undone; `bun publish` cannot — the version number is spent permanently. Verification therefore now happens on both sides of it.

    - `release-verify.ts --pre-publish`, run between `gh release create` and `bun publish`: HEAD equals `origin/main`, the tag is annotated and points at HEAD, the release exists and is not a draft, and npm has not yet taken that version number. This is what authorises the irreversible step.
    - `release-verify.ts`, run after publish: the core check is a single comparison — `tag → git archive → bun pm pack → sha1` against the tarball downloaded from npm. When that matches, every file inside is identical, so no per-file or per-paragraph assertion is needed. `bun pm pack` was measured to be deterministic: repacking the `v0.7.0` tree reproduced the sha1 npm had already published, byte for byte.

- **The pre-release sentinel went from sixteen checks to six.** Eight of them duplicated `tests/version.test.ts` and `tests/readme-contract.test.ts` verbatim, and the three package-size checks stated one fact three times. What remains is exactly what `bun test` structurally cannot do: CHANGELOG section, CHANGELOG links, empty `Unreleased`, clean working tree, unoccupied tag, and the declared package size against the real tarball. Duplication costs more than a few milliseconds — two implementations drift, and then a person bypasses whichever one is stricter, which is usually the one nobody maintains.

### Note

- **`alias` defaults to empty, deliberately.** `$lib` is a SvelteKit convention and `@/` is some
  project's `tsconfig` alias; neither belongs to this package. Presetting either would mean choosing
  an ecosystem on the consumer's behalf.

- **Neutrality is now enforced by tests, not by convention.** `tests/pack-neutrality.test.ts` asserts
  that `dependencies` / `peerDependencies` / `optionalDependencies` are all empty, that no frontend
  framework name appears in a non-comment line of `src/shell/`, and that no alias is preset.
  Rationale and rejected alternatives are in `ADR 0021` (repository-local).

- The three READMEs gain a subsection on multi-artifact output; package size re-measured as
  22 files / 0.50 MB packed / 1.47 MB unpacked.

- **`bun fmt` adopted with an explicit style, and one contract moved off source layout.**
  `bunfig.toml` pins `useTabs = false`, `tabWidth = 4`, `printWidth = 120`; `.prettierignore` excludes
  `vendor/` first, because that tree is a verbatim upstream copy and editing it manufactures
  conflicts with the next upstream sync. 73 files were reformatted; `vendor/` verified unchanged.

    The style had to be declared rather than defaulted: `bun fmt --help` documents `tabWidth` as
    `default: 2`, while 1.4.4 actually emits 4. A default that disagrees with its own documentation
    is not a fact to depend on.

    Reformatting exposed a real defect rather than a cosmetic one. `tests/version.test.ts` read
    `--windows-version` **line by line**, so it only recognised the version literal when
    `"--windows-version", "0.8.0.0",` sat on one line. At 120 columns the formatter splits those two
    elements, and four assertions went red against code that had not changed. The contract was
    anchored on layout instead of on the value. It now matches over the whole text after blanking
    comment lines, so both layouts parse; `bump-version.ts` already spanned lines via `\s*` and
    preserves the surrounding whitespace, which is now pinned by a test that asserts the rewritten
    version stays on its own line rather than being collapsed back.

    `bun fmt` does **not** honour `// prettier-ignore` on array elements — measured: the comment is
    kept, the element is still split. That is why the fix moved the parser instead of silencing the
    formatter.

    The reformat adds 30 KB to the unpacked tarball (1.44 → 1.47 MB): splitting array elements adds
    a level of indentation. Declared size updated in all three READMEs.

- The four changes in the 0.8.0 batch — page-error relay, sticky events, reserved-name
  rejection and `html`/`page` validation — share one design criterion: **a legal action that puts the
  system into an unusable state must be observable by someone.** Two of them now stop at creation; two
  are exposed through the host log. The rationale, the measurements behind each, and the rejected
  alternatives are in `ADR 0020` (repository-local).

## [0.7.0] - 2026-10-25

### Added

- **`setFrameless()` switches the window form at runtime; `isFrameless()` reports the current one.** `FLAG_FRAMELESS` had been a creation-time flag since 0.3, so comparing a frameless window against a framed one meant restarting the process. That is a real cost for acceptance: the form check has three branches (`frameless` + restored, `frameless` + maximized, `framed`), one run only ever proves one of them — and a restart throws away the event ring, the zoom factor and the restored geometry, which are exactly the state that makes "is the geometry consistent across a switch" testable. Consumers can now also expose a title-bar toggle instead of shipping two builds.

    **The creation path and the behaviour predicates are now two variables.** `g_frameless` decides _which window creation path runs_ — our own `webview_shell` window (embedded `webview_create(1, hwnd)`, full `shell_wnd_proc`) versus the window the webview library creates (`toplevel_proc` subclassing only). That is fixed the moment `CreateWindowExW` / `webview_create` returns and cannot change. `g_frameless_live` decides _behaviour_: whether `WM_NCCALCSIZE` intercepts, whether resize borders and caption buttons take part in hit-testing, whether `fit_widget` reserves the title-bar strip, and what `push_state` reports as `frameless`. Five predicates moved to the live variable; the creation path stayed where it was.

    **Switching does not touch the style bits.** `create_own_window` already passes `WS_OVERLAPPEDWINDOW` — the caption, border and sizing frame are all there. Frameless is achieved by `WM_NCCALCSIZE` returning 0, which erases the non-client area; it is not achieved by removing style bits. So going back to framed takes two steps: let `WM_NCCALCSIZE` fall through, then `SetWindowPos(SWP_FRAMECHANGED)` to force the system to recompute. Assembling `WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX` by hand would give five chances to produce a window that cannot be dragged or has no system menu; `WM_NCCALCSIZE` just hands the system back the answer it would have computed anyway.

    **Three refusals, each with a concrete reason.** (1) No window yet. (2) Created framed — that window belongs to the webview library and we only subclass it, so `WM_NCCALCSIZE` is not ours to answer; switching that direction needs `shell_close` + a fresh `shell_start_ex`, a different route not taken here. (3) Currently fullscreen — `toggle_fullscreen` caches the pre-fullscreen style bits and rect, and changing form mid-flight makes the restore produce a window with one form's style bits and the other form's geometry. **Note the scope: only a frameless-created window can switch**, and framed is the default, so this is narrower than the name suggests. It is stated in the interface docs and in ADR 0019 rather than left to be discovered.

    The state push after a switch uses `PushMode::BypassAll`: `PushedState`'s change detection has no `frameless` bit, and the client area can come out the same size in both forms at some window sizes — the normal path would be absorbed as "nothing changed" and the page would never learn to mount or unmount its own title bar.

    Verified on a real window at 200% DPI (`scripts/probe-frameless-toggle.ts`, 10 assertions, all passing): frameless `win=1800x1200 client=1800x1200`; framed `client=1774x1129` — 26×50 physical pixels handed back, consistent with the `border=13x13` on the same line once you add the title bar; switching back restores the client area pixel for pixel. The load-bearing assertion is **"client area matches the initial reading after switching back"**, not "`win == client`" — the latter stays green if both sides shrink together.

### Note

- **A release sentinel now blocks a half-published release.** Releasing writes the same facts into six carriers — `package.json`'s `version`, `build-pack.ts`'s PE version, the CHANGELOG section, the CHANGELOG link definitions, the package size in all three READMEs, and the git state. Missing any one produces no compile error and no test failure; it produces a release where the tarball on npm describes itself wrongly, discovered only after the version number is permanently spent.

    `bun run scripts/release-sentinel.ts` turns "do the six agree" into a decidable question. One run, sixteen checks, exit 1 with a list of what to fix. It measures the tarball for real (`bun pm pack` → `tar -xzf` → sum the bytes) rather than trusting the number written in the docs, because that number changes on **every commit that adds, removes, or edits a shipped file** — including edits to the READMEs themselves.

    **It is deliberately not a fourth gate stage.** Every stage of `gate.ts` asserts "failure = the code is broken". Two of the sentinel's checks fail legitimately during normal development — a dirty working tree, and a CHANGELOG with no section for a version that has not been released yet. Putting that in a gate that runs on every commit only teaches people to reach for `--skip`, and a criterion that gets habitually skipped does not exist.

- **The static half of that contract now runs on every `bun test`.** `tests/readme-contract.test.ts` (31 assertions) covers what can be judged without packing or touching git: all ten `FLAG_*` and five `BROWSER_UI_*` bits mentioned in all three READMEs, all ten `exports` subpaths mentioned, the three files structurally isomorphic, no references to files outside the publish surface, and no self-version literals. The split between the two layers has exactly one criterion: **will this check fail legitimately during normal development?** If yes, sentinel only.

    Shared logic lives in `scripts/lib/readme-contract.ts` so the test and the sentinel cannot disagree — two implementations of the same predicate is the one failure mode where a person ends up bypassing whichever is stricter.

- **Six README defects fixed, then the checks that would have caught them were written.** The two worst:

    | Defect                                                              | Before                                                                                                                                                                                 | Now                                                                                        |
    | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
    | `FLAG_TITLEBAR_RESERVE` (256) / `FLAG_NATIVE_CAPTIONS` (512)        | **absent from the flag table entirely** — the latter is the only way Snap Layouts can trigger                                                                                          | documented, including why the first is superseded by the second                            |
    | All three READMEs                                                   | pointed readers at `AGENTS.md` for "shape A / shape B" — gitignored, not in `files`, so **unreachable for anyone who installed the package** from the day those sentences were written | rewritten self-contained                                                                   |
    | `ackOf()`, `titleBarCss()`, `detectIconSet()`, `captions: "native"` | never mentioned                                                                                                                                                                        | documented                                                                                 |
    | Default glyph set                                                   | "buttons default to geometric glyphs; setting `icons: \"fluent\"` switches to Segoe Fluent Icons" — **backwards since 0.6.1**                                                          | `detectIconSet()` picks `fluent` by default, `unicode` only as fallback                    |
    | `types` subpath constants                                           | `STATE_*` only                                                                                                                                                                         | three named constants plus the `CAPTION_*` trio, and why the caption order is load-bearing |
    | Tarball size                                                        | 1.37 MB unpacked                                                                                                                                                                       | 1.39 MB — measured, not estimated                                                          |

    The glyph row was the worst of the six: a reader following it would set `icons: "fluent"` to _get_ the Win 11 glyphs, when that had been the default since 0.6.1 — the documentation described the opposite of what the code did. Two `about 0.4 s` / `about two seconds` figures were removed rather than updated; they drift with the machine and the reader cannot verify them. Two first-person phrasings were also removed from the Chinese READMEs (`各替我省一次调用` → `各能省掉一次调用`).

    Then the checks above were written, and verified in both directions: four mutations were injected into the real documents — deleting a flag mention, adding a heading to one file, corrupting one file's size, adding an `AGENTS.md` reference — and each turned exactly the expected assertion red. All four were reverted and the suite returned green.

- **`dist/libshell.dll` changed** — `shell.cc` gained the two exports and the `g_frameless_live` predicates (`1,026,560 B`). The declared symbol count grew by two, tracked in `tests/native-surface.test.ts`. Three pre-existing static assertions in `tests/nav-guard.test.ts` were widened from `g_frameless` to `g_frameless(_live)?`; each carries a comment saying why the live variant satisfies the original intent. The caption-ordering assertion also moved its anchor off `WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET`, which appears in three other functions and was a substring trap waiting to misfire.

    Note the self-reference: editing the READMEs changes the tarball they describe. `1.39 MB` is the figure after these edits, measured by packing and unpacking; the digits were changed last, and since `1.38` and `1.39` are the same byte length the measurement stays put.

## [0.6.2] - 2026-10-23

### Fixed

- **`src/shell/index.ts` is a text file again — a stray `0x0D` byte had made git treat it as binary.** The comment above `Shell.restoreBounds()` carried `␍estorePlacement()`: the `r` was written as `0x0D` (CR) instead of `0x72`. One control byte was enough for git to sniff the whole file as `-text`, and `git ls-files --eol` skips binary entries outright — so the end-of-line check never covered this file, and the damage sat there unnoticed.

    The repair is a single byte at offset 8374 (`0x0D` → `0x72`). The file length is unchanged at 14,213 B and no other byte moved.

    It surfaced only once the EOL gate got stricter: it used to parse the `i/crlf` / `w/crlf` substrings out of `ls-files --eol`, and now classifies by raw file bytes — which sees `0x0D` wherever it appears, including inside a comment.

### Note

- **Nothing changes at runtime.** `dist/libshell.dll` is byte-identical to 0.6.1, no exported symbol, flag or type moved, and the packed file allow-list is unchanged. Upgrading only replaces the published source of `src/shell/index.ts`.
- Work landed in the same window but **outside** this package: three additions to `docs/pitfalls.md` (2.22 on screen-coordinate probes, 5.11 on redaction, 1.2 on z-order locking). `docs/` is not in the published file allow-list, so none of it ships.

## [0.6.1] - 2026-10-22

### Added

- **The caption buttons now draw Win 11's actual glyphs at Win 11's actual size, and the component has all five states instead of two.** The previous defaults were two independent misses that compounded.

    **The glyphs were wrong for the platform, not just "less pretty".** `TITLEBAR_GLYPHS.unicode` renders `─ □ ❐ ✕` — geometric symbols from whatever text font is loaded. Their ink fills about half the em box: measured on `baw-mvp` at @192dpi, `\u25A1` came out **10×9 physical** and `\u25B1` **16×2**, against Win 11's **20×20** and **20×2** (measured on the Settings app, same machine). The fix is not a bigger `font-size` — `10px` was already correct — it is the font. `TITLEBAR_GLYPHS.fluent` holds `E921` / `E922` / `E923` / `E8BB`, which `Segoe Fluent Icons` (Win 11) and `Segoe MDL2 Assets` (Win 10) draw at **the same code points**, so one table covers both systems.

    `fluent` was previously opt-in because a missing font renders private-use code points as tofu. `detectIconSet()` now checks `document.fonts` for either face and only falls back to `unicode` when neither is present; with no `FontFaceSource` to ask, it assumes `fluent`, since the component targets Windows. The result on `baw-mvp`: **20×20 / 20×20 / 20×2 physical**, identical to the system's own buttons, with horizontal centring at 0.0 px.

    **Two states became five.** Hover and pressed backplates move from `0.0605` / `0.0419` to **`0.102` / `0.200`** of the foreground colour — the old values were faint enough that hovering looked like nothing happened. `setActive()` dims the glyph to `0.447` when the window loses focus, and `setEnabled(action, enabled)` drops it to `0.361` and stops dispatching. All four numbers, and the close button's red, come from Windows' own implementation as cross-checked against `egoist/mygo`'s `internal/windows/titlebar.go` (`colors()`).

    **Focus dimming is expressed as a custom property, not a specificity fight.** `.ws-titlebar__btn` sets `color: var(--ws-tb-btn-fg)`, and `[data-active="false"]` on the root re-points that variable. Writing `color: var(--ws-tb-inactive)` straight onto the button would have lost to the `:hover` rule below it, and the fix for that would have been `:not()` chains or `!important` — the kind of thing that works until the next state arrives.

    `setEnabled` guards in **two** places on purpose: CSS `pointer-events: none` stops the mouse, but a keyboard user tabbing to the button and pressing Enter still reaches the click handler. The `aria-disabled` attribute is the single source both read.

    Verification: 38 assertions in `tests/titlebar.test.ts` (up from 25), including `detectIconSet` in all four combinations, the five-state CSS values asserted **inside their rule blocks**, and the disabled button not firing. Reverse-verified by restoring `--ws-tb-hover: 0.0605` — exactly one assertion went red, the rest stayed green.

    **Still manual:** whether the focus-dimmed glyph actually renders dimmer on screen. The check needs the window to lose foreground, and in this session `SetForegroundWindow` never took it away from the host chat window — both readings came back at full brightness, i.e. the window never left the active state, so the probe measured nothing. The logic is covered by unit tests and the CSS is a plain attribute selector, but the end-to-end path (native `focused` bit → `windowState` push → `setActive` → repaint) has not been observed.

- **Caption buttons on a frameless window now answer `HTMAXBUTTON`, so Windows 11 Snap Layouts works.** The only documented trigger is `WM_NCHITTEST` returning `HTMAXBUTTON` for the maximize/restore button (_Support snap layouts for desktop apps on Windows 11_). Previously `hit_test_client` returned only the eight resize codes and `HTCLIENT`, so hovering maximize never opened the layout picker — the last piece of "looks like a Win 11 app" that CSS cannot buy.

    Three constants became a single source of truth in `types.ts` — `CAPTION_BAR_HEIGHT` (32), `CAPTION_BUTTON_WIDTH` (46), `CAPTION_BUTTONS` (`close` / `maximize` / `minimize`, right to left). Two copies follow it: `kCaptionBarHeight` / `kCaptionButtonWidth` plus the `caption_button_at()` order in `native/shell.cc` (C++ cannot import TS), and the `32px` / `46px` in `titlebar.css`.

    **Order matters more than the numbers.** If the hit-test order and the DOM order disagree, clicking "close" maximizes the window — and the buttons look identical, so nothing about the symptom points at a constant.

    **`HTMAXBUTTON` cannot ship alone.** Once `WM_NCHITTEST` answers that code, the point is non-client: a press delivers `WM_NCLBUTTONDOWN` instead of `WM_LBUTTONDOWN`, so the page receives no pointer or click event at all. Changing only the hit test turns the button into a black hole that eats clicks — the symptom reads as "clicking maximize does nothing", which is exactly backwards from the intent. `shell_wnd_proc` therefore handles `WM_NCLBUTTONDOWN` for the three button codes and performs the action itself; every other code still falls through to `DefWindowProc` so caption dragging and edge resizing keep working.

    The caption check is deliberately placed **before** the resize-border check and is **not** gated on `g_resizable` / `IsZoomed`. The old guard opened with `!g_frameless || !g_resizable || IsZoomed(hwnd) → HTCLIENT`; reusing it would make the maximize button unhittable precisely when the window is maximized — which is when the user needs it to restore.

    Measured with a one-off FFI probe against `dist/libshell.dll` and `user32.dll` (7/7):

    ```text
    A. scan from the right edge (physical px, 200% scale)
      x=1799 → HTCLOSE
      x=1708 → HTMAXBUTTON
      x=1616 → HTMINBUTTON
      x=1524 → HTTOP          ← inside the resize border
      button width 91/92, expected 92 (= CSS 46px × scale)

    B. WM_NCLBUTTONDOWN
      HTMAXBUTTON → maximized   state=1
      again       → restored    state=0
      HTMINBUTTON → minimized   state=2, win=314x50 (sentinel — really minimized)
    ```

    **Still manual**: whether the Snap flyout actually _appears_ on hover. It is a DWM-owned popup, so `PrintWindow` cannot capture it and no readout exposes it. Automating the hover was attempted and blocked — the Windows MCP refused the cursor move (`USER_CONTROL`, `state: user`), and `SetCursorPos` landed 216 px away, i.e. the pointer was in use. What is verified is the precondition the documentation names; what is not verified is the flyout itself.

    One measurement worth keeping: the outer 13 physical pixels of the window are the resize border, so the title bar's top ~6.5 logical pixels answer `HTTOP` rather than the button code. Caption buttons win where they overlap (they are checked first), but a probe that samples `y=1` will read `HTTOP` and should not be read as "the button is missing".

### Fixed

- **The caption buttons sat 18 CSS px left of where they belong, and the title bar was squeezed to a third of its height — because a consumer's `header { … }` rule leaked into the component.** The component mounts on `<header class="ws-titlebar">`, and `baw-mvp`'s page has an element-selector rule for its own page header: `header { padding: 12px 18px 10px; gap: 12px }`. `.ws-titlebar` never declared `padding`, so the 18px right padding pushed all three buttons left by 18 CSS px (measured: 36 physical px @192dpi), and under `box-sizing: border-box` the 12/10 vertical padding squeezed the 32px bar down to 9px of content, shrinking the buttons to 18 physical px tall.

    **It reads as "the glyph is not centred", and that diagnosis is wrong.** Measuring the hover backplate — `background` covers the whole button, so its edges _are_ the button's edges — put the backplate at 92 physical px wide with the glyph's centre and the backplate's centre both at `d=137.5`: the glyph was centred all along. The whole group was displaced, then squashed.

    **Specificity is not the mechanism.** An element selector (`0,0,1`) does lose to a class selector (`0,1,0`) — but only where the component _declares_ the property. An undeclared property does not compete at all, so it is handed to the consumer. The mounting tag is part of the public contract, and `<header>` / `<button>` / `<div>` are exactly the tags consumers write global rules for.

    The fix declares `margin` / `padding` / `gap` on `.ws-titlebar` and `margin` on `.ws-titlebar__btn`. The consumer sides changes too: `header { … }` becomes `.app-header { … }`, and `button { … }` becomes `button:not(.ws-titlebar__btn)` — the latter also stops `button:active { transform: translateY(1px) }` from reaching the caption buttons, which had been sinking the glyph 1px on press where Win 11 only swaps the backplate.

    Three assertions guard it in `tests/titlebar.test.ts`, and they must be made **inside the rule block** (`cssBlock(css, ".ws-titlebar")` before `toContain("padding: 0")`). Writing `expect(css).toContain("padding: 0")` would be satisfied by the identically-valued declaration already in `.ws-titlebar__btn` — the guard would silently become a tautology, and this stylesheet happens to contain exactly that coincidence.

    Verified by reverse: dropping `padding: 0` from `.ws-titlebar` turned **exactly one** assertion red and left the other 24 green; restoring it gave 25/25. On a real window the centring offsets went from `-35.5 / -36.0 / -36.0` to `0.5 / 0.0 / 0.0` physical px, and the close button now ends flush with the client area's right edge.

- **`getBounds()` returned the Win32 minimised sentinel rectangle, and `attachPlacementStore` wrote it straight to disk.** `format_bounds()` only took `WINDOWPLACEMENT.rcNormalPosition` when `IsZoomed()` was true. A minimised window is not zoomed, so it fell through to `GetWindowRect()` — which for a minimised window reports `-32000,-32000` plus an icon-sized box (measured: `314x50`). `IsIconic()` was never consulted.

    Those values look entirely valid: integer coordinates, positive dimensions. The existing shape checks (finite numbers, size > 0) cannot distinguish them from a real rectangle. So `window.json` became `{"x":-32000,"y":-32000,"width":314,"height":50,"dpi":192}`, and the next launch restored a 314×50 window — observed on `baw-mvp` as a 666×471 window with the page wrapped and scrolling.

    Fixed at two layers:

    - **Native.** The condition is now "minimised **or** maximised" instead of "maximised", and `IsIconic()` is explicit. The `maximized` bit comes from `WPF_RESTORETOMAXIMIZED` while minimised, because `IsZoomed()` is always false there — without it, "maximise → minimise → close" silently dropped the maximised state.
    - **`state.ts`.** `parseBounds()` and `parsePlacement()` reject any coordinate at or below `-30000`. The first stops new bad values being recorded; the second invalidates files already written by earlier versions, so upgrading repairs the existing bad state rather than only preventing new ones. The threshold is a range, not an exact `-32000`, because the sentinel carries a few pixels of offset depending on DPI and theme. It cannot collide with real coordinates: an 8K display is 7680 wide, and even a long multi-monitor row stays far below 30000.

    Three tests added, and verified by removing the guard — exactly those three go red, including the `-31996` offset variant. The companion cases that must keep passing are pinned too: a legitimate negative `x` (secondary monitor to the left) still parses.

    Verified on a real window with a one-off FFI probe against `dist/libshell.dll` (bypassing every TS wrapper):

    ```text
    normal              → 147,147,1826,1271,0,192
    minimised           → 147,147,1826,1271,0,192   ← no sentinel, restore rect
    maximised           → 147,147,1826,1271,1,192
    maximised → minimise → 147,147,1826,1271,1,192   ← maxed bit preserved
    ```

- **The caption buttons are now drawn and hit-tested by the shell on its own layered child window, so a consumer can stop faking them with DOM.** `FLAG_NATIVE_CAPTIONS` (512) creates a `WS_EX_LAYERED | WS_CHILD` window named `webview_shell_caption`, anchored to the client area's top-right corner at exactly `3 × CAPTION_BUTTON_WIDTH` by `CAPTION_BAR_HEIGHT` in logical pixels (`276×64` physical at @192dpi). It answers `WM_NCHITTEST` itself with `HTCLOSE` / `HTMAXBUTTON` / `HTMINBUTTON`; the title strip and the client area still report `Chrome_RenderWidgetHostHWND`, so the page keeps receiving mouse input. `mountTitleBar({ captions: "native" })` skips creating the three buttons and only reserves their footprint.

    It supersedes `FLAG_TITLEBAR_RESERVE` for consumers that draw their own title bar. `baw-mvp` now runs `flags = 573`; the DLL grows to `1,025,536 B` with its 34 exports unchanged, and `gdi32` joins the subsystem library list (ten now).

    Three details it depends on, each pinned by an assertion in `tests/nav-guard.test.ts`:

    - **`UpdateLayeredWindow` must be given an explicit `SIZE`.** Passing `nullptr` returns `true`, sets no error, and leaves the surface `0×0` — the window then exists, is visible, sits at the top of the child chain, has a correct rectangle, and is hit-transparent anyway. The window under it receives every click. See `docs/pitfalls.md` 2.21 for the A/B and for why the documented "the size does not change" does not cover "never was set".
    - **The rest fill is `alpha = 1`, not 0.** A fully transparent layered window is hit-transparent: measured 0/3 hits at `alpha = 0`, 3/3 for every value from 1 to 255. Rest state is invisible at 1/255 either way, so the value exists only to keep the window hittable.
    - **`WM_NCMOUSEMOVE` breaks to `DefWindowProcW` instead of returning 0.** That is where the Snap hover detection happens; short-circuiting it costs the layout picker while leaving the window looking completely normal.

    Clicks go through `WM_SYSCOMMAND` from the shell process, and only fire when released over the same button. Once `WM_NCHITTEST` answers `HTMAXBUTTON` the point is non-client — the press arrives as `WM_NCLBUTTONDOWN`, not `WM_LBUTTONDOWN` — so the page never sees a `click` and the shell has to perform the action itself. This is also why the three buttons are children of the shell rather than elements of the page: a DOM button cannot return a non-client hit code.

    Measured on `baw-mvp` at @192dpi maximised: `WindowFromPoint` lands on `webview_shell_caption` 3/3, the three hit codes are exact, glyph boxes are `20×20 / 20×20 / 20×2` physical (`10×10 / 10×10 / 10×1` logical) with `0.0` centring offsets, and the hover backplate moves `32.0 → 55.1` (`+23.1`, against `+22.7` expected). Gate: `72 files`, `603 pass / 0 fail`, `VERIFY-PACK PASSED (7 checks)`.

    **Snap Layouts was confirmed by a real mouse, and that is the interesting part.** Four automated probes reported zero new top-level windows while hovering and were read as "a child window cannot trigger Snap" — which was wrong. The flyout is a DWM-owned popup, so window enumeration never sees it and the probe could not have reported anything else. The rule this leaves behind (`docs/pitfalls.md` 2.21, fourth section): a guard that reports `0` must first prove it is not blind, by reporting non-zero on a sample known to be true.

## [0.6.0] - 2026-10-21

**`beginResize` now takes `RESIZE_EDGE` values (10–17) instead of raw native indices, and five sources of consumer boilerplate are gone. The first is a behaviour change; the rest are additive.**

### Added

- **`bun-app-window/types` — a zero-dependency subpath, safe to bundle for the browser.** `src/shell/types.ts` was already import-free, but there was no way to reach it: the main entry pulls in `./native`, which imports `bun:ffi`, and a browser bundle cannot resolve that (`pitfalls` 5.14). So consumers hand-copied constants — `BROWSER_UI_*` (5 bits), `ZOOM_LADDER` (14 steps), the 8 edge indices — with no gate able to notice when a copy drifted from the source.

    The subpath's entire value rests on one invariant: **`types.ts` must stay import-free**. Adding a single `import` silently makes it browser-unsafe, and the symptom is a `Could not resolve "bun:ffi"` several layers away from the cause. `tests/types-purity.test.ts` pins it with a static assertion (comments stripped first — the file's own prose mentions `import` while explaining why it cannot be used), plus a self-check that the predicate can actually fail.

- **`ZOOM_LADDER` / `ZOOM_MIN` / `ZOOM_MAX`.** The ladder previously existed only as `kZoomLadder[]` in `native/shell.cc`. `apply_zoom` clamps to the ends without snapping to intermediate steps, so this table is for UIs that want to walk it — which meant every UI kept its own copy of fourteen numbers.

- **`RESIZE_INDEX` and `resizeIndex(edge)`.** The HT* → native-index map, needed by anything calling `shell.symbols.shell_begin_resize()` directly. Exported because hand-writing it is guaranteed to be wrong: it is not `value - 10` (see Fixed).

- **`NativeLibInfo.version`.** `resolve.ts` reads it from the packaged `package.json`. Consumers used to need `import libPkg from "bun-app-window/package.json"` just to display which version they were talking to.

- **`ackOf(shell, rc)`** on the main entry. Turns a bare `rc` into `{ rc, err }`, and centralises the rule that `lastError()` is only read on failure — the error buffer is not cleared by a successful call, so reading it after one returns the previous fault and displays as a phantom.

- **`App.debug`** — equivalent to `debugOf(app.shell)`, saving a call and a subpath import. The stability promise is unchanged: diagnostics may change at any time and production code should not depend on them.

- **`App.attachPlacement(file, opts?)`** — wires placement persistence to the skeleton's single event pump. Calling `attachPlacementStore(shell, file)` without `{ events }` makes it start a **second** pump, and `shell.pollEvents()` is consumptive: the two pumps each get part of the stream, window position is dropped at random, and neither side reports anything. This was the library's easiest way to fail silently, so the choice was removed rather than documented harder.

- **`bun-app-window/pack`** — the page-script bundler, so consumers stop writing it. `bundlePage({ entry })` returns `{ code, bytes }`; `writePageBundle({ entry, out })` also writes and re-checks the on-disk size. Three things are fixed rather than configurable: `target: "browser"` and `format: "esm"` (that is what a page script _is_), and reporting **bytes** instead of `string.length` — the latter is UTF-16 code units, which on a source containing CJK drifts from the byte count by a wide margin while the unit is printed as `B`. Measured on a consumer: reported `35,085 B`, on-disk `37,319 B`.

    Failure handling covers both shapes `Bun.build` produces, which was not obvious: compile-time diagnostics come back as `{ success: false, logs }`, but an **unreachable entry point throws an `AggregateError`** whose `message` is only `Bundle failed` and whose members live on `.errors` — `.logs` does not exist on that path. Without the second branch, the most common mistake (a wrong entry path) produced a message with no information in it.

- **`AppOptions.page`** — pass the packed page script and `createApp` serves it at `PAGE_JS_PATH` (`/page.js`) with `content-type: text/javascript; charset=utf-8`. This removes the ten-line `routes` callback from every consumer and, more importantly, removes the way it goes wrong: a wrong or missing MIME type makes `<script type="module">` refuse to execute with no syntax error, which reads as "the page logic is broken". A caller's `routes` still wins, so the path stays overridable.

### Changed

- **BREAKING: `Shell.beginResize(edge)` takes `RESIZE_EDGE` values (10–17).** Migrating from 0.5.x:

    | You were passing                    | Before                 | Now     |
    | ----------------------------------- | ---------------------- | ------- |
    | `RESIZE_EDGE.LEFT` (10) and friends | `rc=-1`, nothing moved | works   |
    | raw indices 0–7                     | worked                 | `rc=-1` |

    If you were passing raw indices, replace them with the matching `RESIZE_EDGE` member — `RESIZE_INDEX` is exported if you need to see the mapping.

- `tests/gate.test.ts` shrank with the stage: `parsePs1Summary` and the `.ps1`-failure short-circuit assertions are gone, and `planStages` now asserts three stages.
- **A new assertion keeps the deletion honest.** `tests/gate.test.ts` now fails if a `.ps1` appears anywhere in the repository. Deleting a stage and leaving nothing behind would mean the next `.ps1` arrives ungoverned and looks exactly like "the migration is complete". Verified in both directions: creating `scripts/__probe.ps1` turns it red naming that path, removing it returns green.
- `docs/pitfalls.md` 3.18 keeps all five traps and is re-headed as _retired_ rather than _paused_ — the values and consequences were measured, so the record outlives the script. 5.2 and 5.6 no longer describe a `.ps1` that might come back.
- Two ghost instructions surfaced while deleting: `scripts/trust-cert.ts` told the user to run `scripts/test-sign.ts`, a path that never existed, and `native/build-pack.ts` told them to run `scripts/make-icon.ps1`, which was migrated to TypeScript long ago. Both now point at something that exists.

### Fixed

- **`RESIZE_EDGE` and `shell_begin_resize()` were never the same numbering** (`pitfalls` 5.13). `RESIZE_EDGE` is the Win32 `HT*` constants (10–17); the native side reads `codes[edge]` as an **array index 0–7** over `{HTLEFT, HTRIGHT, HTTOP, HTBOTTOM, HTTOPLEFT, HTTOPRIGHT, HTBOTTOMLEFT, HTBOTTOMRIGHT}`. The mapping is therefore not an offset — `HTTOPLEFT` (13) lands at index 4 while `HTBOTTOM` (15) lands at 3. `beginResize` used to pass its argument straight through, so following the documentation produced `rc=-1` and a window that did not resize, while the gate stayed green.

    Fixed in TypeScript, so **the DLL does not need rebuilding**. Three assertions now hold the mapping down, the important one being that it is _not_ `value - 10`: subtracting ten happens to be correct for the first three entries (LEFT/RIGHT/TOP → 0/1/2) and wrong from the fourth on, which is exactly how a partial assertion would have given false confidence.

### Removed

**The last two PowerShell scripts are deleted rather than migrated, and the gate's `.ps1` stage went with them.**

- **`scripts/test-sign.ps1` and `scripts/verify-sign-crypto.ps1` are gone — 195 lines that will not be replaced.** The standing decision (`ADR 0014`) was "these two stay PowerShell forever". Both premises failed in the same direction, so the third outcome applies: the capability itself is no longer wanted.

    - `verify-sign-crypto` was ported far enough to prove the port feasible: five constant/structure traps were each resolved against a real sample (`pitfalls` 3.18 has all five, including `CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED` being `0x100` and `CMSG_VERIFY_SIGNER_NULL` being `4`). It stopped at the last step — `CryptMsgControl` wants the signer's certificate context, the message does not embed one, and reconstructing a `PCCERT_CONTEXT` from the store never resolved. That path buys exactly one thing: the three facts in `pitfalls` 4.7 (valid maths is not trust; a tampered file keeps a `VALID` PKCS#7; `HashMismatch` is the only reliable verdict) could be asserted in `bun test`. They are already written down, and re-pinning them changes no behaviour.
    - `test-sign` needs `SignerSign` / `SignerSignEx2` from `mssign32.dll`, which Microsoft documents nowhere. A `bun:ffi` declaration is validated by writing it from the documentation against a minimal input — there is no documentation to write it from.
    - Neither was in the release flow: `AGENTS.md` §7.4 records that no commercial code-signing certificate is connected yet. When one is, the tool is `signtool`, not a hand-rolled verifier.

- **The gate's second stage (`.ps1` syntax check) is deleted.** It existed as a migration-period fence for scripts that had neither type checking nor tests. With zero `.ps1` left it scans nothing, and a stage that can only ever report green is dead weight. Stages are now `bun check` → `bun test` → consumer acceptance: 1.3 s versus 1.8 s for four, and **the gate no longer needs `pwsh`** — only `bun` and `git`.

- **The shell's capture remnants are gone (`ADR 0017`).** `native/gdi.ts` lost 142 of its 380 lines: `captureWindow`, `cropBgra`, `parseCrop`, `nonBlackPercent`, and the `GetDIBits` dlopen block that served only them. No caller remained inside the repository — the one test that referenced `cropBgra` was asserting against a function nothing used. Window capture lives in `echoes-of-the-eye` (formerly `agent-eyes`, renamed in the same window); the shell keeps only the icon-extraction closure that `scripts/extract-icon.ts` needs to prove `--windows-icon` works. **Repository-only**: `native/` is not published, so nothing changes for package consumers.

## [0.5.1] - 2026-10-21

**0.5.0's drag-and-drop fix was wrong and made dropped files be refused outright. This release replaces it, and adds folder support. The public API is unchanged.**

### Fixed

- **Dropped files and folders are accepted again, and the page receives absolute paths.** 0.5.0 set `ICoreWebView2Controller4::put_AllowExternalDrop(FALSE)` on the belief that it stepped aside from WebView2's internal `IDropTarget` and let the OLE chain fall through to the parent window's `DragAcceptFiles` handler. **Both halves of that reasoning were wrong**:

    1. `DragAcceptFiles` only sets `WS_EX_ACCEPTFILES`; it does **not** register an `IDropTarget`. Reading the `OleDropTargetInterface` window property across the whole chain (`webview` → `webview_widget` → `Chrome_WidgetWin_0` → `Chrome_WidgetWin_1` → `Chrome_RenderWidgetHostHWND` → `Intermediate D3D Window`) returns false for every window. Modern Windows does not fall back to that legacy path during OLE hit-testing.
    2. `AllowExternalDrop` means _allow external drop_. `FALSE` refuses drops; it does not forward them.

    The user-visible symptom was a red "not allowed" cursor over the window on every drag, with no drop and no `WM_DROPFILES`.

    The fix uses the upstream API built for this case. With `FLAG_ACCEPT_DROP` on, the shell injects a script into the page that forwards the dropped objects to the host; the host reads them back with `ICoreWebView2WebMessageReceivedEventArgs2::get_AdditionalObjects` and converts each to an absolute path. **Pages still need no code of their own** — the listener is injected, like `window.__shell.recv`. On a runtime without `EventArgs2` the `QueryInterface` fails and every other web message keeps working.

    The `WM_DROPFILES` path (`handle_drop`) stays as a fallback and keeps its own probe. Both paths emit the same shape.

### Added

- **Folders now work, and `dirs` tells them apart.** A dropped folder arrives as a `FileSystemDirectoryHandle`, but on the host side that handle does **not** survive — measured: the collection holds one entry, `QueryInterface` to both `ICoreWebView2File` and `ICoreWebView2FileSystemHandle` fails, and the item is simply unusable. What _does_ work is that a folder also appears in `dataTransfer.files` as an ordinary `File`, whose `get_Path` returns the correct path.

    So the injected script posts **handles and files together**, the host tries `ICoreWebView2File` first and the handle second, and duplicate paths are collapsed. Because the surviving object is a `File`, `get_Kind` is unavailable — "is this a folder" is decided by `GetFileAttributesW` + `FILE_ATTRIBUTE_DIRECTORY`, the same predicate the `WM_DROPFILES` fallback uses, which is why both paths produce identical output:

    ```json
    { "t": "drop", "paths": ["<every path>"], "dirs": ["<the subset that are folders>"] }
    ```

    `paths` keeps every entry in order; `dirs` is a subset and is always present (possibly empty).

- **The host now always answers.** Previously, when `AdditionalObjects` yielded no usable path, the handler returned silently — the page waited, the host said nothing, and neither side had a clue. Every drop now produces exactly one `shell-msg`, carrying `ok`, `err`, and the counts `nFile` / `nHandle` / `nNoPath` that made this diagnosis possible in the first place.

- **`scripts/probe-drop-live.ts`** — an interactive probe for the half that cannot be synthesised. `AdditionalObjects` only ever contains objects produced by a real drag; page JavaScript cannot fabricate one with a path, and `keybd_event` cannot hold a mouse button across processes. The probe opens a window, waits for one manual drop, and does the judging automatically: the page reports the received payload back over `fetch`, and the probe asserts paths are non-empty, absolute, existing, and classified exactly as the filesystem says. Twelve checks; a failure names _which_ of the five gates closed.

    `--file` and `--dir` are mutually exclusive — one target per run, because a run that asks for both will always fail the one you did not drag. It must run **non-elevated**; the file comment says why and how.

### Note

- **This release went through five rounds of "nothing happens".** Each was a genuinely different cause with an identical symptom, and only the last two were in code this release changed. They are recorded as `docs/pitfalls.md` 2.16 and 2.17, and the injected script now carries a marker for each so the next failure names its own stage:

    | Round | Cause                                                                                                                                                      | What made it visible                           |
    | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
    | 1     | The host ran elevated (High integrity) while Explorer runs at Medium; UIPI refuses the drag before any message is sent                                     | Not a single `dragenter`                       |
    | 2     | `preventDefault()` alone does not accept a drop — `dataTransfer.dropEffect` stayed `none`                                                                  | `dragover=72` with `drop=0`                    |
    | 3     | `chrome.webview.postMessage` is _not_ the pair of `get_AdditionalObjects`; `File` serialises to `{}`, so the collection was empty while the call succeeded | `drop=1 files=1`, `count=0`                    |
    | 4     | The probe reported its own post as failed — it fetched the marker 250 ms later, after the host had already closed the window                               | the only red check in an otherwise green run   |
    | 5     | A folder's `FileSystemHandle` does not survive the bridge; only the `File` in `dataTransfer.files` carries a path                                          | `nHandle=0` while the collection was non-empty |

    Rounds 3 and 5 are the same lesson twice: **a call that does not throw is not a call that worked.** `__shellDropReady` / `__shellDropPosted` / `__shellDropVia` / `__shellDropError` now exist so "did the injection run", "which route was posted", "was the drop delivered" and "did the host receive a usable object" are four separate observations instead of one silent guess.

### Documentation

- `docs/pitfalls.md` gains 2.15 (`AllowExternalDrop(FALSE)` refuses drops), 2.16 (the four gates, with the measured reading at each) and 2.17 (folder handles do not survive); 2.14 now points forward at them instead of recommending the wrong fix.
- `AGENTS.md` replaces the "step aside from WebView2's `IDropTarget`" rule with the `AdditionalObjects` route, states the file/folder asymmetry and the always-answer rule, and registers the new probe.
- Three READMEs state that files **and folders** arrive with absolute paths, show how to tell them apart with `dirs`, and confirm the page needs no `drop` handler of its own.
- `tests/capabilities.test.ts` pins all four gates plus the folder route statically, including that `chrome.webview.postMessage(` must not reappear.

### Verification

| Command                             | Result                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `bun check`                         | 69 files                                                                          |
| `bun test`                          | 558 pass / 0 fail                                                                 |
| `bun run scripts/gate.ts`           | PASSED                                                                            |
| `bun run scripts/verify-dll.ts`     | PASSED, same source as `native/shell.cc` (1,016,832 B)                            |
| `scripts/probe-window-events.ts`    | PASSED (21 checks)                                                                |
| `scripts/probe-accelerator-keys.ts` | PASSED (6 checks)                                                                 |
| `scripts/probe-drop.ts`             | PASSED (6 checks)                                                                 |
| `scripts/probe-drop-live.ts --file` | **PASSED (12 checks)** — one real file drag, absolute path                        |
| `scripts/probe-drop-live.ts --dir`  | **PASSED (12 checks)** — one real folder drag, path **and** folder classification |

## [0.5.0] - 2026-10-21

**Upgrading is enough for the first two items — no code changes on your side.** The third changes how you build a single-file executable, and it fixes something that never worked.

### Fixed

- **Keyboard shortcuts work again.** `F11`, `F12`, `F5`, `Ctrl+R`, `Ctrl+0` and `Ctrl±` were all dead, while `Ctrl+wheel` zoom kept working. The cause was message routing, not the handling logic: `WM_KEYDOWN` is delivered to the **focused** window, and focus sits on WebView2's render child window (`Chrome_RenderWidgetHostHWND`), which does not forward unhandled keys to its parent. Every `handle_input_message` call site on the two window procedures was unreachable by real keystrokes. `Ctrl+wheel` survived only because `WM_MOUSEWHEEL` _is_ forwarded to the parent by the focused window's `DefWindowProc`.

    The bug is easy to misdiagnose, because `PostMessage(hwnd, WM_KEYDOWN, VK_F11, 0)` toggles fullscreen correctly — that experiment simply bypasses what broke.

    The shell now subscribes to `ICoreWebView2Controller::add_AcceleratorKeyPressed`, which fires before the key reaches the page and does not depend on the focus chain. Key semantics live in one place (`handle_accelerator_key`), shared by the callback and the surviving `WM_KEYDOWN` path; only `KEY_DOWN` / `SYSTEM_KEY_DOWN` are handled (handling `KEY_UP` would toggle twice and look like "nothing installed"), and handled keys call `put_Handled(TRUE)`.

- **`FLAG_ACCEPT_DROP` now delivers full paths.** With the flag on, pages received a DOM `drop` carrying only `name` and `size`; the promised `shell-msg { t: "drop", paths: [...] }` never arrived. `DragAcceptFiles` only sets `WS_EX_ACCEPTFILES` on the **top-level** window, but OLE hit-testing walks to the deepest window under the cursor (`webview_widget` → `Chrome_WidgetWin_1` → `Chrome_RenderWidgetHostHWND` → `Intermediate D3D Window`, all measured `ACCEPTFILES=False`). WebView2 registers its own `IDropTarget` on the render child, takes the drop, and turns it into a DOM event — the top-level default drop target never sees it. The three `ChangeWindowMessageFilterEx` calls only allow messages _in_; they do not decide where a message _goes_.

    The fix is upstream: `ICoreWebView2Controller4::put_AllowExternalDrop(FALSE)` steps aside from that internal target, so the OLE chain continues to the parent and `WM_DROPFILES` reaches `handle_drop`. No hand-written `IDropTarget` — that would fight WebView2's internals, and the layering can change between releases (which is exactly how this was hit). On an older runtime the `QueryInterface` fails and the shell keeps WebView2's default behaviour rather than blocking startup.

- **Closing the window no longer keeps the process alive for five more seconds.** `App.stop()` used `Promise.race([closed.promise, Bun.sleep(CLOSE_TIMEOUT_MS)])`. A race takes the first settled promise and **does not cancel the loser**, so on the normal path the 5-second `Bun.sleep` became an un-awaited, un-unref'd timer that held Bun's event loop open. Measured: `race returned @ 9 ms`, process exit `@ 5010 ms`; a real window close took 5043 ms. Now a cancellable `setTimeout` with `finally { clearTimeout(timer) }`, and no `AbortSignal` on `Bun.sleep` (unsupported).

    One measurement note worth keeping: the criterion has to be **when the process exits**, not how long `stop()` takes. With `clearTimeout` removed, `stop()` still returned in 42 ms while the process took 5.9 s to exit.

- **The single-file executable actually embeds the native library.** `libInfo.source === "embedded"` was the documented acceptance criterion for shape B, and it had never been achievable: `src/host.ts` did not import `bun-app-window/embedded`, so the bundler recorded no `type: "file"` dependency, `resolveNativeLib` could not find embedded bytes, and the only surviving fallback was "put `libshell.dll` next to the exe" — which reports `source: "package"`, not `embedded`. Builds succeeded and the window came up, so nobody looked further.

    Adding the side-effect import fixes it. Measured in an empty directory with only the `.exe`, after deleting `%LOCALAPPDATA%\BunAppWindow\runtime\`:

    ```text
    ExitCode 0
    [lib] source=embedded path=...\BunAppWindow\runtime\libshell-15ef6452e3fcc26f.dll
    ```

    A second run reports `source=embedded` again and leaves the extracted file's mtime untouched (`reused === true`). The bundle grew from 96,158,208 to 97,165,824 bytes — the difference is exactly `dist/libshell.dll`. This is also the first time `ADR 0003`'s self-managed extraction had been exercised by a real executable.

### Changed

- **WebView2 C/C++ SDK upgraded from `1.0.1150.38` to `1.0.4258.31`.** `AllowExternalDrop` needs SDK `1.0.1185.39` or newer and did not exist in the previous vendored copy, which is why the drag-and-drop fix above was impossible before. `AdditionalObjects` and `ICoreWebView2File` arrived with it; they are not used, because they are reachable only through `postMessage`, and this shell keeps page communication on WebSocket. The old nupkg is removed and the new one is committed, so offline rebuilds behave exactly as before.

    `CORE_WEBVIEW_TARGET_PRODUCT_VERSION` moves from `99.0.1150.38` to `154.0.4258.31`. This project requires Bun ≥ 1.4.4, TypeScript ≥ 7.0.2, Windows x64 and a working WebView2 Runtime, and **does not aim for compatibility with older runtimes** — that is a decision, not an oversight.

- **`timeoutMs: 0` is now documented and guarded.** `pickFolder()` blocks the host thread for however long a person browses, so `connect({ timeoutMs: 0 })` is required when exposing it over IPC — otherwise the client rejects after 30 seconds while the host is still working, and a missing `.catch` makes that entirely silent. Both halves are now in the docs, and two assertions keep the contract: one behavioural (`timeoutMs: 0` still pending after 50 ms) and one static (no `||` fallback, which would turn `0` back into `30000`).

    Worth knowing beyond the timeout: `pickFolder()` blocks the **Bun main thread**, so timers in that process do not fire and other IPC calls queue up while the dialog is open. Lowering the timeout surfaces the symptom earlier; it does not fix the blocking. Real concurrency means running it in a Worker.

### Documentation

- `docs/pitfalls.md` gains 2.13 (shortcuts: `WM_KEYDOWN` goes to the focused window) and 2.14 (drag and drop: the deepest window wins the OLE hit test), plus 4.9 for the `embedded` criterion that nothing satisfied. Each records the double-sided verification, including the probe mistakes made along the way — a probe that called `SetFocus` on the top-level window measured the old code path and reported success with the fix removed.
- `AGENTS.md` records both routing mechanisms as implementation rules and replaces the open question about minimum runtime with the compatibility decision above.
- Three READMEs gain the `timeoutMs` section and cross-reference it from the `pickFolder` row.

### Verification

| Command                             | Result                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `bun check`                         | 68 files                                              |
| `bun test`                          | 556 pass / 0 fail                                     |
| `bun run scripts/gate.ts`           | 4 stages, PASSED                                      |
| `bun run scripts/gate.ts --clean`   | PASSED (clean)                                        |
| `bun run scripts/verify-dll.ts`     | PASSED, `dist/libshell.dll` matches `native/shell.cc` |
| `scripts/probe-window-events.ts`    | 21 checks                                             |
| `scripts/probe-accelerator-keys.ts` | 6 checks                                              |
| `scripts/probe-drop.ts`             | 6 checks                                              |
| shape B in an empty directory       | exit 0, `source=embedded`, `reused=true`              |

Each of the two new probes was verified in both directions: removing `install_accelerator_handler()` makes a real `F11` do nothing (1826 px → 1826 px), and removing `handle_drop(...)` leaves the `HDROP` handle alive. With the fix in place both pass.

### Still manual

Dragging a real file into a window to confirm the page sees the **full path**. A synthetic `HDROP` proves the message reaches `handle_drop`; it cannot prove that OLE hit-testing now resolves to the parent window, because that requires an actual cross-process drag.

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

    **Capacity 128, drop the oldest.** A one-second drag at a 16 ms cadence is about 60 events, so 128 is a two-fold margin. Dropping the _newest_ instead would freeze the ring at a stale state and the host would see "the window never changed" — far worse than losing history. Losses are reported as gaps in `seq` rather than synthesised into an overflow event: the gap carries the exact count, and no new `seq` special case is needed.

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

- This is **not** a competitor to `Bun.WebView`, and the READMEs now say so explicitly. `Bun.WebView` is a _headless_ browser for automation, testing and scraping: it has no window, and it can only screenshot its own page. This package draws a real desktop window — system title bar, DPI awareness, snap layouts, taskbar identity — and its capture tool can photograph **any** window, which is the whole point for computer-use. Comparing API surface between the two is comparing different problems.

## [0.3.0] - 2026-10-21

### Fixed

- **A page link could navigate the app away, permanently.** In a desktop shell there is no address bar, no back button, and no host API that can navigate the page back — so one mis-click on an ordinary `<a href="https://example.com">` replaced the application with that website, and the only recovery was to close and relaunch. The native layer could not stop it either: `NavigationStarting` was never subscribed, `NewWindowRequested` was never subscribed, and `g_origin` was never assigned.

    This is worth describing precisely, because the failure was not a wrong decision — it was **241 lines of correct-looking code that had never been compiled**. `NavigationGuard`, `NewWindowGuard`, `open_external()`, `install_nav_guard()` and `uninstall_nav_guard()` were all present and heavily commented, but: `install_nav_guard()` had **no call site anywhere in the tree**; `SHELL_FLAG_ALLOW_EXTERNAL_NAV = 128` was declared in the C++ enum with **no parsing site**, and the TypeScript side had no corresponding constant at all, so a caller could not even express the intent; and `g_origin` carried a comment saying it was "computed by `shell_start_ex` from `g_url`" while never being assigned — which alone would have made `install_nav_guard()`'s first guard clause return early forever. Type checking, 532 test cases and the full gate were green throughout. The first `bun run build:native` produced six compile errors and settled it: `NavEventBase` existed to hold the refcount and `QueryInterface` plumbing, and **neither guard inherited it**.

    Two independent guards now install before `webview_navigate` and uninstall before `webview_destroy` (after destroy, `core_webview()` returns `nullptr` and `remove_` is unreachable). Verified end-to-end on a real window: a cross-origin navigation is cancelled and handed to the system browser — which then actually loaded the URL — while a same-origin navigation in the same run went through untouched.

### Changed

- **`FLAG_ALLOW_EXTERNAL_NAV` (new, `128`) opts out of navigation interception** for applications that genuinely are browsers. This is the release's one breaking-in-effect change: without the flag, a cross-origin top-level navigation now opens the system browser instead of replacing the app. Nothing else about the flag's surrounding policy moved — `window.open` / `target=_blank` is still cancelled and opened externally **even with this flag**, because that is a capability boundary rather than a safety policy: the shell owns exactly one top-level window (the native side is a process-level singleton), so a second window would have no host API able to close, read or message it.
- Only `http:` / `https:` ever reach `ShellExecuteW`. `file:`, `javascript:`, `ms-*:` and custom schemes are cancelled silently and never touch a protocol handler, and `mailto:` / `tel:` are deliberately **not** on the list either — a dead `mailto:` link is preferable to handing a page an arbitrary protocol dispatcher.
- **An origin-less startup URL is no longer a free pass.** The old predicate returned "same origin" whenever `g_origin` was empty, which meant `file://`, `about:blank` and custom-scheme apps — the most common shape for a desktop shell — were the least protected. That branch now degrades to a _same-document_ test: a navigation stays inside the window only if it matches the startup URL after stripping the `#fragment`. In-app hash routing keeps working; anything else is external.

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
- Six references in `AGENTS.md` and `docs/pitfalls.md` pointed at files that no longer exist: `tools/capture-window.ps1` (three occurrences), `probe-memory.ps1`, `src/safe-port.ts` (the module is actually `src/shell/port.ts`), and `src/gui/page-script.test.ts` (the whole `src/gui/` directory was removed when the UI became a static `src/ui/index.html`). A migration leaves legitimate historical references behind, so the fix is not to delete them but to make the decision explicit — see the guard under _Added_.

### Added

- `native/resample.ts` — area-average (box) downscaling over BGRA, and the reason `--max-edge` no longer goes through `Bun.Image` at all. Measured on a real 3098×1850 window scaled to 1300×776, median of five runs:

    | route                                 | ms       | bytes       |
    | ------------------------------------- | -------- | ----------- |
    | **our `downscaleBgra` + our encoder** | **45.9** | **102,036** |
    | `Bun.Image` resize + png              | 95.9     | 222,621     |

    **2.1× faster and 2.2× smaller — both directions, not a trade-off.** It is faster because `Bun.Image` takes a PNG as input, so it must encode and then decode again before it can resample; we hold the raw `CreateDIBSection` pointer and never pay that. It is smaller because its default filter is `lanczos3` — a **sharpening** filter that rings around text edges, and the resulting high-frequency detail is exactly what DEFLATE compresses worst. Area averaging is inherently smooth, so the correct algorithm saves both costs at once. A prefix-sum variant was tried and came out **slower** (51.3 vs 39.1 ms for the resample alone): the extra full-width pass and the larger intermediate buffer cost more in cache locality than the inner-loop subtraction saves. Recorded as `docs/pitfalls.md` 3.16.

- `native/resample.ts` weights the average by alpha (`Σ(b·a)/Σa`) whenever any pixel is transparent, because a plain average mixes the RGB of fully transparent pixels — usually `0` — into the result and grows a black fringe around rounded corners and shadows. `scripts/make-icon.ts` produces exactly such rounded corners. Fully opaque input takes a fast path where the arithmetic is exact. `tests/resample.test.ts` pins this with a 2×2 → 1×1 construction (one opaque black pixel, three opaque whites): the right answer is white at alpha 191, the wrong one is grey 191.
- `cropBgra` in `native/gdi.ts` — cropping is a per-row `memcpy` over the raw pointer, so it costs no FFI and no resample. It is deliberately applied **before** encoding: once the pixels are handed to `Bun.Image` they are an opaque object and can no longer be cut. `--crop x,y,w,h` exposes it, and the rectangle is clamped to the image rather than producing a malformed one.
- `native/model-image.ts` — narrowed to the three things the in-repo code cannot do: **enlarging** (box averaging cannot interpolate), **palette** quantisation, and **jpeg / webp** encoding. Everything else on the PNG path now stays inside `native/`.
- A **two-way** guard on the `AGENTS.md` directory tree. The existing assertion ("everything declared must exist on disk") cannot catch the opposite failure, and `native/model-image.ts` sat outside the tree for a whole round while the gate was green — an unlisted file is invisible to an agent reading the tree as its map. Writing the reverse assertion also exposed a blind spot in the forward one: the tree is aligned by longest name, so `probe-child-windows.ts` is followed by a **single** space, and the parser's `\s{2,}` separator meant that line had never been parsed — and therefore never checked — since the guard was written.
- A guard for script paths referenced in the docs, backed by an explicit _deleted_ allow-list (same orientation as `verify-pack.ts`'s `ALLOW`: adding an entry must be a deliberate decision). A second assertion fails if a listed-deleted file reappears, so the list cannot rot unnoticed.

### Changed

- `tools/capture-window.ts` defaults are now set by measurement rather than intuition: `--format png`, `--level 6`, `--max-edge 0`, plus a new `--level <1-9>` and `--crop <x,y,w,h>`. Level 6 is the knee — 31% smaller than level 1 for about 3 ms, and 4× faster than level 9 for 13% more bytes. End-to-end on a real window (including Bun startup and `PrintWindow`):

    | command                  | bytes      | end-to-end ms |
    | ------------------------ | ---------- | ------------- |
    | `--level 1`              | 704,353    | 148           |
    | default (level 6)        | 439,347    | 170           |
    | `--level 9`              | 411,366    | 330           |
    | `--crop 700,300,800,600` | **50,836** | 170           |

    Level 9 buys 6% for double the time; cropping buys **88%** and also drops the token estimate from 1024 to 291. Recorded as `docs/pitfalls.md` 3.14.

- The choice between the in-repo encoder and `Bun.Image` is now two conditions rather than one: **downscale _and_ png** together keep the whole path inside `native/`; anything else (enlarging, palette, jpeg, webp) still goes to `Bun.Image`. Previously a crop was enough to trigger the `Bun.Image` detour, which re-encoded through it for no benefit — 50.0 ms / 84 KiB against 6.0 ms / 62 KiB for the same crop. **Cropping is a pixel operation and must not change the encoding route.**

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
- TypeScript sources are published, not compiled. Consumers need Bun 1.4.4 or newer. Installing under Node succeeds but nothing runs.
- `bun:ffi` is marked experimental in Bun, and the entire native boundary depends on it.
- `pickFolder()` blocks the calling thread. The modal loop inside `SHBrowseForFolder` keeps timers on that thread from firing, and the call cannot be cancelled or timed out. Run it in a worker if you need concurrency.
- One window per process. The native layer keeps a process-wide singleton, so a second `start()` fails until the previous window is observed dead through `isAlive()`.
- Not yet verified in managed environments that enforce AppLocker, WDAC, or third-party EDR behaviour blocking.
- No commercially trusted code signing: only a self-signed certificate has been exercised end to end.

[Unreleased]: https://github.com/TiancongLx/bun-app-window/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/TiancongLx/bun-app-window/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/TiancongLx/bun-app-window/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/TiancongLx/bun-app-window/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TiancongLx/bun-app-window/releases/tag/v0.1.0
