import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The storybook: a project's design guide and prototypes, live. Everything it
 * does goes through the proto daemon: it reads the sitemap, sends operations
 * (new page, link, interaction), swaps changed nodes in place, and carries the
 * person's messages to the Pi session working on the project. Pi is the engine.
 */

// ---------- data ----------

type Interaction = { page: string; node: string; label: string; kind: 'go' | 'toggle' | 'back'; target?: string };
type Proto = {
  id: string; title: string; group?: string; description?: string; status: string; version: number; url: string;
  pages: Array<{ id: string; title: string; flow?: string }>;
  flows: Array<{ name: string; pages: string[] }>;
  interactions: Interaction[];
};
type Guide = { slug: string; title: string; order: number; updatedAt: number };
type PiState = { models: Array<{ provider: string; id: string; name: string }>; model?: { provider: string; id: string }; thinking: string; levels: string[]; error?: string };
type Agent = { state: 'idle' | 'working'; step?: string; startedAt?: number;
  usage?: { calls: number; tools: number; input: number; output: number; cacheRead: number };
  limits?: { seconds: number; calls: number; tools: number; output: number }; stopped?: string };
type Session = { label: string; pi?: PiState; agent: Agent } | null;
type Story = {
  protocol: number;
  project: { name: string; projectId: string };
  guides: Guide[];
  prototypes: Proto[];
  problems: string[];
  build: { building: boolean; ok: boolean; error?: string };
  session?: Session;
};
type Route = { kind: 'proto'; id: string; page?: string } | { kind: 'guide'; slug: string } | { kind: 'compare'; group: string } | { kind: 'none' };
type Picked = { node: string; page: string; label: string; tag: string; isPage: boolean; action: null | { go?: string; toggle?: string; back?: boolean } };
type Mode = null | 'link' | 'interact' | 'select' | 'toggle-target';
type Message = { from: 'you' | 'agent'; text: string; at: number; about?: string; images?: number };
type Attachment = { data: string; mimeType: string; url: string; name: string };

const PROTOCOL = 4;
const BASE = location.pathname.replace(/[^/]*$/, '');

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const signal = AbortSignal.timeout(path === '__ask' ? 10_000 : 30_000);
  const res = await fetch(BASE + path, body === undefined ? { cache: 'no-store', signal } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `falló (${res.status})`);
  return data;
};

const enc = encodeURIComponent;
const parseHash = (): Route => {
  const [kind, a, b] = location.hash.replace(/^#\/?/, '').split('/').map(x => decodeURIComponent(x ?? ''));
  if (kind === 'p' && a) return { kind: 'proto', id: a, page: b || undefined };
  if (kind === 'g' && a) return { kind: 'guide', slug: a };
  if (kind === 'c' && a) return { kind: 'compare', group: a };
  return { kind: 'none' };
};

const VIEWPORTS = [
  { id: 'mobile', label: 'Móvil', width: 390 },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'desktop', label: 'Escritorio', width: 1280 },
  { id: 'full', label: 'Ancho', width: 0 },
] as const;
type Viewport = (typeof VIEWPORTS)[number]['id'];

const STATUS: Record<string, string> = { draft: 'Borrador', review: 'En revisión', approved: 'Aprobado' };

const store = {
  get<T>(key: string, fallback: T): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } },
  set(key: string, value: unknown): void { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private */ } },
};

