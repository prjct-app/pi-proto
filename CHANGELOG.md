# Changelog

## Unreleased

- Added bounded, cached repository evidence and targeted pi-memory context.
  Explicit artifact selection keeps tokens/guide requests separate from screens.
- Added native design-run limits and separate usage counters; exhausted runs
  stop with saved partial work, not a completion claim. Removed idle TUI badges.
- Made pattern documentation conditional on existing named patterns; guides
  remain framework-neutral. These changes do not establish visual quality.
- Recheck filesystem echoes inside the render queue, including token changes,
  so delayed startup events do not trigger redundant builds.
- Separated tokens, compact design specifications and prototype work. Empty
  init no longer invents brand values or creates a screen. Narrow artifact
  requests guard against unintended prototype/application writes.
- Added native/MCP proto_tokens and proto_design (500-word specification with
  target/current/constraint reference roles). Entrega is now a bounded index,
  not a duplicate of authored guides/tokens; full findings are on demand.
- Replaced screen-first guidance with scope/reference-first instructions and
  removed superseded copies of our own guidance from model context.
- Removed remote classification from the default send path; exact navigation/
  undo are deterministic and edits forward the selected YAML immediately.
- Deferred/coalesced documentation, cached validated prototype reads and
  compiled only live CSS candidates. Build failures now reach edit tools.
- Fixed sticky working status, connection/report races and duplicate startup
  hubs; streamed visible assistant text and restored state after reconnect.
- Added a mobile navigation drawer and usable narrow-screen canvas/composer.
- Added daemon revision checks so an installed update replaces an old process.
- Completed the proto composer: optional bounded Jev classification, local
  navigation and recoverable undo, per-tab context, explicit selections and
  inferred-element YAML delivered to Pi. Busy/stale undo requests fall back.
- Added stable designer guidance once per session, without per-turn system
  prompt changes, and the same guidance in MCP initialization.
- Added named component utilities to tokens.yaml and generated Componentes
  and Entrega pages: authored direction, tokens, patterns, real page entries/
  exits, review state and deterministic structural/accessibility findings.
- Bundled the viewer source and build with pi-proto; fixed live CSS updates,
  guide refreshes, copied-page interactions and serialized renders. Invalid
  utilities preserve the previous working HTML/CSS.
- Added offline coverage and a Chromium workflow check; repaired the
  immutable-binding checker to inspect declarations rather than template text.

- `pi-proto` initial scaffold:
  - **Workspace:** project identity via `~/.prjct/identity/index.json` (signed
    bindings) and a derived id fallback. Status file with mtime cache, atomic
    write, schema validation via `typebox`.
  - **Detection:** stack (Next/Astro/Vue/plain), styling (tw4-postcss/tw3/plain),
    UI library, dark-mode, routes, docs. CSS adapter pre-scans `postcss.config.mjs`
    and `@import "tailwindcss"` to upgrade from `plain` to `tw4-postcss`.
  - **Build:** bundler, CSS adapter (Tailwind v4 PostCSS), per-screen inject
    that adds `main.css`, `gsap.js`, `proto.js` to the head/body.
  - **Server:** HTTP server with SSE bus, lock file at `proto/.lock` for
    single-window-per-project, `__comment` POST endpoint that publishes to
    the active channel.
  - **Runtime:** tiny browser runtime with viewport switcher, scenario
    switcher, comment mode, SSE listener, dark-mode toggle, GSAP-driven
    page-enter animation.
  - **Browser:** Playwright wrapper for `proto_shot` (per-route, per-viewport
    screenshots) and `openInBrowser` for `/proto open`.
  - **Guard:** `tool_call` hook that blocks writes to UI files owned by
    unapproved items. Path canonicalization handles symlinks and missing
    files. Resolves paths inside `protoDir` and `allowWrite` cleanly.
  - **Tools:** 7 thin tools with one-sentence descriptions. `proto_init`,
    `proto_build`, `proto_shot`, `proto_review`, `proto_handoff`, `proto_diff`,
    `proto_feedback`. Each `execute` is a lazy `await import()`.
  - **Command:** `/proto init|open|close|status|on|off|approve|reject|gate|role`.
  - **Mode line:** `proto · <8 hex>` registered in the TUI when the project
    is gated.
  - **No skill:** process guidance is in tool descriptions and the project's
    own `proto/.impeccable/DESIGN.md` (read on demand by the agent, not the
    Pi skill mechanism).

## Build / verify

```bash
npm run check   # tsc + no-let
npm test        # 38 tests (bash 8, detect 5, guard 7, identity 6, status 4, build 5, integration 3)
npm run build:pi
```

The compiled copy lives at `~/.pi/agent/builds/pi-proto/`.
