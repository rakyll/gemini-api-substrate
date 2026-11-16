'use strict';

// ===========================================================================
// Gemini Agents × Agent Substrate — live demo UI
// All DOM is built with createElement/createElementNS + textContent (no
// innerHTML) so model output and tool output can never inject markup.
// ===========================================================================

const SVGNS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'substrate-demo-v1';
const IDLE_TIMEOUT_S = 15; // matches controller --worker-idle-timeout=15s (sweeps every 7.5s)
const COLORS = ['#4c8dff', '#e86fa6', '#f5a623', '#34d399', '#9b72f2', '#22d3ee', '#f87171', '#a3e635'];
const C = { app: '#ffd479', gemini: '#4c8dff', ctrl: '#9b72f2', sub: '#34d399', actor: '#e86fa6', ice: '#67d4ff' };

const EGRESS_LABEL = { default: 'egress: default-deny (Gemini API only)', dev: 'egress: PyPI + GitHub allowed' };

const SCENARIOS = [
  { label: '🔍 Where am I?', prompt: 'Run `uname -a`, `id`, and `grep Cap /proc/self/status` in bash. Then, in two short sentences, explain what kind of sandbox you are running in and what privileges you have.' },
  { label: '🐍 Write & run code', prompt: 'Write /workspace/primes.py that prints the first 25 prime numbers, run it with python3, and show the output.' },
  { label: '💾 Did my files survive?', prompt: 'List the files in /workspace with sizes and modification times, and print the contents of any .py files there. Be brief.' },
  { label: '🌐 Test egress', prompt: 'Using curl with a 5 second timeout, request https://example.com and https://pypi.org/simple/ and report only the HTTP status code or error for each, as a small table.' },
  { label: '📦 Clone from GitHub', prompt: "In bash: `git clone --depth 1 https://github.com/google-gemini/gemini-api-cli /workspace/gemini-api-cli` and count its .go files; get the latest `requests` version from https://pypi.org/pypi/requests/json; and try `curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com`. Summarize what was allowed vs blocked." },
];

// ---------------------------------------------------------------------------
// State

const S = {
  config: {},
  cluster: { actors: [], workers: [], controller: null },
  prevActors: new Map(),
  sessions: [],
  activeId: null,
  nextNum: 1,
};

function save() {
  const data = {
    nextNum: S.nextNum,
    activeId: S.activeId,
    sessions: S.sessions.map((s) => ({
      id: s.id, name: s.name, color: s.color, envId: s.envId, egress: s.egress,
      lastActivity: s.lastActivity,
      items: s.items.map(({ _el, ...rest }) => rest),
    })),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* quota */ }
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data) return;
    S.nextNum = data.nextNum || 1;
    S.activeId = data.activeId;
    S.sessions = (data.sessions || []).map((s) => ({ ...s, busy: false, steps: {}, items: s.items || [] }));
    for (const s of S.sessions) for (const it of s.items) if (it.status === 'running') it.status = 'unknown';
  } catch (_) { /* ignore corrupt storage */ }
}

function newSession(egress = 'default', name) {
  const n = S.nextNum++;
  const s = {
    id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || `Sandbox ${n}`,
    color: COLORS[(n - 1) % COLORS.length],
    envId: '', egress, items: [], busy: false, steps: {}, lastActivity: 0,
  };
  S.sessions.push(s);
  save();
  return s;
}

const active = () => S.sessions.find((s) => s.id === S.activeId);
const sessionByEnv = (envId) => envId && S.sessions.find((s) => s.envId === envId);
const actorForSession = (s) => s && s.envId && S.cluster.actors.find((a) => a.envId === s.envId);
const shortId = (id) => (id || '').slice(0, 8);
const envLabel = (s) => (s && s.envId ? `env ${shortId(s.envId)}` : 'new environment');
const podShort = (name) => (name || '').split('-').slice(-1)[0];
const isTrans = (st) => st && st !== 'RUNNING' && st !== 'SUSPENDED';

// ---------------------------------------------------------------------------
// DOM helpers

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) e.style.setProperty(sk, sv);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function svg(tag, attrs = {}, ...children) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) e.append(c);
  return e;
}

const $ = (id) => document.getElementById(id);

// Minimal, safe markdown: ``` fences, `inline code`, **bold**, [text](url)->text.
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const parts = (text || '').split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      frag.append(el('pre', {}, el('code', { text: body.replace(/\n$/, '') })));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = el('p');
      const clean = para.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      for (const tok of clean.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
        if (!tok) continue;
        if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 1) p.append(el('code', { text: tok.slice(1, -1) }));
        else if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 3) p.append(el('b', { text: tok.slice(2, -2) }));
        else p.append(document.createTextNode(tok));
      }
      frag.append(p);
    }
  });
  return frag;
}

// ---------------------------------------------------------------------------
// Timeline

