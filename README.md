# Prototype · pi-proto

A framework-neutral design workspace with Pi as its agent. Its primary deliverable is a stable design guide: rationale, hierarchy, composition, typography/color roles, density, states and patterns to preserve or avoid. New pages extend that reasoning; an existing poor interface is a baseline, not a visual mandate. Tokens, guides and screens are separate deliverables. A component catalogue is optional, never a prerequisite.

`proto_context` retrieves bounded local project evidence, the current guide and pi-memory's supported project decisions in one call. It detects frontend packages and declared/resolvable libraries, links reusable sources and caches unchanged inputs. It does not scaffold, build, execute source code or call a model. Native Pi design requests receive this snapshot automatically. MCP callers retrieve their own memory; the daemon never opens a parallel memory database.

## How it works

| Piece | Where it lives | What it is for |
| --- | --- | --- |
| Workspace | `~/.prjct/<project>/proto/` | `guide/`, `prototypes/<id>.yaml`, `proto.json`, and the HTML/CSS build in `dist/`. |
| Prototype app | `viewer/` in this package | React, bundled with the compiled Pi package. Served to the browser, never loaded into Pi. |
| Daemon | One local process per prjct home | Serves every project's storybook, applies operations, regenerates docs and connects browsers to Pi. |
| Extension | Pi | Agent tools, stable designer guidance, composer bridge and status. |

The daemon usually listens on port 51700; projects have separate URLs. Browser tabs and Pi sessions reconnect to it. There is no persistent idle/live TUI badge. `PI_PROTO_VIEWER` overrides the viewer folder; the legacy `~/.prjct/proto-viewer/dist` is a fallback when the bundled viewer has not been built.

## What goes in the workspace

**Design guide:** `guide/<nn>-<slug>.md`, in Markdown.
- Pages are ordered by their number.
- The title comes from front matter or the first `#` heading.
- A page may embed HTML with the same Tailwind classes the prototypes use, so colors, type and components show for real.

**Tokens and shared patterns:** `guide/tokens.yaml`.

Use `proto_tokens` to read/merge values from inspected references; existing values are preserved. New workspaces have no invented brand palette, font or prototype. The sample below is an example, not a default identity.

```yaml
colors:
  brand: "#125e55"
  paper: "#ffffff"
radius:
  control: "8px"
components:
  btn-primary:
    as: button
    text: Continuar
    description: Acción principal
    class: "bg-brand text-paper rounded-control px-5 py-3 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
```

Use `class: btn-primary` on prototype nodes. These patterns compile into Tailwind v4 utilities. Updating a definition refreshes all its uses through CSS without rewriting HTML. A component may also be a plain class string. Supported example tags are `div`, `span`, `p`, `h1`, `h2`, `button`, `a`, `input`, and `textarea`.

**Prototypes:** `prototypes/<id>.yaml`, with stable ids on pages and nodes. Change them through `proto_edit` operations, which create an undoable version. Nodes are spatial primitives (`box`, `stack`, `row`, `grid`, `text`, `image`, `button`, `input`, etc.). Click actions are `on: {click: {go: page-id}}`, `{toggle: node-id}`, or `{back: true}`. Only one page shows at a time. `flow` groups pages; `group` groups prototype variants for comparison. Neither grouping creates navigation by itself.

**Design guide:** `guide/00-design.md`, explicitly written with `proto_design`, a core of at most 500 words including references. Cover scope, source roles (target/current/constraint), visual rationale, composition, density, type/color roles, states/responsive rules, requested navigation, preserved/rejected patterns and pending decisions. It is not coupled to components, a framework or class names. Link detailed evidence and optional values rather than duplicating them.

**Generated documentation:** Tokens (`10-tokens`), optional existing patterns (`20-components`, only when explicitly defined), Sitemap (`90-sitemap`) and Entrega (`95-handoff`). Entrega is a compact index, not another design document. Full findings live in `96-checks.json`, read on demand. Original guides/notes are preserved. Automatic checks do not certify fidelity or full accessibility.

## The loop

1. You ask in Pi: "prototype the checkout, three variants".
2. The agent uses the requested artifact: `proto_tokens`, `proto_design` or prototype tools. `proto_init` prepares a workspace only; `artifact: prototype` explicitly creates its first page, and `open_browser: true` opts into opening the browser.
3. The agent receives fixed designer guidance once and a replaceable project-context snapshot, including bounded pi-memory evidence. The extension does not modify the system prompt per turn. Relevant guide/token changes refresh the snapshot; old copies do not accumulate.
4. You write in the composer docked at the bottom of the storybook, like Pi's editor.
   - Exact commands to open a named page or undo run locally, without a model or Pi. Edits go straight to Pi with the selected element's versioned YAML. Undo creates a recoverable version and is deferred while the agent is working.
   - Each browser tab supplies its own page context. Selecting an element includes its current YAML/version directly; opt-in inference can also suggest a target.
   - API clients can request Jev inference with `understand: true`; the default viewer never waits for it. The opt-in lookup/classification is bounded to 1500 ms and falls back to Pi on errors, weak confidence or missing credentials. Jev uses `TYPESAFE_API_KEY` or OS keyring; `PI_PROTO_OFFLINE=1` disables it.
   - Text and images arrive as your user message. Attach, paste or drag images; images over 1800 px are scaled down.
   - It also switches the session's model and thinking level, in sync with Pi.
   - Sending is acknowledged immediately. The dock shows the real agent activity and streams its visible text, not its private reasoning. When the turn ends, the final answer appears in the conversation. The agent can also answer there with `proto_reply`.
5. Choose the deliverable in the composer or describe it in the message. Stop after that artifact. Native Pi tasks have default ceilings of 180 seconds, 12 model responses, 24 tool executions and 16,000 generated tokens. Reaching a ceiling aborts the run with a partial-result notice; saved work is not reverted. The viewer separates fresh input/output from cached input. These are safety ceilings, not speed or design-quality guarantees. They do not apply to unrelated Pi tasks or external MCP agents.
6. For requested screens, compare screenshots against the desired reference at relevant sizes. A build, a short guide or a completed budget is not proof of good design. New directions from goals/photos still require visual judgment; this implementation has not established superiority to another design product.

A build error, such as an invalid token or component utility, is reported in the storybook. The last working HTML and CSS remain available.

## Tools and commands

| Tool | For |
| --- | --- |
| `proto_context` | One cached read of local guide/library evidence and supported pi-memory decisions; no build or writes. |
| `proto_init` | Prepare a workspace; prototype/browser creation is explicit. |
| `proto_tokens` | Read one token group or merge values; never create screens. |
| `proto_design` | Read/write the single compact specification with reference roles. |
| `proto_sitemap` | Compact index; supply prototype for its flows/pages/clicks. |
| `proto_read` | Read a prototype or page as YAML. |
| `proto_edit` | Apply a batch of operations as one version. |
| `proto_create` | Create a prototype or page, optionally duplicating a page. |
| `proto_show` | Navigate to a page and optionally highlight a node. |
| `proto_shot` | Attach screenshots at configured viewports. |
| `proto_reply` | Reply in the storybook conversation. |

`/proto` commands: `init`, `open`, `close`, `status`, `approve <id>`, `reject <id>`, `gate on|off`, `role <name>`, `on`, `off`.

## Build

```bash
npm install
npm --prefix viewer install
npm run check && npm test
npm run test:browser    # uses installed Playwright Chromium
npm run build:pi        # viewer + extension, into ~/.pi/agent/builds/pi-proto
```

The daemon also exposes the same operations over MCP at `/mcp`, with the storybook as an MCP App.

Restart Pi to load the compiled extension.