const elapsed = (from: number | undefined, now: number): string => {
  if (!from) return '';
  const s = Math.max(0, Math.round((now - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function useNow(ms: number, active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms, active]);
  return now;
}

// ---------- app ----------

function App() {
  const [story, setStory] = useState<Story>();
  const [offline, setOffline] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash());
  const [viewport, setViewport] = useState<Viewport>(store.get('proto.viewport', matchMedia('(max-width: 760px)').matches ? 'full' : 'desktop'));
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState('');
  const [mode, setMode] = useState<Mode>(null);
  const [picked, setPicked] = useState<Picked>();
  const [selected, setSelected] = useState<Picked>();
  const [screen, setScreen] = useState<string>();
  const [toast, setToast] = useState<{ text: string; bad?: boolean }>();
  const [dialog, setDialog] = useState<null | 'page' | 'prototype' | 'history' | 'guide-edit'>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadOpen, setThreadOpen] = useState(false);
  const [agent, setAgent] = useState<Agent>({ state: 'idle' });
  const [pi, setPi] = useState<PiState>();
  const [session, setSession] = useState<Session>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const reloadKey = useRef(0);
  const [reload, setReload] = useState(0);
  const now = useNow(1000, agent.state === 'working');

  const say = useCallback((text: string, bad = false) => { setToast({ text, bad }); setTimeout(() => setToast(t => (t?.text === text ? undefined : t)), 3500); }, []);
  const refreshing = useRef<{ timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; again: boolean }>({ again: false });
  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current.running) { refreshing.current.again = true; return refreshing.current.running; }
    const work = async () => {
    try {
      const next = await api<Story>('api/story');
      setStory(next);
      setSession(next.session ?? null);
      if (next.session) { setAgent(next.session.agent); if (next.session.pi) setPi(next.session.pi); }
      else { setAgent({ state: 'idle' }); setPi(undefined); }
    } catch { /* the stream says when it is back */ }
    };
    refreshing.current.running = work();
    await refreshing.current.running;
    refreshing.current.running = undefined;
    if (refreshing.current.again) { refreshing.current.again = false; void refresh(); }
  }, []);
  const scheduleRefresh = useCallback(() => {
    if (refreshing.current.timer) return;
    refreshing.current.timer = setTimeout(() => { refreshing.current.timer = undefined; void refresh(); }, 60);
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const on = () => setRoute(parseHash()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => { store.set('proto.viewport', viewport); }, [viewport]);
  useEffect(() => { setNavOpen(false); }, [route]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    addEventListener('keydown', close); return () => removeEventListener('keydown', close);
  }, []);
  const threadKey = story ? `proto.thread.${story.project.projectId}` : '';
  useEffect(() => { if (threadKey) setMessages(store.get<Message[]>(threadKey, [])); }, [threadKey]);
  const addMessage = useCallback((m: Message) => setMessages(list => { const next = [...list, m].slice(-60); if (threadKey) store.set(threadKey, next); return next; }), [threadKey]);

  const post = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ source: 'pi-proto-storybook', ...message }, '*');
  const routeRef = useRef(route);
  routeRef.current = route;
  const pendingFlash = useRef<{ prototype: string; page?: string; node: string } | undefined>(undefined);

  // Live events from the daemon.
  useEffect(() => {
    const events = new EventSource(`${BASE}__events?channel=story`);
    const on = (name: string, fn: (data: any) => void) => events.addEventListener(name, e => fn(JSON.parse((e as MessageEvent).data || 'null')));
    on('hello', () => { setOffline(false); void refresh(); });
    on('story', scheduleRefresh);
    on('building', () => setStory(s => s && { ...s, build: { ...s.build, building: true } }));
    on('built', data => {
      const r = routeRef.current;
      if (data.cssChanged && r.kind === 'proto') post({ type: 'patch', patches: [], css: true });
      if (r.kind === 'compare' && data.cssChanged) { reloadKey.current += 1; setReload(reloadKey.current); }
      scheduleRefresh();
    });
    on('build-error', data => { setStory(s => s && { ...s, build: data }); scheduleRefresh(); });
    on('patch', data => {
      const r = routeRef.current;
      if (r.kind === 'proto' && r.id === data.prototype) post({ type: 'patch', patches: data.patches, css: data.css });
      scheduleRefresh();
    });
    on('prototype', data => {
      const r = routeRef.current;
      if ((r.kind === 'proto' && r.id === data.prototype) || r.kind === 'compare') { reloadKey.current += 1; setReload(reloadKey.current); }
      scheduleRefresh();
    });
    on('navigate', data => {
      if (!data?.prototype) return;
      if (data.node) pendingFlash.current = { prototype: data.prototype, page: data.page, node: data.node };
      location.hash = `#/p/${enc(data.prototype)}${data.page ? `/${enc(data.page)}` : ''}`;
      const r = routeRef.current;
      if (data.node && r.kind === 'proto' && r.id === data.prototype && (!data.page || r.page === data.page)) {
        post({ type: 'flash', node: data.node }); pendingFlash.current = undefined;
      }
    });
    on('session', data => { setSession(data); if (!data) setAgent({ state: 'idle' }); });
    on('pi', data => setPi(data));
    on('agent', data => { setAgent(data); if (data.state === 'idle') setPreview(''); });
    on('preview', data => { setPreview(data.text); setThreadOpen(true); });
    on('reply', data => { setPreview(''); addMessage({ from: 'agent', text: data.text, at: data.at ?? Date.now() }); setThreadOpen(true); });
    events.onerror = () => setOffline(true);
    return () => { events.close(); clearTimeout(refreshing.current.timer); refreshing.current.timer = undefined; };
  }, [refresh, scheduleRefresh, addMessage]);

  // Land somewhere when there is no route.
  useEffect(() => {
    if (!story || route.kind !== 'none') return;
    const first = story.prototypes[0];
    location.replace(first ? `#/p/${enc(first.id)}` : story.guides[0] ? `#/g/${enc(story.guides[0].slug)}` : '#');
  }, [story, route]);

  const proto = route.kind === 'proto' ? story?.prototypes.find(p => p.id === route.id) : undefined;
  const page = proto ? route.kind === 'proto' && route.page ? route.page : screen ?? proto.pages[0]?.id : undefined;

  // Tell the daemon where the person is: context for the agent.
  useEffect(() => {
    if (!story) return;
    const body = route.kind === 'proto' ? { prototype: route.id, page, node: selected?.node } : route.kind === 'guide' ? { guide: route.slug } : {};
    void api('api/viewing', body).catch(() => undefined);
  }, [story?.project.projectId, route, page, selected?.node]);

  // Messages from the prototype page.
  useEffect(() => {
    const on = (event: MessageEvent) => {
      const m = event.data;
      if (m?.source !== 'pi-proto' || event.source !== frame.current?.contentWindow) return;
      if (m.type === 'screen') {
        setScreen(m.id);
        // Navigating inside the prototype moves the storybook with it, so the
        // sidebar shows where you are and clicking a page always goes there.
        const r = routeRef.current;
        if (r.kind === 'proto' && r.page !== m.id) {
          history.replaceState(null, '', `#/p/${enc(r.id)}/${enc(m.id)}`);
          setRoute(parseHash());
        }
        const flash = pendingFlash.current;
        if (flash && r.kind === 'proto' && r.id === flash.prototype && (!flash.page || flash.page === m.id)) {
          post({ type: 'flash', node: flash.node }); pendingFlash.current = undefined;
        }
      }
      if (m.type === 'ready' && mode) post({ type: 'pick', on: true });
      if (m.type === 'pick-cancel') { setMode(null); post({ type: 'pick', on: false }); }
      if (m.type === 'picked') onPicked(m as Picked);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  });

  useEffect(() => { post({ type: 'pick', on: mode !== null }); }, [mode]);
  useEffect(() => { setScreen(undefined); setSelected(undefined); setMode(null); setPicked(undefined); }, [route.kind === 'proto' ? route.id : route.kind]);

  const edit = useCallback(async (ops: unknown[], did: string) => {
    if (!proto) return;
    try { await api('api/ops', { prototype: proto.id, ops, did }); say(did); }
    catch (error) { say((error as Error).message, true); }
  }, [proto, say]);

  const toggleTarget = useRef<Picked | undefined>(undefined);
  const onPicked = (p: Picked) => {
    if (mode === 'select') { setSelected(p); setMode(null); return; }
    if (mode === 'toggle-target' && toggleTarget.current) {
      const source = toggleTarget.current;
      toggleTarget.current = undefined;
      setMode(null);
      void edit([
        { op: 'set', id: source.node, fields: { on: { click: { toggle: p.node } } } },
        { op: 'set', id: p.node, fields: { hidden: true } },
      ], `«${source.label || source.node}» muestra/oculta «${p.label || p.node}»`);
      return;
    }
    setPicked(p);
  };

  const working = agent.state === 'working';
  useEffect(() => { document.title = `${working ? '● ' : ''}Prototype · ${proto?.title ?? story?.project.name ?? ''}`; }, [working, proto?.title, story?.project.name]);

  if (!story) return <div className="boot">{offline ? 'Prototype is offline. Open it from Pi with /proto.' : 'Loading Prototype…'}</div>;

  const guide = route.kind === 'guide' ? story.guides.find(g => g.slug === route.slug) : undefined;
  const vp = VIEWPORTS.find(v => v.id === viewport)!;
  const about = proto ? [proto.title, proto.pages.find(p => p.id === page)?.title, selected ? `«${selected.label || selected.node}»` : ''].filter(Boolean).join(' › ') : guide?.title;

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      {navOpen && <button className="nav-backdrop" aria-label="Cerrar navegación" onClick={() => setNavOpen(false)} />}
      <Sidebar story={story} route={route} page={page} session={session} offline={offline} onNewPrototype={() => setDialog('prototype')} />
      <main className="main">
        <div className="mobile-nav"><button aria-expanded={navOpen} aria-controls="project-nav" onClick={() => setNavOpen(!navOpen)}>☰ Páginas</button><span>{story.project.name}</span></div>
        {(sending || working || story.build.building) && <div className="progress" />}
        {story.protocol !== PROTOCOL && <div className="banner bad">Esta sesión corre otra versión de pi-proto. Reinicia Pi.</div>}
        {offline && <div className="banner">Prototype is disconnected; reconnecting automatically.</div>}
        {proto && (
          <>
            <header className="bar">
              <div className="crumbs">
                <span className="muted">{proto.group ? `${proto.group} · ` : ''}{proto.pages.find(p => p.id === page)?.flow ?? ''}</span>
                <h1>{proto.title} <span className="muted">› {proto.pages.find(p => p.id === page)?.title ?? ''}</span></h1>
              </div>
              <div className="tools">
                <button onClick={() => setDialog('page')}>+ Página</button>
                <button className={mode === 'link' ? 'on' : ''} onClick={() => setMode(mode === 'link' ? null : 'link')}>Enlazar</button>
                <button className={mode === 'interact' || mode === 'toggle-target' ? 'on' : ''} onClick={() => setMode(mode === 'interact' ? null : 'interact')}>Interacción</button>
                <button className={mode === 'select' ? 'on' : ''} onClick={() => setMode(mode === 'select' ? null : 'select')} title="Elige un elemento para hablarle al agente de él">Seleccionar</button>
                <button onClick={() => setDialog('history')}>v{proto.version}</button>
                <span className="sep" />
                {VIEWPORTS.map(v => <button key={v.id} className={viewport === v.id ? 'on' : ''} onClick={() => setViewport(v.id)}>{v.label}</button>)}
                <a className="button" href={`${BASE}${proto.url}${page ? `#${page}` : ''}`} target="_blank" rel="noreferrer" title="Abrir aparte">↗</a>
              </div>
            </header>
            {mode && <div className="banner hint">{mode === 'link' ? 'Haz clic en el botón o texto que lleva a otra página.' : mode === 'interact' ? 'Haz clic en el elemento que tendrá la interacción.' : mode === 'toggle-target' ? 'Ahora haz clic en lo que se muestra u oculta (un menú, un modal).' : 'Haz clic en un elemento para hablarle al agente de él.'} <button onClick={() => setMode(null)}>Cancelar (Esc)</button></div>}
            <Canvas frameRef={frame} src={`${BASE}${proto.url}`} page={page} reload={reload} width={vp.width} />
            {picked && (mode === 'link' || mode === 'interact') && (
              <Picker mode={mode} picked={picked} proto={proto}
                onCancel={() => setPicked(undefined)}
                onGo={async target => { setPicked(undefined); setMode(null); await edit([{ op: 'set', id: picked.node, fields: { on: { click: { go: target } } } }], `enlazar «${picked.label || picked.node}» → ${proto.pages.find(p => p.id === target)?.title ?? target}`); }}
                onNewPage={async title => {
                  setPicked(undefined); setMode(null);
                  try {
                    const r = await api<{ page: string }>('api/create_page', { prototype: proto.id, title, flow: proto.pages.find(p => p.id === page)?.flow });
                    await edit([{ op: 'set', id: picked.node, fields: { on: { click: { go: r.page } } } }], `enlazar «${picked.label || picked.node}» → ${title}`);
                  } catch (error) { say((error as Error).message, true); }
                }}
                onToggle={() => { toggleTarget.current = picked; setPicked(undefined); setMode('toggle-target'); }}
                onBack={async () => { setPicked(undefined); setMode(null); await edit([{ op: 'set', id: picked.node, fields: { on: { click: { back: true } } } }], `«${picked.label || picked.node}» vuelve atrás`); }}
                onRemove={async () => { setPicked(undefined); setMode(null); await edit([{ op: 'set', id: picked.node, fields: { on: null } }], `quitar la interacción de «${picked.label || picked.node}»`); }}
              />
            )}
          </>
        )}
        {!story.build.ok && <div className="banner bad" role="alert"><strong>El último cambio no compiló.</strong> Se conserva la versión anterior. <code>{story.build.error}</code></div>}
        {guide && (
          <>
            <header className="bar">
              <div className="crumbs"><span className="muted">Guía</span><h1>{guide.title}</h1></div>
              <div className="tools"><button onClick={() => setDialog('guide-edit')}>Editar</button></div>
            </header>
            <Canvas frameRef={frame} src={`${BASE}g/${enc(guide.slug)}`} reload={guide.updatedAt} width={0} />
          </>
        )}
        {route.kind === 'compare' && <Compare story={story} group={route.group} reload={reload} />}
        {route.kind === 'none' && !story.prototypes.length && <div className="empty">Crea el primer prototipo con “+” en la barra lateral, o pídeselo al agente.</div>}
        <Dock
          disabled={offline || sending}
          sending={sending}
          preview={preview}
          noSession={!session}
          about={about}
          selected={selected}
          onClearSelected={() => setSelected(undefined)}
          agent={agent}
          pi={pi}
          now={now}
          messages={messages}
          threadOpen={threadOpen}
          setThreadOpen={setThreadOpen}
          send={async (text, attachments, artifact) => {
            setSending(true); setPreview(''); setThreadOpen(true);
            addMessage({ from: 'you', text, at: Date.now(), about, images: attachments.length || undefined });
            try {
              await api('__ask', { text, artifact, images: attachments.map(a => ({ data: a.data, mimeType: a.mimeType })), target: route.kind === 'proto' ? { prototype: route.id, page, node: selected?.node } : guide ? { guide: guide.slug } : {} });
              // Actual session events own the working state. An HTTP ack must
              // never overwrite a final reply or a completed agent event.
              scheduleRefresh();
            } catch (error) { addMessage({ from: 'agent', text: (error as Error).message, at: Date.now() }); setThreadOpen(true); }
            finally { setSending(false); }
          }}
          changePi={async change => { try { await api('__pi', change); } catch (error) { say((error as Error).message, true); } }}
        />
        {toast && <div className={`toast${toast.bad ? ' bad' : ''}`}>{toast.text}</div>}
      </main>
      {dialog === 'page' && proto && (
        <NewPage proto={proto} current={page} onClose={() => setDialog(null)} onCreate={async (title, flow, duplicate) => {
          setDialog(null);
          try { const r = await api<{ page: string }>('api/create_page', { prototype: proto.id, title, flow, duplicateOf: duplicate ? page : undefined }); location.hash = `#/p/${enc(proto.id)}/${enc(r.page)}`; say(`Página «${title}» creada`); }
          catch (error) { say((error as Error).message, true); }
        }} />
      )}
      {dialog === 'prototype' && (
        <NewPrototype groups={[...new Set(story.prototypes.map(p => p.group).filter(Boolean) as string[])]} onClose={() => setDialog(null)} onCreate={async (title, group) => {
          setDialog(null);
          try { const r = await api<{ prototype: string }>('api/create_prototype', { title, group }); location.hash = `#/p/${enc(r.prototype)}`; say(`Prototipo «${title}» creado`); }
          catch (error) { say((error as Error).message, true); }
        }} />
      )}
      {dialog === 'history' && proto && <History proto={proto} onClose={() => setDialog(null)} onRevert={async v => {
        try { await api('api/revert', { prototype: proto.id, version: v }); say(`Volviste a la versión ${v}`); setDialog(null); }
        catch (error) { say((error as Error).message, true); }
      }} />}
      {dialog === 'guide-edit' && guide && <GuideEditor guide={guide} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); say('Guía guardada'); reloadKey.current += 1; setReload(reloadKey.current); }} />}
    </div>
  );
}