function timeline(tag, msg) {
  const ol = $('timeline');
  const t = new Date().toLocaleTimeString([], { hour12: false });
  ol.prepend(el('li', {}, el('span', { class: 't', text: t }), el('span', { class: `tag ${tag}`, text: tag.toUpperCase() }), el('span', { class: 'msg', text: msg })));
  while (ol.children.length > 300) ol.lastChild.remove();
  $('tl-latest').textContent = `${t}  ${msg}`;
}

function toggleTimeline(open) {
  const panel = $('timeline-panel');
  const expand = open === undefined ? panel.classList.contains('collapsed') : open;
  panel.classList.toggle('collapsed', !expand);
  $('tl-toggle').setAttribute('aria-expanded', String(expand));
}

// ---------------------------------------------------------------------------
// Architecture diagram

const A = { edges: {}, nodes: {}, layers: {}, actorEls: new Map(), podKey: '', podSlots: new Map() };

const GEOM = {
  pool: { x: 565, y: 166, w: 405, h: 562 },
  shelf: { x: 40, y: 398, w: 485, h: 330 },
  chip: { w: 145, h: 54 },
};

function buildArch() {
  const root = svg('svg', { viewBox: '0 0 1000 760', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Live architecture diagram' });

  root.append(svg('rect', { class: 'cluster', x: 14, y: 128, width: 972, height: 626, rx: 8 }));
  A.clusterLabel = svg('text', { class: 'cluster-label', x: 30, y: 748, text: 'CLUSTER · AGENT SUBSTRATE v1' });
  root.append(A.clusterLabel);

  const p = GEOM.pool, sh = GEOM.shelf;
  root.append(svg('rect', { class: 'pool', x: p.x, y: p.y, width: p.w, height: p.h, rx: 6 }));
  root.append(svg('image', { href: 'icons/workerpool.svg', x: p.x + 12, y: p.y + 8, width: 16, height: 16 }));
  root.append(svg('text', { class: 'pool-label', x: p.x + 34, y: p.y + 20, text: 'WORKERPOOL' }));
  root.append(svg('rect', { class: 'snap', x: sh.x, y: sh.y, width: sh.w, height: sh.h, rx: 6 }));
  root.append(svg('image', { href: 'icons/snapshots.svg', x: sh.x + 12, y: sh.y + 8, width: 16, height: 16 }));
  root.append(svg('text', { class: 'snap-label', x: sh.x + 34, y: sh.y + 20, text: 'SNAPSHOTS' }));

  const edges = svg('g');
  const edgeDefs = [
    ['app-gemini', 'M260,58 L740,58', 'CreateInteraction  ⇄  SSE stream', 500, 50, 'middle'],
    ['gemini-ctrl', 'M790,92 C 770,150 430,118 300,192', 'LeaseInteractions (API key)', 470, 140, 'middle'],
    ['ctrl-api', 'M170,236 L170,290', 'provision', 180, 268, 'start'],
    ['ctrl-router', 'M300,214 C 390,214 435,240 435,290', 'StartWork · mTLS', 395, 230, 'start'],
    ['router-pool', 'M525,321 L565,321', '', 0, 0, 'start'],
    ['pool-gemini', 'M920,166 L920,92', 'bidi stream (lease token)', 912, 134, 'end'],
    ['pool-snap', 'M565,563 L525,563', '', 0, 0, 'start'],
  ];
  for (const [id, d] of edgeDefs) {
    const path = svg('path', { class: 'edge', d, id: `edge-${id}` });
    A.edges[id] = path;
    edges.append(path);
  }
  root.append(edges);

  const nodeDefs = [
    ['app', 30, 24, 230, 68, 'logo:icons/application.svg', 'Application'],
    ['gemini', 740, 24, 230, 68, 'logo:gemini-color.svg', 'Gemini API'],
    ['ctrl', 40, 166, 260, 70, 'logo:icons/controller.svg', 'gemini-substrate-controller'],
    ['api', 40, 290, 260, 62, 'logo:icons/api-server.svg', 'ate-api-server'],
    ['router', 345, 290, 180, 62, 'logo:icons/router.svg', 'atenet-router'],
  ];
  for (const [id, x, y, w, h, icon, title] of nodeDefs) {
    const iconEl = icon.startsWith('logo:')
      ? svg('image', { href: icon.slice(5), x: x + 13, y: y + h / 2 - 11, width: 22, height: 22 })
      : svg('text', { class: 'icon', x: x + 14, y: y + h / 2 + 6, text: icon });
    const g = svg('g', { class: 'node', id: `node-${id}` },
      svg('rect', { class: 'box', x, y, width: w, height: h, rx: 6 }),
      iconEl,
      svg('text', { class: 'title', x: x + 44, y: y + h / 2 + 5, text: title }));
    A.nodes[id] = g;
    root.append(g);
  }

  A.layers.pods = svg('g');
  A.layers.actors = svg('g');
  A.layers.packets = svg('g');
  root.append(A.layers.pods, A.layers.actors, A.layers.packets);
  $('arch').append(root);
}

function hot(nodeId, ms = 900) {
  const n = A.nodes[nodeId];
  if (!n) return;
  n.classList.add('hot');
  clearTimeout(n._t);
  n._t = setTimeout(() => n.classList.remove('hot'), ms);
}

function pulse(edgeId, { reverse = false, color = C.ctrl, label = '', dur = 950, delay = 0 } = {}) {
  setTimeout(() => {
    const path = A.edges[edgeId];
    if (!path || document.hidden) return;
    const len = path.getTotalLength();
    const dot = svg('circle', { r: 6, fill: color });
    const g = svg('g', { class: 'packet' }, dot);
    g.style.color = color;
    let txt;
    if (label) { txt = svg('text', { class: 'packet-label', fill: color, text: label }); g.append(txt); }
    A.layers.packets.append(g);
    path.classList.add('hot');
    path._n = (path._n || 0) + 1;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const pt = path.getPointAtLength((reverse ? 1 - e : e) * len);
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
      if (txt) { txt.setAttribute('x', pt.x + 9); txt.setAttribute('y', pt.y - 9); }
      if (t < 1) requestAnimationFrame(step);
      else {
        g.remove();
        if (--path._n <= 0) path.classList.remove('hot');
      }
    };
    requestAnimationFrame(step);
  }, delay);
}

function podSlots(workers) {
  const p = GEOM.pool;
  const n = Math.max(1, Math.min(workers.length, 8));
  const rows = Math.ceil(n / 2);
  const gap = 12, top = p.y + 32;
  const slotW = (p.w - 28 - 11) / 2;
  const slotH = Math.min(260, (p.h - 44 - (rows - 1) * gap) / rows);
  const slots = new Map();
  workers.slice(0, 8).forEach((w, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    slots.set(w.name, { x: p.x + 14 + col * (slotW + 11), y: top + row * (slotH + gap), w: slotW, h: slotH, pod: w });
  });
  return slots;
}

function renderPods() {
  const workers = S.cluster.workers.filter((w) => !w.deleting);
  const key = workers.map((w) => `${w.name}:${w.ready}`).join('|');
  if (key === A.podKey) return;
  A.podKey = key;
  A.podSlots = podSlots(workers);
  const layer = A.layers.pods;
  layer.replaceChildren();
  for (const [name, s] of A.podSlots) {
    layer.append(svg('g', { class: `pod ${s.pod.ready ? 'ready' : ''}` },
      svg('rect', { class: 'podbox', x: s.x, y: s.y, width: s.w, height: s.h, rx: 6 }),
      svg('text', { class: 'podname', x: s.x + 10, y: s.y + 17, text: name })));
  }
}

function actorLabel(a) {
  const s = sessionByEnv(a.envId);
  return { name: `env ${shortId(a.envId)}`, color: s ? s.color : '#64748b', session: s };
}

function idleRemaining(s) {
  if (!s || s.busy || !s.lastActivity) return null;
  return Math.round(IDLE_TIMEOUT_S - (Date.now() - s.lastActivity) / 1000);
}

function stateText(a, s) {
  if (a.state === 'RUNNING') {
    if (s && s.busy) return 'RUNNING · working';
    const r = idleRemaining(s);
    if (r !== null) return r > 0 ? `RUNNING · idle, suspends ~${r}s` : 'RUNNING · suspending soon';
    return 'RUNNING';
  }
  return a.state;
}

function renderActors() {
  const seen = new Set();
  const suspended = S.cluster.actors.filter((a) => !a.workerPod || a.state === 'SUSPENDED');
  const { chip, shelf } = GEOM;

  for (const a of S.cluster.actors) {
    seen.add(a.name);
    let x, y;
    const slot = a.state !== 'SUSPENDED' && a.workerPod && A.podSlots.get(a.workerPod);
    if (slot) {
      x = slot.x + (slot.w - chip.w) / 2;
      y = slot.y + Math.max(26, (slot.h - chip.h) / 2 + 6);
    } else {
      const i = suspended.indexOf(a);
      const col = i % 3, row = Math.floor(i / 3) % 4;
      x = shelf.x + 14 + col * (chip.w + 8);
      y = shelf.y + 32 + row * (chip.h + 10) + Math.floor(i / 12) * 4;
    }
    const { name, color, session } = actorLabel(a);
    let g = A.actorEls.get(a.name);
    if (!g) {
      g = svg('g', { class: 'actor' });
      g._rect = svg('rect', { class: 'chipbox', width: chip.w, height: chip.h, rx: 6 });
      g._swatch = svg('rect', { x: 10, y: 12, width: 10, height: 10, rx: 3 });
      g._name = svg('text', { class: 'aname', x: 27, y: 22 });
      g._state = svg('text', { class: 'astate', x: 10, y: 42 });
      g.append(g._rect, g._swatch, g._name, g._state);
      g.style.transform = `translate(${x}px, ${y - 30}px)`;
      g.style.opacity = '0';
      A.layers.actors.append(g);
      A.actorEls.set(a.name, g);
      g.getBoundingClientRect(); // force layout so the entrance animates
      g.style.transition = 'transform .9s cubic-bezier(.2,.8,.2,1), opacity .5s';
    }
    const stateCls = a.state === 'RUNNING' ? 'RUNNING' : a.state === 'SUSPENDED' ? 'SUSPENDED' : 'trans';
    g.setAttribute('class', `actor ${stateCls}${g.classList.contains('flash') ? ' flash' : ''}`);
    const stroke = stateCls === 'RUNNING' ? '#34d399' : stateCls === 'SUSPENDED' ? '#67d4ff' : '#fbbf24';
    g._rect.setAttribute('fill', color + '2e');
    g._rect.setAttribute('stroke', stroke);
    g._swatch.setAttribute('fill', color);
    g._name.textContent = name;
    g._state.setAttribute('fill', stroke);
    g._state.textContent = stateText(a, session);
    g.style.transform = `translate(${x}px, ${y}px)`;
    g.style.opacity = '1';
  }
  for (const [name, g] of A.actorEls) {
    if (!seen.has(name)) { g.style.opacity = '0'; setTimeout(() => g.remove(), 600); A.actorEls.delete(name); }
  }
  const occupied = new Set(S.cluster.actors.filter((a) => a.state !== 'SUSPENDED' && a.workerPod).map((a) => a.workerPod));
  for (const [name, slot] of A.podSlots) if (slot.warmEl) slot.warmEl.style.display = occupied.has(name) ? 'none' : '';
}

function flashActor(session) {
  const a = actorForSession(session);
  const g = a && A.actorEls.get(a.name);
  if (!g) return;
  g.classList.add('flash');
  clearTimeout(g._ft);
  g._ft = setTimeout(() => g.classList.remove('flash'), 500);
}

// ---------------------------------------------------------------------------
// Cluster + controller events (from /api/events)

function onCluster(view) {
  const prev = S.prevActors;
  const next = new Map();
  for (const a of view.actors) {
    next.set(a.name, a);
    const old = prev.get(a.name);
    const { name } = actorLabel(a);
    if (prev.size || S._clusterSeen) {
      if (!old) {
        timeline('substrate', `Actor created for ${name} (${a.name.slice(0, 22)}…) → ${a.state}${a.workerPod ? ' on pod …' + podShort(a.workerPod) : ''}`);
        hot('api');
      } else if (old.state !== a.state) {
        if (a.state === 'SUSPENDED') {
          timeline('snapshot', `${name}: ${old.state} → SUSPENDED · memory snapshot checkpointed, pod released`);
          pulse('pool-snap', { color: C.ice, label: 'checkpoint', dur: 1100 });
        } else if (old.state === 'SUSPENDED') {
          timeline('snapshot', `${name}: SUSPENDED → ${a.state} · restoring from snapshot${a.workerPod ? ' onto pod …' + podShort(a.workerPod) : ''}`);
          pulse('pool-snap', { color: C.ice, label: 'restore', reverse: true, dur: 1100 });
        } else {
          timeline('substrate', `${name}: ${old.state} → ${a.state}${a.workerPod ? ' (pod …' + podShort(a.workerPod) + ')' : ''}`);
        }
      }
    }
  }
  if (S._clusterSeen) for (const [n, a] of prev) if (!next.has(n)) timeline('substrate', `Actor deleted: ${actorLabel(a).name}`);
  S._clusterSeen = true;
  S.prevActors = next;
  S.cluster = view;
  renderCluster();
}

function renderCluster() {
  const v = S.cluster;
  if (v.context) {
    $('chip-context').replaceChildren('cluster ', el('b', { text: v.context }), ' · atespace ', el('b', { text: S.config.atespace || '…' }));
    A.clusterLabel.textContent = `CLUSTER · ${v.context} · AGENT SUBSTRATE v1 · atespace ${S.config.atespace || ''}`;
  }
  setChip('chip-controller', v.controller && v.controller.ready, 'controller', v.controller ? (v.controller.ready ? 'ready' : v.controller.phase) : 'missing');
  const ready = v.workers.filter((w) => w.ready).length;
  setChip('chip-pool', ready > 0, 'pool', `${ready}/${v.workers.length} warm`);
  const running = v.actors.filter((a) => a.state === 'RUNNING').length;
  const susp = v.actors.filter((a) => a.state === 'SUSPENDED').length;
  const chip = $('chip-actors');
  chip.replaceChildren('actors ', el('b', { text: String(running) }), ' running · ', el('b', { text: String(susp) }), ' suspended');
  renderPods();
  renderActors();
  renderTabs();
  renderSessionHead();
}

function setChip(id, ok, label, value) {
  const c = $(id);
  c.classList.toggle('ok', !!ok);
  c.classList.toggle('bad', !ok);
  c.replaceChildren(el('i', { class: 'dot' }), `${label} `, el('b', { text: value }));
}

function onController(ev) {
  const s = sessionByEnv(ev.envId);
  const who = ev.envId ? `env ${shortId(ev.envId)}` : (s ? envLabel(s) : '');
  switch (ev.kind) {
    case 'lease':
      timeline('controller', `LeaseInteractions → claimed lease for ${who}`);
      pulse('gemini-ctrl', { color: C.ctrl, label: 'lease', dur: 1000 });
      hot('ctrl', 1400);
      if (s) setThinking(s, 'Lease claimed · provisioning actor…');
      break;
    case 'dispatch':
      timeline('controller', `ate-gemini provision → CreateActor / ResumeActor, then WorkerService.StartWork for ${who}`);
      pulse('ctrl-api', { color: C.sub, label: 'CreateActor/Resume', dur: 700 });
      pulse('ctrl-router', { color: C.ctrl, label: 'StartWork', dur: 800, delay: 450 });
      pulse('router-pool', { color: C.ctrl, dur: 400, delay: 1250 });
      hot('api'); setTimeout(() => hot('router'), 500);
      if (s) setThinking(s, 'Actor started · agent thinking…');
      break;
    case 'suspend':
      timeline('controller', `Idle sweeper: ${who} idle > ${IDLE_TIMEOUT_S}s → SuspendActor`);
      pulse('ctrl-api', { color: C.ice, label: 'Suspend', dur: 700 });
      hot('ctrl'); hot('api');
      break;
    default:
      if (ev.line && ev.line.trim()) timeline('controller', ev.line.replace(/^time=\S+\s+/, '').slice(0, 300));
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => setChip('chip-live', true, 'live', ''));
  es.addEventListener('error', () => setChip('chip-live', false, 'live', 'reconnecting'));
  es.addEventListener('cluster', (e) => { try { onCluster(JSON.parse(e.data)); } catch (_) { /* ignore */ } });
  es.addEventListener('controller', (e) => { try { onController(JSON.parse(e.data)); } catch (_) { /* ignore */ } });
}

// ---------------------------------------------------------------------------
// Sessions UI

function renderTabs() {
  const tabs = $('tabs');
  const add = $('btn-new');
  const nodes = S.sessions.map((s) => {
    const a = actorForSession(s);
    const st = a ? (isTrans(a.state) ? 'trans' : a.state) : '';
    return el('button', { class: `tab ${s.id === S.activeId ? 'active' : ''}`, type: 'button', on: { click: () => switchTo(s.id) } },
      el('span', { class: 'swatch', style: { background: s.color } }),
      envLabel(s),
      el('span', { class: `state-dot ${st}`, title: a ? a.state : 'no actor' }),
      el('span', { class: 'close', title: 'Close tab (actor is kept)', text: '×', on: { click: (e) => { e.stopPropagation(); closeSession(s.id); } } }));
  });
  tabs.replaceChildren(...nodes, add);
}

function renderSessionHead() {
  const s = active();
  const show = !!s;
  $('session-head').hidden = !show;
  if (!s) return;
  const a = actorForSession(s);
  $('sess-swatch').style.background = s.color;
  $('sess-name').textContent = s.envId ? `env ${s.envId}` : 'new environment';
  const badge = $('sess-state');
  badge.className = 'badge ' + (a ? (isTrans(a.state) ? 'trans' : a.state) : '');
  badge.textContent = a ? a.state : s.envId ? 'actor pending' : 'not created yet';
  $('sess-egress').textContent = EGRESS_LABEL[s.egress] || '';
  const r = a && a.state === 'RUNNING' ? idleRemaining(s) : null;
  $('sess-idle').textContent = s.busy ? 'turn in progress…' : r !== null ? (r > 0 ? `idle · auto-suspend in ~${r}s` : 'auto-suspend imminent') : '';
  $('btn-suspend').disabled = !(a && a.state === 'RUNNING' && !s.busy);
  $('btn-run').disabled = s.busy;
  for (const b of document.querySelectorAll('.scenario')) b.disabled = s.busy;
}

function switchTo(id) {
  S.activeId = id;
  $('new-sandbox').hidden = true;
  save();
  renderTabs();
  renderTranscript();
  renderSessionHead();
}

function closeSession(id) {
  const i = S.sessions.findIndex((s) => s.id === id);
  if (i < 0 || S.sessions[i].busy) return;
  S.sessions.splice(i, 1);
  if (S.activeId === id) S.activeId = S.sessions.length ? S.sessions[Math.max(0, i - 1)].id : null;
  if (!S.sessions.length) S.activeId = newSession().id;
  save();
  switchTo(S.activeId);
  renderActors();
}

// ---------------------------------------------------------------------------
// Transcript rendering

function renderItem(item, session) {
  switch (item.type) {
    case 'user':
      return el('div', { class: 'msg-user', text: item.text });
    case 'text': {
      const d = el('div', { class: 'msg-model' });
      d.append(renderMarkdown(item.text));
      return d;
    }
    case 'tool':
      return renderTool(item, session);
    case 'meta':
      return el('div', { class: 'turn-meta', text: item.text });
    case 'error':
      return el('div', { class: 'error', text: '⚠ ' + item.text });
    default:
      return el('div');
  }
}

function toolCommand(item) {
  let args = item.args;
  if (!args && item.argsStr) { try { args = JSON.parse(item.argsStr); } catch (_) { return item.argsStr; } }
  if (!args) return '';
  if (typeof args.command === 'string') return args.command;
  if (args.TargetFile || args.CodeContent) {
    const code = String(args.CodeContent || '');
    return `cat > ${args.TargetFile || '?'} <<'EOF'\n${code.length > 1200 ? code.slice(0, 1200) + '\n…' : code}\nEOF`;
  }
  const s = JSON.stringify(args, null, 1);
  return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
}

function renderTool(item, session) {
  const a = actorForSession(session);
  const head = el('div', { class: 'tool-head' },
    item.status === 'running' ? el('span', { class: 'spinner' }) : null,
    el('span', { text: '⚡' }), el('span', { class: 'name', text: item.name || 'tool' }));
  if (item.result) {
    const ec = item.result.exit_code;
    const ok = !item.isError && (ec === undefined || ec === 0);
    head.append(el('span', { class: `exit ${ok ? 'ok' : 'err'}`, text: ec !== undefined ? `exit ${ec}` : ok ? 'ok' : 'error' }));
  }
  head.append(el('span', { class: 'where', text: item.where || (a ? `in actor · pod …${podShort(a.workerPod)}` : 'in sandbox') }));
  const box = el('div', { class: 'tool' }, head, el('pre', { class: 'cmd', text: toolCommand(item) || '…' }));
  if (item.result) {
    const r = item.result;
    let out = '';
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') out = (r.stdout || '').replace(/\n$/, '');
    else out = JSON.stringify(r, null, 1);
    if (out.length > 4000) out = out.slice(0, 4000) + '\n…';
    if (out) box.append(el('pre', { class: 'out', text: out }));
    if (r.stderr) box.append(el('pre', { class: 'out stderr', text: String(r.stderr).slice(0, 2000) }));
  }
  return box;
}

function renderTranscript() {
  const tr = $('transcript');
  const s = active();
  tr.replaceChildren();
  if (!s) return;
  if (!s.items.length) {
    tr.append(el('div', { class: 'empty' },
      el('div', { class: 'big', text: '✦' }),
      el('div', { text: 'Pick a scenario below or type a prompt.' }),
      el('div', { text: 'The first turn creates a fresh gVisor actor through Agent Substrate; the agent\'s tools run there — not on Google\'s servers.' })));
  }
  for (const it of s.items) { it._el = renderItem(it, s); tr.append(it._el); }
  if (s.busy && s._thinking) { s._thinkEl = thinkingEl(s._thinking); tr.append(s._thinkEl); }
  tr.scrollTop = tr.scrollHeight;
}

function thinkingEl(label) {
  return el('div', { class: 'thinking' }, el('span', { class: 'bars' }, el('i'), el('i'), el('i')), el('span', { text: label }));
}

function setThinking(s, label) {
  s._thinking = label;
  if (s.id !== S.activeId) return;
  const tr = $('transcript');
  if (s._thinkEl) s._thinkEl.remove();
  s._thinkEl = null;
  if (label && s.busy) { s._thinkEl = thinkingEl(label); tr.append(s._thinkEl); tr.scrollTop = tr.scrollHeight; }
}

function pushItem(s, item) {
  s.items.push(item);
  if (s.id === S.activeId) {
    const tr = $('transcript');
    const empty = tr.querySelector('.empty');
    if (empty) empty.remove();
    item._el = renderItem(item, s);
    if (s._thinkEl) tr.insertBefore(item._el, s._thinkEl); else tr.append(item._el);
    tr.scrollTop = tr.scrollHeight;
  }
  return item;
}

function updateItem(s, item) {
  if (s.id !== S.activeId || !item._el) return;
  const fresh = renderItem(item, s);
  item._el.replaceWith(fresh);
  item._el = fresh;
  const tr = $('transcript');
  if (tr.scrollHeight - tr.scrollTop - tr.clientHeight < 200) tr.scrollTop = tr.scrollHeight;
}

// ---------------------------------------------------------------------------
// Running a turn

async function runTurn(s, prompt) {
  if (s.busy) return;
  s.busy = true;
  s.steps = {};
  s.turnStart = Date.now();
  s.interactionId = '';
  pushItem(s, { type: 'user', text: prompt });
  setThinking(s, s.envId ? 'Waiting for the controller to lease this turn…' : 'Creating self_hosted environment…');
  renderSessionHead();
  timeline('app', `${envLabel(s)}: POST /v1beta/interactions${s.envId ? '' : ' (new self_hosted env, ' + s.egress + ' egress)'}`);
  pulse('app-gemini', { color: C.app, label: 'prompt', dur: 900 });
  hot('app'); setTimeout(() => hot('gemini'), 700);

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1' },
      body: JSON.stringify({ prompt, envId: s.envId || '', egress: s.egress }),
    });
    if (!res.ok || !res.body) throw new Error(`demo server returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split(/\r?\n\r?\n/);
      buf = blocks.pop();
      for (const b of blocks) {
        let event = 'message', data = '';
        for (const line of b.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data || data === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(data); } catch (_) { continue; }
        handleStreamEvent(s, event, obj);
      }
    }
  } catch (err) {
    pushItem(s, { type: 'error', text: String(err.message || err) });
  } finally {
    s.busy = false;
    s.lastActivity = Date.now();
    for (const it of s.items) if (it.status === 'running') { it.status = 'done'; updateItem(s, it); }
    setThinking(s, null);
    save();
    renderSessionHead();
    renderTabs();
  }
}

let lastTextPulse = 0;

function handleStreamEvent(s, event, d) {
  switch (event) {
    case 'interaction.created': {
      const it = d.interaction || {};
      s.interactionId = it.id || '';
      if (it.environment_id && !s.envId) {
        s.envId = it.environment_id;
        timeline('gemini', `${envLabel(s)}: self_hosted environment created · waiting for a self-hosted worker`);
      } else {
        timeline('gemini', `${envLabel(s)}: interaction created · queued for lease`);
      }
      save();
      renderSessionHead();
      renderTabs();
      break;
    }
    case 'step.start': {
      const step = d.step || {};
      if (step.type === 'function_call') {
        const item = pushItem(s, { type: 'tool', callId: step.id, name: step.name, args: step.arguments && Object.keys(step.arguments).length ? step.arguments : null, argsStr: '', status: 'running' });
        s.steps[d.index] = item;
        setThinking(s, 'Tool running inside the sandbox…');
        pulse('pool-gemini', { color: C.actor, label: step.name, reverse: true, dur: 800 });
        flashActor(s);
        timeline('actor', `${envLabel(s)}: Gemini → actor · ${step.name}`);
      } else if (step.type === 'function_result') {
        const item = s.items.find((x) => x.type === 'tool' && x.callId === step.call_id);
        const target = item || pushItem(s, { type: 'tool', callId: step.call_id, name: step.name });
        target.result = step.result || {};
        target.isError = !!step.is_error;
        target.status = 'done';
        updateItem(s, target);
        setThinking(s, 'Agent thinking…');
        pulse('pool-gemini', { color: C.sub, label: 'result', dur: 800 });
        flashActor(s);
        const ec = target.result && target.result.exit_code;
        timeline('actor', `${envLabel(s)}: actor → Gemini · ${step.name} result${ec !== undefined ? ' (exit ' + ec + ')' : ''}`);
      } else if (step.type === 'model_output') {
        s.steps[d.index] = pushItem(s, { type: 'text', text: '' });
        setThinking(s, null);
      } else if (step.type === 'thought') {
        setThinking(s, 'Agent thinking…');
      }
      break;
    }
    case 'step.delta': {
      const item = s.steps[d.index];
      const delta = d.delta || {};
      if (!item) break;
      if (delta.type === 'arguments_delta' && typeof delta.arguments === 'string') {
        item.argsStr = (item.argsStr || '') + delta.arguments;
        updateItem(s, item);
      } else if (delta.type === 'text' && typeof delta.text === 'string') {
        item.text += delta.text;
        updateItem(s, item);
        const now = Date.now();
        if (now - lastTextPulse > 600) { lastTextPulse = now; pulse('app-gemini', { color: C.gemini, reverse: true, dur: 700 }); }
      }
      break;
    }
    case 'step.stop': {
      const item = s.steps[d.index];
      if (item && item.type === 'tool' && item.argsStr && !item.args) {
        try { item.args = JSON.parse(item.argsStr); item.argsStr = ''; } catch (_) { /* keep raw */ }
        updateItem(s, item);
      }
      break;
    }
    case 'interaction.completed': {
      const it = d.interaction || {};
      const secs = ((Date.now() - s.turnStart) / 1000).toFixed(1);
      const tok = it.usage && it.usage.total_tokens;
      const tools = Object.values(s.steps).filter((x) => x.type === 'tool').length;
      pushItem(s, { type: 'meta', text: `✓ ${it.status || 'completed'} in ${secs}s · ${tools} tool call${tools === 1 ? '' : 's'} in sandbox${tok ? ' · ' + tok.toLocaleString() + ' tokens' : ''}` });
      timeline('gemini', `${envLabel(s)}: interaction ${it.status || 'completed'} in ${secs}s`);
      pulse('app-gemini', { color: C.gemini, reverse: true, label: 'done', dur: 800 });
      break;
    }
    case 'interaction.failed':
    case 'error': {
      const msg = d.message || (d.error && d.error.message) || 'interaction failed';
      pushItem(s, { type: 'error', text: msg });
      timeline('gemini', `${envLabel(s)}: ${msg}`);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Wiring

function submitPrompt(text) {
  let s = active();
  if (!s) { s = newSession(); switchTo(s.id); }
  const prompt = (text || '').trim();
  if (!prompt || s.busy) return;
  runTurn(s, prompt);
}

async function suspendActive() {
  const s = active();
  const a = actorForSession(s);
  if (!a) return;
  $('btn-suspend').disabled = true;
  timeline('app', `${envLabel(s)}: kubectl ate suspend actor ${a.name.slice(0, 22)}…`);
  pulse('ctrl-api', { color: C.ice, label: 'Suspend', dur: 700 });
  try {
    const res = await fetch('/api/suspend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1' },
      body: JSON.stringify({ actor: a.name }),
    });
    if (!res.ok) timeline('app', `${envLabel(s)}: suspend failed (HTTP ${res.status})`);
  } catch (_) {
    timeline('app', `${envLabel(s)}: suspend request failed`);
  }
}

async function deleteAllActors() {
  const btn = $('btn-delete-all');
  if (S.sessions.some((s) => s.busy)) { timeline('app', 'Delete all: wait for running turns to finish'); return; }
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = `Click again to delete ${S.cluster.actors.length} actor(s)`;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = '🗑 Delete all actors'; }, 4000);
    return;
  }
  clearTimeout(btn._t);
  btn.classList.remove('armed');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  timeline('app', `Deleting all actors in atespace ${S.config.atespace || ''}…`);
  pulse('ctrl-api', { color: C.actor, label: 'DeleteActor', dur: 700 });
  try {
    const res = await fetch('/api/actors/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1' },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    timeline('substrate', `Deleted ${r.deleted} actor(s)${r.failed ? `, ${r.failed} failed` : ''}`);
  } catch (err) {
    timeline('app', `Delete all failed (${err.message})`);
  } finally {
    btn.disabled = false;
    btn.textContent = '🗑 Delete all actors';
  }
}

function init() {
  buildArch();
  load();
  if (!S.sessions.length) newSession();
  if (!active()) S.activeId = S.sessions[0].id;

  const sc = $('scenarios');
  for (const x of SCENARIOS) sc.append(el('button', { class: 'scenario', type: 'button', text: x.label, title: x.prompt, on: { click: () => submitPrompt(x.prompt) } }));

  $('composer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = $('prompt');
    const v = ta.value;
    if (!v.trim()) return;
    ta.value = '';
    submitPrompt(v);
  });
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer-form').requestSubmit(); }
  });
  $('btn-new').addEventListener('click', () => { $('new-sandbox').hidden = false; });
  $('btn-cancel-new').addEventListener('click', () => { $('new-sandbox').hidden = true; });
  $('btn-create').addEventListener('click', () => {
    const egress = (document.querySelector('input[name="egress"]:checked') || {}).value || 'default';
    const s = newSession(egress);
    switchTo(s.id);
    timeline('app', `${envLabel(s)} ready (${EGRESS_LABEL[egress]}) — actor is created on the first turn`);
  });
  $('btn-suspend').addEventListener('click', suspendActive);
  $('btn-delete-all').addEventListener('click', deleteAllActors);
  $('btn-clear-tl').addEventListener('click', (e) => { e.stopPropagation(); $('timeline').replaceChildren(); $('tl-latest').textContent = ''; });
  $('tl-toggle').addEventListener('click', () => toggleTimeline());
  $('tl-toggle').addEventListener('keydown', (e) => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleTimeline(); }
  });
  $('btn-reset-ui').addEventListener('click', () => {
    if (S.sessions.some((s) => s.busy)) return;
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  });

  fetch('/api/config').then((r) => r.json()).then((c) => { S.config = c; renderCluster(); }).catch(() => {});
  connectEvents();
  switchTo(S.activeId);

  // Tick idle countdowns.
  setInterval(() => { renderActors(); renderSessionHead(); }, 1000);
  timeline('app', 'Demo connected. Every tool call below executes inside a Substrate gVisor actor on this kind cluster.');
}

document.addEventListener('DOMContentLoaded', init);
