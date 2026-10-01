import { Type, type Static } from 'typebox';

/**
 * proto.json is the single source of truth for a project's prototype state.
 * It is written only by extension code (`proto_init`, `proto_build`,
 * `proto_review`, `proto_handoff`, `/proto approve|reject|gate|on|off`).
 * Anything that the guard or the browser window needs lives here so the file
 * is the only thing that has to be kept coherent across sessions.
 */
export const StackSchema = Type.Union([
  Type.Literal('next-tailwind4'),
  Type.Literal('next-tailwind3'),
  Type.Literal('astro'),
  Type.Literal('vue'),
  Type.Literal('html-tailwind4'),
  Type.Literal('plain'),
]);
export type StackId = Static<typeof StackSchema>;

export const StylingSchema = Type.Union([
  Type.Literal('tw4-postcss'),
  Type.Literal('tw4-node'),
  Type.Literal('tw3'),
  Type.Literal('plain'),
]);
export type StylingId = Static<typeof StylingSchema>;

export const DarkModeSchema = Type.Union([
  Type.Literal('class'),
  Type.Literal('media'),
  Type.Literal('attribute'),
]);
export type DarkMode = Static<typeof DarkModeSchema>;

export const ViewportSchema = Type.Object({
  width: Type.Integer({ minimum: 1, maximum: 4096 }),
  height: Type.Integer({ minimum: 1, maximum: 4096 }),
  label: Type.String({ minLength: 1, maxLength: 32 }),
});
export type Viewport = Static<typeof ViewportSchema>;

export const SitemapRouteSchema = Type.Object({
  route: Type.String({ pattern: '^/' }),
  screen: Type.String({ minLength: 1 }),
  id: Type.Optional(Type.String({ minLength: 1 })),
  layout: Type.Optional(Type.String()),
  menus: Type.Optional(Type.Array(Type.String())),
  auth: Type.Optional(Type.Union([Type.Literal('public'), Type.Literal('required')])),
  scenarios: Type.Optional(Type.Array(Type.String())),
  status: Type.Optional(Type.Union([
    Type.Literal('draft'),
    Type.Literal('review'),
    Type.Literal('approved'),
    Type.Literal('rejected'),
    Type.Literal('changed'),
  ])),
});
export type SitemapRoute = Static<typeof SitemapRouteSchema>;

export const ProtoItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal('screen'),
    Type.Literal('component'),
    Type.Literal('guide'),
    Type.Literal('design-tokens'),
  ]),
  /** Files that this item owns; the guard blocks writes to these until approved. */
  targets: Type.Array(Type.String()),
  /** Route (e.g. `/login`) the item is bound to when kind is `screen`. */
  route: Type.Optional(Type.String({ pattern: '^/' })),
  /** Optional link back to a route (screens) or a component name. */
  ref: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal('draft'),
    Type.Literal('review'),
    Type.Literal('approved'),
    Type.Literal('rejected'),
    Type.Literal('changed'),
  ]),
  /** SHA-256 of the item's content; any edit invalidates the approval. */
  contentHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  approvedAt: Type.Optional(Type.Integer()),
  approvedBy: Type.Optional(Type.String()),
  note: Type.Optional(Type.String({ maxLength: 500 })),
  createdAt: Type.Optional(Type.Integer()),
  updatedAt: Type.Optional(Type.Integer()),
});
export type ProtoItem = Static<typeof ProtoItemSchema>;

export const TeamSchema = Type.Object({
  protoRoles: Type.Array(Type.String(), { default: ['ux'] }),
  portRoles: Type.Array(Type.String(), { default: ['fe'] }),
});
export type Team = Static<typeof TeamSchema>;

export const WindowOwnerSchema = Type.Object({
  sessionId: Type.String(),
  role: Type.String(),
  startedAt: Type.Integer(),
  /** Opaque token that gates approvals from the browser window. */
  approvalToken: Type.String({ pattern: '^[a-f0-9]{32,128}$' }),
});
export type WindowOwner = Static<typeof WindowOwnerSchema>;

export const ProtoConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  project: Type.Object({
    name: Type.String({ minLength: 1 }),
    projectId: Type.String({ pattern: '^p_[A-Za-z0-9_-]+$' }),
    location: Type.String(),
  }),
  stack: StackSchema,
  styling: StylingSchema,
  /** Absolute path to the CSS entry (e.g. `<repo>/src/app/globals.css`). */
  cssEntry: Type.Optional(Type.String()),
  /** Absolute path to the project's public assets, served as-is by the build. */
  publicDir: Type.Optional(Type.String()),
  /** Library whose CSS is loaded by the build (e.g. `@heroui/styles`, daisyUI). */
  uiLibrary: Type.Optional(Type.String()),
  darkMode: DarkModeSchema,
  viewports: Type.Array(ViewportSchema, { minItems: 1 }),
  sitemap: Type.Array(SitemapRouteSchema),
  items: Type.Array(ProtoItemSchema),
  team: TeamSchema,
  /**
   * Extra paths the guard allows even when gate is on (e.g. a design docs repo
   * the ux role is allowed to update). Paths are absolute, real-pathed.
   */
  allowWrite: Type.Array(Type.String(), { default: [] }),
  /** UI file roots that the guard watches (e.g. `<repo>/src/app`). */
  ui: Type.Object({
    paths: Type.Array(Type.String(), { default: [] }),
    gate: Type.Union([Type.Literal('all'), Type.Literal('off')], { default: 'all' }),
  }),
  /** Local server settings. `port: 0` means ephemeral; otherwise the same
   *  port is reused across sessions so the URL is bookmarkable. */
  server: Type.Optional(Type.Object({
    port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
    host: Type.Optional(Type.String({ minLength: 1 })),
  })),
  /**
   * Owner of the open browser window, if any. Only one session at a time; the
   * `approvalToken` is what the user-facing approve button carries.
   */
  windowOwner: Type.Optional(WindowOwnerSchema),
  /** Free-form notes the agent should know before touching a screen. */
  notes: Type.Optional(Type.String({ maxLength: 4000 })),
});
export type ProtoConfig = Static<typeof ProtoConfigSchema>;

/**
 * Default config used by `proto_init` when the project has no detectable
 * tokens yet. The agent fills the missing pieces after `detect.ts` runs.
 */
export const emptyConfig = (input: {
  project: { name: string; projectId: string; location: string };
  stack: StackId;
  styling: StylingId;
  darkMode: DarkMode;
  viewports: readonly Viewport[];
}): ProtoConfig => ({
  schemaVersion: 1,
  project: input.project,
  stack: input.stack,
  styling: input.styling,
  darkMode: input.darkMode,
  viewports: input.viewports.map(v => ({ ...v })),
  sitemap: [],
  items: [],
  team: { protoRoles: ['ux'], portRoles: ['fe'] },
  allowWrite: [],
  ui: { paths: [], gate: 'all' },
});

export const DEFAULT_VIEWPORTS: readonly Viewport[] = [
  { width: 360, height: 800, label: 'mobile' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 800, label: 'desktop' },
];