// ---------- sidebar ----------

function Sidebar({ story, route, page, session, offline, onNewPrototype }: { story: Story; route: Route; page?: string; session: Session; offline: boolean; onNewPrototype: () => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, Proto[]>();
    for (const p of story.prototypes) map.set(p.group ?? '', [...(map.get(p.group ?? '') ?? []), p]);
    return [...map.entries()];
  }, [story.prototypes]);
  return (
    <aside className="sidebar" id="project-nav">
      <div className="brand">
        <div className="name">{story.project.name}</div>
        <div className={`pill ${session && !offline ? 'ok' : ''}`}><span className="dot" />{offline ? 'Sin conexión' : session ? `Pi conectado · ${session.label}` : 'Sin sesión de Pi'}</div>
      </div>
      <div className="section">Guía</div>
      {story.guides.map(g => <a key={g.slug} href={`#/g/${enc(g.slug)}`} className={route.kind === 'guide' && route.slug === g.slug ? 'item on' : 'item'}>{g.title}</a>)}
      <div className="section">Prototipos <button className="add" onClick={onNewPrototype} title="Nuevo prototipo">+</button></div>
      {story.problems.map(p => <div key={p} className="problem">⚠ {p}</div>)}
      {groups.map(([group, protos]) => (
        <div key={group || '_'}>
          {group && <div className="group">{group}{protos.length > 1 && <a href={`#/c/${enc(group)}`} className={route.kind === 'compare' && route.group === group ? 'cmp on' : 'cmp'}>Comparar</a>}</div>}
          {protos.map(p => {
            const active = route.kind === 'proto' && route.id === p.id;
            return (
              <div key={p.id}>
                <a href={`#/p/${enc(p.id)}`} className={active ? 'item on' : 'item'}><span>{p.title}</span><span className={`badge ${p.status}`}>{STATUS[p.status] ?? p.status}</span></a>
                {active && (
                  <div className="pages">
                    {p.flows.map(f => (
                      <div key={f.name || '_'}>
                        {f.name && <div className="flow">{f.name}</div>}
                        {f.pages.map(id => {
                          const pg = p.pages.find(x => x.id === id)!;
                          const out = p.interactions.filter(i => i.page === id && i.kind === 'go').length;
                          return <a key={id} href={`#/p/${enc(p.id)}/${enc(id)}`} className={page === id ? 'page on' : 'page'}>{pg.title}{out ? <span className="muted"> · {out}→</span> : null}</a>;
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

// ---------- canvas ----------

function Canvas({ frameRef, src, page, reload, width }: { frameRef: React.RefObject<HTMLIFrameElement | null>; src: string; page?: string; reload: number; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const last = useRef({ src: '', reload: -1 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const o = new ResizeObserver(fit);
    o.observe(el);
    return () => o.disconnect();
  }, []);
  useEffect(() => {
    const f = frameRef.current;
    if (!f) return;
    // Same document and only the page changed: a hash change, no reload.
    if (last.current.src === src && last.current.reload === reload) {
      try { if (page) f.contentWindow!.location.hash = page; return; } catch { /* fall through */ }
    }
    let hash = page ? `#${page}` : '';
    if (!page && last.current.src === src) { try { hash = f.contentWindow?.location.hash || hash; } catch { /* */ } }
    last.current = { src, reload };
    f.src = `${src}?v=${reload}${hash}`;
  }, [src, page, reload, frameRef]);
  const pad = size.w <= 760 ? 8 : 24;
  const scale = width && size.w ? Math.max(0.05, Math.min(1, (size.w - pad * 2) / width)) : 1;
  const style = width
    ? { width, flexShrink: 0, height: Math.max(1, size.h - pad) / scale, transform: `scale(${scale})`, transformOrigin: 'top center' }
    : { width: '100%', height: '100%' };
  return (
    <div className={width ? 'canvas framed' : 'canvas'} ref={box}>
      <iframe ref={frameRef} title="prototipo" style={style} className={width ? 'device' : ''} />
    </div>
  );
}

function Compare({ story, group, reload }: { story: Story; group: string; reload: number }) {
  const protos = story.prototypes.filter(p => (p.group ?? '') === group).slice(0, 4);
  return (
    <>
      <header className="bar"><div className="crumbs"><span className="muted">Comparar variantes</span><h1>{group}</h1></div></header>
      <div className="compare" style={{ gridTemplateColumns: `repeat(${protos.length}, minmax(0,1fr))` }}>
        {protos.map(p => <CompareCell key={p.id} proto={p} reload={reload} />)}
      </div>
    </>
  );
}

function CompareCell({ proto, reload }: { proto: Proto; reload: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  return (
    <div className="cell">
      <a href={`#/p/${enc(proto.id)}`} className="cell-title">{proto.title} <span className={`badge ${proto.status}`}>{STATUS[proto.status] ?? proto.status}</span></a>
      <Canvas frameRef={frame} src={`${BASE}${proto.url}`} reload={reload} width={390} />
    </div>
  );
}

// ---------- dialogs ----------

function Picker({ mode, picked, proto, onCancel, onGo, onNewPage, onToggle, onBack, onRemove }: {
  mode: 'link' | 'interact'; picked: Picked; proto: Proto; onCancel: () => void;
  onGo: (page: string) => void; onNewPage: (title: string) => void; onToggle: () => void; onBack: () => void; onRemove: () => void;
}) {
  const [newTitle, setNewTitle] = useState('');
  const label = picked.label || picked.node;
  return (
    <div className="picker">
      <div className="picker-head"><strong>«{label}»</strong><span className="muted"> · {picked.node}</span><button className="x" onClick={onCancel}>×</button></div>
      {picked.action && <div className="muted small">Ahora: {picked.action.go ? `va a ${proto.pages.find(p => p.id === picked.action!.go)?.title ?? picked.action.go}` : picked.action.toggle ? `muestra/oculta ${picked.action.toggle}` : 'vuelve atrás'}</div>}
      <div className="picker-label">{mode === 'link' ? '¿A qué página lleva?' : 'Ir a página'}</div>
      <div className="picker-list">
        {proto.flows.map(f => (
          <div key={f.name || '_'}>
            {f.name && <div className="flow">{f.name}</div>}
            {f.pages.filter(id => id !== picked.page).map(id => <button key={id} onClick={() => onGo(id)}>{proto.pages.find(p => p.id === id)?.title ?? id}</button>)}
          </div>
        ))}
      </div>
      <form className="row" onSubmit={e => { e.preventDefault(); if (newTitle.trim()) onNewPage(newTitle.trim()); }}>
        <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Nueva página…" />
        <button type="submit" disabled={!newTitle.trim()}>Crear y enlazar</button>
      </form>
      {mode === 'interact' && (
        <div className="row">
          <button onClick={onToggle}>Mostrar / ocultar algo</button>
          <button onClick={onBack}>Volver atrás</button>
        </div>
      )}
      {picked.action && <button className="danger" onClick={onRemove}>Quitar la interacción</button>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', on); return () => removeEventListener('keydown', on); }, [onClose]);
  return <div className="modal-back" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal"><div className="modal-head"><strong>{title}</strong><button className="x" onClick={onClose}>×</button></div>{children}</div></div>;
}

function NewPage({ proto, current, onClose, onCreate }: { proto: Proto; current?: string; onClose: () => void; onCreate: (title: string, flow: string | undefined, duplicate: boolean) => void }) {
  const flows = proto.flows.map(f => f.name).filter(Boolean);
  const [title, setTitle] = useState('');
  const [flow, setFlow] = useState(proto.pages.find(p => p.id === current)?.flow ?? '');
  const [duplicate, setDuplicate] = useState(false);
  return (
    <Modal title={`Nueva página en ${proto.title}`} onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); if (title.trim()) onCreate(title.trim(), flow.trim() || undefined, duplicate); }}>
        <label>Nombre<input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Pago" /></label>
        <label>Flujo<input value={flow} onChange={e => setFlow(e.target.value)} list="flows" placeholder="Compra (opcional)" /></label>
        <datalist id="flows">{flows.map(f => <option key={f} value={f} />)}</datalist>
        {current && <label className="check"><input type="checkbox" checked={duplicate} onChange={e => setDuplicate(e.target.checked)} /> Duplicar la página actual</label>}
        <button type="submit" className="primary" disabled={!title.trim()}>Crear página</button>
      </form>
    </Modal>
  );
}

function NewPrototype({ groups, onClose, onCreate }: { groups: string[]; onClose: () => void; onCreate: (title: string, group: string | undefined) => void }) {
  const [title, setTitle] = useState('');
  const [group, setGroup] = useState('');
  return (
    <Modal title="Nuevo prototipo" onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); if (title.trim()) onCreate(title.trim(), group.trim() || undefined); }}>
        <label>Nombre<input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="Checkout B" /></label>
        <label>Grupo<input value={group} onChange={e => setGroup(e.target.value)} list="groups" placeholder="Para variantes: mismo grupo (opcional)" /></label>
        <datalist id="groups">{groups.map(g => <option key={g} value={g} />)}</datalist>
        <button type="submit" className="primary" disabled={!title.trim()}>Crear prototipo</button>
      </form>
    </Modal>
  );
}

function History({ proto, onClose, onRevert }: { proto: Proto; onClose: () => void; onRevert: (v: number) => void }) {
  const [items, setItems] = useState<Array<{ v: number; at: string; by: string; did: string }>>();
  useEffect(() => { void api<typeof items>(`api/history?id=${enc(proto.id)}`).then(setItems).catch(() => setItems([])); }, [proto.id, proto.version]);
  return (
    <Modal title={`Versiones de ${proto.title}`} onClose={onClose}>
      <div className="history">
        {(items ?? []).map((h, i) => (
          <div key={h.v} className="version">
            <div><strong>v{h.v}</strong> <span>{h.did}</span><div className="muted small">{new Date(h.at).toLocaleString()} · {h.by === 'agent' ? 'agente' : h.by === 'person' ? 'tú' : h.by}</div></div>
            {i > 0 && <button onClick={() => onRevert(h.v)}>Volver aquí</button>}
          </div>
        ))}
        {!items && <div className="muted">Cargando…</div>}
      </div>
    </Modal>
  );
}

function GuideEditor({ guide, onClose, onSaved }: { guide: Guide; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { void api<{ markdown: string }>(`api/guide?slug=${enc(guide.slug)}`).then(r => setText(r.markdown)).catch(e => setError(e.message)); }, [guide.slug]);
  const generated = text?.includes('<!-- proto:auto:start -->');
  return (
    <Modal title={`Editar · ${guide.title}`} onClose={onClose}>
      {generated && <div className="muted small">La parte entre las marcas <code>proto:auto</code> se regenera sola; lo que escribas fuera se respeta.</div>}
      {error && <div className="bad">{error}</div>}
      <textarea className="editor" value={text ?? ''} onChange={e => setText(e.target.value)} spellCheck={false} />
      <div className="row end"><button onClick={onClose}>Cancelar</button><button className="primary" disabled={text === undefined} onClick={async () => { try { await api('api/write_guide', { slug: guide.slug, markdown: text }); onSaved(); } catch (e) { setError((e as Error).message); } }}>Guardar</button></div>
    </Modal>
  );
}

// ---------- composer ----------

const MAX_SIDE = 1800;
const readImage = (file: File): Promise<Attachment | undefined> => new Promise(resolve => {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { resolve(undefined); return; }
  const reader = new FileReader();
  reader.onerror = () => resolve(undefined);
  reader.onload = () => {
    const url = String(reader.result);
    const img = new Image();
    img.onerror = () => resolve(undefined);
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const keep = scale === 1 || file.type === 'image/gif';
      const mimeType = keep ? file.type : file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const out = keep ? url : (() => { const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale); c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height); return c.toDataURL(mimeType, 0.9); })();
      resolve({ url: out, data: out.slice(out.indexOf(',') + 1), mimeType, name: file.name || 'imagen' });
    };
    img.src = url;
  };
  reader.readAsDataURL(file);
});

function Dock({ disabled, sending, preview, noSession, about, selected, onClearSelected, agent, pi, now, messages, threadOpen, setThreadOpen, send, changePi }: {
  disabled: boolean; sending: boolean; preview: string; noSession: boolean; about?: string; selected?: Picked; onClearSelected: () => void; agent: Agent; pi?: PiState; now: number;
  messages: Message[]; threadOpen: boolean; setThreadOpen: (v: boolean) => void;
  send: (text: string, attachments: Attachment[], artifact?: string) => Promise<void>; changePi: (change: Record<string, unknown>) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [artifact, setArtifact] = useState('auto');
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const working = agent.state === 'working';
  const lastAgent = [...messages].reverse().find(m => m.from === 'agent');
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }, [text]);
  const add = async (files: FileList | File[]) => {
    const images = (await Promise.all([...files].map(readImage))).filter((a): a is Attachment => !!a);
    setAttachments(list => [...list, ...images].slice(0, 6));
  };
  const submit = async () => {
    const value = text.trim();
    if ((!value && !attachments.length) || disabled) return;
    const sending = attachments;
    setText(''); setAttachments([]);
    await send(value, sending, artifact === 'auto' ? undefined : artifact);
  };
  const models = useMemo(() => {
    const map = new Map<string, PiState['models']>();
    for (const m of pi?.models ?? []) map.set(m.provider, [...(map.get(m.provider) ?? []), m]);
    return [...map.entries()];
  }, [pi?.models]);
  return (
    <div className="dock" onDragOver={e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) e.preventDefault(); }} onDrop={e => { e.preventDefault(); void add(e.dataTransfer.files); }}>
      {threadOpen && (
        <div className="thread">
          <div className="thread-head"><strong>Conversación</strong><button className="x" onClick={() => setThreadOpen(false)}>×</button></div>
          <div className="thread-list">
            {messages.length === 0 && <div className="muted small">Lo que escribas llega a tu sesión de Pi, con la página y el elemento que tienes seleccionados.</div>}
            {messages.map((m, i) => <div key={i} className={`bubble ${m.from}`}>{m.about && m.from === 'you' ? <div className="about">{m.about}</div> : null}{m.text}{m.images ? <div className="about">{m.images} imagen{m.images > 1 ? 'es' : ''}</div> : null}</div>)}
            {preview && <div className="bubble agent" aria-live="polite">{preview}</div>}
          </div>
        </div>
      )}
      <div className={`status${working ? ' working' : ''}`} aria-live="polite">
        {sending ? <><span className="spin" /><strong>Enviando…</strong></> : working
          ? <><span className="spin" /> <strong>{agent.step ?? 'Trabajando'}</strong><span className="muted"> · {elapsed(agent.startedAt, now)}</span><button className="stop" onClick={() => void changePi({ abort: true })}>Detener</button></>
          : lastAgent ? <button className="last" onClick={() => setThreadOpen(!threadOpen)}>{lastAgent.text.split('\n')[0]}</button>
          : <span className="muted">{noSession ? 'Puedes abrir páginas y deshacer. Para diseñar, abre Pi en la carpeta del proyecto.' : 'El agente está listo.'}</span>}
        {!working && messages.length > 0 && <button className="link" onClick={() => setThreadOpen(!threadOpen)}>{threadOpen ? 'Ocultar' : `Conversación (${messages.length})`}</button>}
      </div>
      {agent.usage && <div className="run-usage" aria-label="Task usage">
        <span>{agent.usage.calls}{agent.limits ? `/${agent.limits.calls}` : ''} model calls</span>
        <span>{agent.usage.tools}{agent.limits ? `/${agent.limits.tools}` : ''} tool calls</span>
        <span title={`${agent.usage.input.toLocaleString()} uncached input · ${agent.usage.output.toLocaleString()} output · ${agent.usage.cacheRead.toLocaleString()} cached input`}>{(agent.usage.input + agent.usage.output).toLocaleString()} new tokens · {agent.usage.cacheRead.toLocaleString()} cached</span>
        {agent.stopped && <strong>Stopped: {agent.stopped}</strong>}
      </div>}
      <div className="composer">
        {selected && <span className="chip">Sobre «{selected.label || selected.node}» <button onClick={onClearSelected}>×</button></span>}
        {attachments.map((a, i) => <span key={i} className="thumb"><img src={a.url} alt="" /><button onClick={() => setAttachments(list => list.filter((_, j) => j !== i))}>×</button></span>)}
        <textarea ref={input} rows={1} value={text} disabled={disabled}
          aria-label="Mensaje para Pi"
          placeholder={sending ? 'Enviando…' : disabled ? 'Sin conexión' : noSession ? 'Abre una página o deshaz el último cambio…' : `Pídele al agente${about ? ` sobre ${about}` : ''}…`}
          onChange={e => setText(e.target.value)}
          onPaste={e => { const files = [...e.clipboardData.files].filter(f => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); void add(files); } }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => { if (e.target.files) void add(e.target.files); e.target.value = ''; }} />
        <button className="icon" disabled={disabled} onClick={() => picker.current?.click()} title="Adjuntar imagen (o pégala / arrástrala)">＋</button>
        <select aria-label="Deliverable" value={artifact} disabled={disabled} onChange={e => setArtifact(e.target.value)} title="Choose the deliverable; asking for a guide or tokens does not authorize screens">
          <option value="auto">Follow message</option><option value="guide">Design guide</option><option value="tokens">Tokens only</option><option value="prototype">Screen / design</option>
        </select>
        <select disabled={disabled || !pi} value={pi?.model ? `${pi.model.provider}/${pi.model.id}` : ''} title="Modelo de tu sesión de Pi"
          onChange={e => { const [provider, ...rest] = e.target.value.split('/'); void changePi({ model: { provider, id: rest.join('/') } }); }}>
          {!pi?.model && <option value="">Modelo</option>}
          {models.map(([provider, list]) => <optgroup key={provider} label={provider}>{list.map(m => <option key={m.id} value={`${provider}/${m.id}`}>{m.name}</option>)}</optgroup>)}
        </select>
        <select disabled={disabled || !pi} value={pi?.thinking ?? ''} title="Thinking" onChange={e => void changePi({ thinking: e.target.value })}>
          {(pi?.levels ?? []).map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button className="send" disabled={disabled || (!text.trim() && !attachments.length)} onClick={() => void submit()}>Enviar</button>
      </div>
      {pi?.error && <div className="bad small pad">{pi.error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
