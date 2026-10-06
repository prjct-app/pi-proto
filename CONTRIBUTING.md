# Contributing

Integration branch is `develop`.

```bash
npm run check
npm test
npm run check:package
```

Do not add `let` in `src/`. Pi packages stay peer dependencies. Use public Pi
1.0.4 APIs only.

The extension is a client of the local proto daemon. Prototypes are versioned
YAML changed through operations. The browser viewer's source lives in `viewer/`
and its build ships with the compiled extension; it is never loaded into Pi.
Install its dependencies with `npm --prefix viewer install`.

Context budget is a hard rule for this package:

- The extension entry (`index.ts`) is a thin shell. No heavy code at the top
  level; everything goes through dynamic imports.
- Keep tool descriptions/results compact; document the operation vocabulary
  where the agent needs it. Read only the relevant page for an edit.
- Designer guidance is a fixed journaled message (`proto-designer`), once per
  version/session. Model context drops superseded copies of our own guidance,
  without editing the journal or user/tool evidence. Never add per-turn system instructions.
- Tokens/documents/prototypes are separate artifacts. Init is empty by default.
  Narrow artifact requests block prototype tools and common file-write escape paths.
- The authored specification is `00-design.md` (500 words incl. reference roles).
  Entrega links it and source tokens instead of duplicating them. Detailed findings
  and source evidence are read only on demand; never auto-summarize taste/identity.
- The guide is framework-neutral. Do not require a component catalogue, copy a
  poor baseline as the target, or equate shorter prose with good design.
- `proto_context` is bounded, cached local evidence, not an agent-driven repo
  crawl. pi-memory is consumed through its published read-only project view;
  never import another engine or open its database. Missing/timeout states are explicit.
- Native design tasks meter model responses, tool executions, uncached input,
  generated output and cached input separately. Budget exhaustion preserves saved
  work and stops the run; never present it as successful completion.
- Use Prototype as the product name. Wire identifiers retain compatibility;
  do not publish idle/live badges to the TUI.
- The daemon owns file watching and rendering. Serialize renders; defer
  coalesced docs/audits after edits. Scan exact live CSS candidates, not history.
- Composer text, images, and selection reach Pi directly. Only exact local navigation and undo commands bypass the model.
- Regenerate only inside documentation markers; preserve authored notes.

`npm run test:browser` checks the real viewer against a local daemon and an offline
Pi fixture. No test uses real model credentials or the OS keychain.

Publish this package independently and install from npm. Declare runtime package
dependencies normally.
