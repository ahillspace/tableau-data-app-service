"use strict";
/* Offline documentation viewer. Everything it shows comes from MODEL, which build.py
   assembles from the current documents and the system map layout. */
const $ = (q, root = document) => root.querySelector(q),
  $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad2 = (n) => String(n).padStart(2, "0");
const detail = (label, value) => (value ? `<div class="detail"><div class="eyebrow">${esc(label)}</div><p>${esc(value)}</p></div>` : "");
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

const SYSTEM = MODEL.system;
const NODES = new Map(SYSTEM.nodes.map((n) => [n.id, n]));
const BY_NAME = new Map();
for (const n of SYSTEM.nodes) for (const name of [n.name, ...(n.aliases || [])]) if (!BY_NAME.has(name)) BY_NAME.set(name, n.id);
const SOURCES = new Map(MODEL.sources.map((s) => [s.id, s]));
const SOURCE_BY_PATH = new Map(MODEL.sources.map((s) => [s.path, s]));
const ROUTES = MODEL.api.routes;
const CATEGORY = { component: "Component", presets: "Provider code", role: "Role", external: "Outside the service", optional: "Optional store" };
const MODULE_ORDER = (() => {
  const names = MODEL.architecture.components.map((c) => c.name);
  const at = names.indexOf("Connections");
  if (BY_NAME.has("Presets")) names.splice(at + 1, 0, "Presets");
  return names.map((name) => BY_NAME.get(name)).filter(Boolean);
})();

let currentView = "overview",
  selectedComponent = SYSTEM.gateway,
  flowIndex = 0,
  stepIndex = 0,
  selectedRoute = 0,
  currentDocument = MODEL.sources[0]?.id;

/* Links into the embedded documents. */
function headingAnchor(sourceId, title) {
  return SOURCES.get(sourceId)?.headings.find((h) => h.title === title)?.anchor || "";
}
function docHref(sourceId, anchor = "") {
  return `#documents/${sourceId}${anchor ? "/" + anchor : ""}`;
}
function docLink(path, label) {
  if (!path) return "";
  const [file, anchor = ""] = path.split("#");
  const source = SOURCE_BY_PATH.get(file);
  if (!source) return "";
  const heading = anchor && source.headings.find((h) => h.anchor === anchor);
  const text = label || `${source.title}${heading ? " / " + heading.title : ""}`;
  return `<a href="${esc(docHref(source.id, anchor))}">${esc(text)} ↗</a>`;
}
function nodeDocs(n) {
  const links = [];
  if (n.category === "component") links.push(docLink(`docs/architecture.md#${headingAnchor("architecture", n.name)}`));
  if (n.category === "role" || (n.role && n.category !== "component")) links.push(docLink(`docs/architecture.md#${headingAnchor("architecture", "Roles")}`));
  if (n.trustIn || n.trustOut) links.push(docLink(`docs/architecture.md#${headingAnchor("architecture", "Trust boundaries")}`));
  if (n.detail) links.push(docLink(n.detail));
  if (n.doc) links.push(docLink(n.doc));
  return [...new Set(links)].join("");
}

/* System map drawing. Card positions and fixed edges come from diagram.json; a highlighted
   flow path follows a fixed edge when one joins the pair, a straight line when the two cards
   face each other, and otherwise the free lanes between cards. */
function parsePath(d) {
  const points = [];
  let x = 0, y = 0;
  for (const [, cmd, args] of d.matchAll(/([MLHV])\s*([-\d.\s,]+)/g)) {
    const v = args.trim().split(/[\s,]+/).map(Number);
    if (cmd === "H") x = v[0];
    else if (cmd === "V") y = v[0];
    else [x, y] = v;
    points.push([x, y]);
  }
  return points;
}
const toPath = (points) => points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
function blocked(x1, y1, x2, y2, skip) {
  return SYSTEM.nodes.some(
    (n) => !skip.includes(n.id) && Math.max(x1, x2) > n.x + 0.5 && Math.min(x1, x2) < n.x + n.w - 0.5 && Math.max(y1, y2) > n.y + 0.5 && Math.min(y1, y2) < n.y + n.h - 0.5,
  );
}
const LANES = (() => {
  const xs = SYSTEM.lanes.x, ys = SYSTEM.lanes.y;
  const ports = new Map();
  for (const n of SYSTEM.nodes) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    const above = Math.max(...ys.filter((y) => y < n.y)), below = Math.min(...ys.filter((y) => y > n.y + n.h));
    const left = Math.max(...xs.filter((x) => x < n.x)), right = Math.min(...xs.filter((x) => x > n.x + n.w));
    const list = [];
    if (isFinite(above)) list.push({ edge: [cx, n.y], lane: [cx, above], dir: "v" });
    if (isFinite(below)) list.push({ edge: [cx, n.y + n.h], lane: [cx, below], dir: "v" });
    if (isFinite(left)) list.push({ edge: [n.x, cy], lane: [left, cy], dir: "h" });
    if (isFinite(right)) list.push({ edge: [n.x + n.w, cy], lane: [right, cy], dir: "h" });
    ports.set(n.id, list.filter((p) => !blocked(...p.edge, ...p.lane, [n.id])));
  }
  const all = [...ports.values()].flat();
  const key = ([x, y]) => `${x},${y}`;
  const graph = new Map();
  const link = (a, b, dir) => {
    if (blocked(...a, ...b, [])) return;
    for (const [p, q] of [[a, b], [b, a]]) {
      if (!graph.has(key(p))) graph.set(key(p), { at: p, next: [] });
      graph.get(key(p)).next.push({ to: q, dir });
    }
  };
  for (const x of xs) {
    const line = [...ys.map((y) => [x, y]), ...all.filter((p) => p.dir === "h" && p.lane[0] === x).map((p) => p.lane)].sort((a, b) => a[1] - b[1]);
    line.forEach((p, i) => i && p[1] !== line[i - 1][1] && link(line[i - 1], p, "v"));
  }
  for (const y of ys) {
    const line = [...xs.map((x) => [x, y]), ...all.filter((p) => p.dir === "v" && p.lane[1] === y).map((p) => p.lane)].sort((a, b) => a[0] - b[0]);
    line.forEach((p, i) => i && p[0] !== line[i - 1][0] && link(line[i - 1], p, "h"));
  }
  return { ports, graph, key };
})();
function laneRoute(a, b) {
  const BEND = 60, dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
  const { ports, graph, key } = LANES;
  const best = new Map(), queue = [];
  for (const p of ports.get(a.id)) queue.push({ cost: dist(p.edge, p.lane), at: p.lane, dir: p.dir, trail: [p.edge, p.lane] });
  const goals = ports.get(b.id);
  let found = null;
  while (queue.length) {
    queue.sort((x, y) => x.cost - y.cost);
    const state = queue.shift();
    const id = `${key(state.at)}|${state.dir}`;
    if (best.has(id)) continue;
    best.set(id, state.cost);
    for (const goal of goals) {
      if (key(goal.lane) !== key(state.at)) continue;
      const cost = state.cost + dist(goal.lane, goal.edge) + (goal.dir === state.dir ? 0 : BEND);
      if (!found || cost < found.cost) found = { cost, trail: [...state.trail, goal.edge] };
    }
    for (const step of graph.get(key(state.at))?.next || []) {
      queue.push({ cost: state.cost + dist(state.at, step.to) + (step.dir === state.dir ? 0 : BEND), at: step.to, dir: step.dir, trail: [...state.trail, step.to] });
    }
  }
  if (!found) return null;
  return found.trail.filter((p, i, t) => {
    if (i === 0 || i === t.length - 1) return true;
    const [q, r] = [t[i - 1], t[i + 1]];
    return !((q[0] === p[0] && p[0] === r[0]) || (q[1] === p[1] && p[1] === r[1]));
  });
}
function straightRoute(a, b) {
  const ox1 = Math.max(a.x, b.x), ox2 = Math.min(a.x + a.w, b.x + b.w);
  if (ox2 - ox1 > 20) {
    const x = (ox1 + ox2) / 2;
    const ys = a.y + a.h <= b.y ? [a.y + a.h, b.y] : b.y + b.h <= a.y ? [a.y, b.y + b.h] : null;
    if (ys && !blocked(x, ys[0], x, ys[1], [a.id, b.id])) return [[x, ys[0]], [x, ys[1]]];
  }
  const oy1 = Math.max(a.y, b.y), oy2 = Math.min(a.y + a.h, b.y + b.h);
  if (oy2 - oy1 > 20) {
    const y = (oy1 + oy2) / 2;
    const xs = a.x + a.w <= b.x ? [a.x + a.w, b.x] : b.x + b.w <= a.x ? [a.x, b.x + b.w] : null;
    if (xs && !blocked(xs[0], y, xs[1], y, [a.id, b.id])) return [[xs[0], y], [xs[1], y]];
  }
  return null;
}
function activeRoute(from, to) {
  const fixed = SYSTEM.edges.findIndex((e) => e.from === from && e.to === to);
  if (fixed >= 0) return { edge: fixed, points: parsePath(SYSTEM.edges[fixed].path) };
  const back = SYSTEM.edges.findIndex((e) => e.from === to && e.to === from);
  if (back >= 0) return { edge: back, points: parsePath(SYSTEM.edges[back].path).reverse() };
  const a = NODES.get(from), b = NODES.get(to);
  return { edge: -1, points: straightRoute(a, b) || laneRoute(a, b) || [[a.x + a.w / 2, a.y + a.h / 2], [b.x + b.w / 2, b.y + b.h / 2]] };
}
function labelMarkup(x, y, text, anchor, on) {
  const lines = String(text || "").split("\n");
  if (!lines[0]) return "";
  return `<text class="edge-label${on ? " on" : ""}" x="${x}" y="${y}" text-anchor="${anchor || "middle"}">${lines
    .map((line, i) => `<tspan x="${x}" dy="${i ? 11 : 0}">${esc(line)}</tspan>`)
    .join("")}</text>`;
}
function diagramSvg(uid, { selected = null, active = null, path = [] } = {}) {
  const routes = path.map(([from, to]) => activeRoute(from, to));
  const onEdges = new Set(routes.map((r) => r.edge).filter((i) => i >= 0));
  const groups = SYSTEM.groups
    .map((g) => `<rect class="group-${esc(g.tone)}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="5"/><text x="${g.x + 16}" y="${g.y + 19}" font-size="9" fill="var(--${g.tone === "service" ? "accent" : "dim"})" letter-spacing="1.2">${esc(g.label)}</text>`)
    .join("");
  const labels = SYSTEM.labels.map((l) => `<text x="${l.x}" y="${l.y}" font-size="8" fill="var(--dim)" letter-spacing="1" text-anchor="${l.anchor || "start"}">${esc(l.text)}</text>`).join("");
  const edges = SYSTEM.edges
    .map((e, i) => {
      const on = onEdges.has(i);
      return `<path class="diagram-edge${e.optional ? " optional-edge" : ""}${on ? " edge-active" : ""}" d="${esc(e.path)}" marker-end="url(#arrow-${uid}-${on ? "active" : "base"})"/>${labelMarkup(e.labelX, e.labelY, e.label, e.anchor, on)}`;
    })
    .join("");
  const activeEdges = routes
    .filter((r) => r.edge < 0)
    .map((r) => `<path class="diagram-edge edge-active" d="${toPath(r.points)}" marker-end="url(#arrow-${uid}-active)"/>`)
    .join("");
  const numbers =
    routes.length > 1
      ? routes
          .map((r, i) => {
            const segs = r.points.slice(1).map((p, j) => [r.points[j], p]);
            const [p, q] = segs.reduce((m, s) => (Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]) ? s : m));
            const x = (p[0] + q[0]) / 2, y = (p[1] + q[1]) / 2;
            return `<g aria-hidden="true"><circle class="edge-step-dot" cx="${x}" cy="${y}" r="7"/><text class="edge-step" x="${x}" y="${y + 3}" text-anchor="middle">${i + 1}</text></g>`;
          })
          .join("")
      : "";
  const cards = SYSTEM.nodes
    .map((n) => {
      const on = selected === n.id || (active && active.includes(n.id));
      const dim = active && !active.includes(n.id);
      const tall = n.h >= 66;
      const [ky, ny, sy] = tall ? [20, 42, 60] : [17, 34, 48];
      const classes = ["component", n.category, on ? "selected" : "", dim ? "dimmed" : ""].filter(Boolean).join(" ");
      const dot = n.category === "component" || n.category === "presets" || n.category === "role" ? "accent" : "dim";
      return `<g class="${classes}" data-component="${esc(n.id)}" role="button" tabindex="0" aria-label="Inspect ${esc(n.name)}"><rect class="component-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="4"/><text x="${n.x + 13}" y="${n.y + ky}" font-size="8" fill="var(--dim)" letter-spacing="1">${esc(n.kind)}</text><text x="${n.x + 13}" y="${n.y + ny}" font-size="12" fill="var(--fg)" font-weight="600">${esc(n.name)}</text><text x="${n.x + 13}" y="${n.y + sy}" font-size="9" fill="var(--muted)">${esc(n.subtitle)}</text><circle cx="${n.x + n.w - 13}" cy="${n.y + 15}" r="3" fill="var(--${dot})"/></g>`;
    })
    .join("");
  const marker = (name, color) => `<marker id="arrow-${uid}-${name}" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--${color})"/></marker>`;
  return `<svg class="architecture-diagram" viewBox="0 0 ${SYSTEM.width} ${SYSTEM.height}" role="img" aria-label="System map of the service, its clients, providers and stores. Cards can be selected for details."><defs>${marker("base", "strong")}${marker("active", "accent")}</defs>${groups}${labels}${edges}${activeEdges}${cards}${numbers}</svg>`;
}
function renderDiagram(target, options) {
  $(target).innerHTML = diagramSvg(target.replace(/[^a-zA-Z0-9_-]/g, ""), options);
}

/* Inspecting a card. */
function nodeLinks(names) {
  return names?.length
    ? `<div class="linkrow">${names.map((name) => BY_NAME.get(name)).filter(Boolean).map((id) => `<a href="#modules/${esc(id)}">${esc(NODES.get(id).name)} →</a>`).join("")}</div>`
    : '<p>None</p>';
}
function renderInspector(id, target) {
  const n = NODES.get(id);
  if (!n) return;
  const deps = n.dependsOn ? `<div class="detail"><div class="eyebrow">Depends on</div>${nodeLinks(n.dependsOn)}</div><div class="detail"><div class="eyebrow">Called by</div>${nodeLinks(n.calledBy)}</div>` : "";
  $(target).innerHTML = `<div class="inspector-head"><div class="eyebrow">${esc(n.category === "component" ? n.kind : `${CATEGORY[n.category]} / ${n.kind}`)}</div><h3>${esc(n.name)}</h3>${n.subtitle ? `<p class="muted" style="font-size:11px;margin-top:6px">${esc(n.subtitle)}</p>` : ""}</div><div class="inspector-body">${n.facts.map((f) => detail(f.label, capital(f.text))).join("")}${deps}<div class="detail"><div class="eyebrow">Read more</div><div class="linkrow">${nodeDocs(n)}</div></div></div>`;
}
function selectComponent(id) {
  if (!NODES.has(id)) return;
  selectedComponent = id;
  renderDiagram("#system-diagram", { selected: id });
  renderInspector(id, "#system-inspector");
  renderInspector(id, "#module-inspector");
  if (MODULE_ORDER.includes(id)) renderModuleDependencies(id);
  $$(".module-card").forEach((card) => card.classList.toggle("selected", card.dataset.component === id));
  if (currentView === "flows") {
    $("#flow-inspector").hidden = false;
    renderInspector(id, "#flow-inspector");
    $("#flow-inspector").scrollIntoView({ block: "nearest" });
  }
}

/* System view. */
function renderSystem() {
  const arch = MODEL.architecture;
  $("#system-caption").textContent = `${arch.notes.join(" ")} Solid lines are interactions; dashed lines and cards are optional.`;
  $("#direction-summary").textContent = arch.direction.join(" ");
  const roles = SYSTEM.nodes.filter((n) => n.category === "role");
  $("#system-summary").innerHTML = `<div class="strip">${roles
    .map((n) => `<div><div class="eyebrow">Role</div><strong>${esc(n.name)}</strong><p>${esc(n.facts.map((f) => f.text).join(" "))}</p></div>`)
    .join("")}</div>`;
  $("#trust-lens").innerHTML = `<div class="table-wrap"><table><thead><tr><th>Boundary</th><th>What crosses it</th><th>What the service relies on</th></tr></thead><tbody>${arch.trust
    .map((t) => `<tr><td>${esc(t.boundary)}</td><td>${esc(t.crosses)}</td><td>${esc(capital(t.relies))}</td></tr>`)
    .join("")}</tbody></table></div><div class="diagram-caption">${esc(arch.trustNotes.join(" "))} <span class="linkrow" style="display:inline-flex">${docLink(`docs/architecture.md#${headingAnchor("architecture", "Trust boundaries")}`)}</span></div>`;
}
function showLens(lens) {
  $("#system-workspace").classList.toggle("trust-active", lens === "trust");
  $("#system-inspector").hidden = lens === "trust";
  $("#runtime-lens").hidden = lens !== "runtime";
  $("#trust-lens").hidden = lens !== "trust";
  $$("[data-system-lens]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.systemLens === lens)));
}

/* Modules view. */
function renderModuleDependencies(id) {
  const n = NODES.get(id);
  const peers = (names) =>
    names?.length
      ? names.map((name) => NODES.get(BY_NAME.get(name))).filter(Boolean).map((p) => `<button data-component="${esc(p.id)}">${esc(p.name)}<small>${esc(p.kind)}</small></button>`).join("")
      : '<p class="muted">None</p>';
  $("#module-dependencies").innerHTML = `<div class="surface-head"><h3>Dependency direction / ${esc(n.name)}</h3><span class="eyebrow">Select a related component</span></div><div class="dependency-lens"><div><div class="eyebrow">Called by</div>${peers(n.calledBy)}</div><div class="dependency-selected"><span class="muted">→</span><button data-component="${esc(n.id)}">${esc(n.name)}<small>${esc(n.kind)}</small></button><span class="muted">→</span></div><div><div class="eyebrow">Depends on</div>${peers(n.dependsOn)}</div></div>`;
}
function renderModules() {
  $("#module-grid").innerHTML = MODULE_ORDER.map((id) => {
    const n = NODES.get(id);
    const first = n.facts[0];
    const summary = first.label === "Owns" ? `Owns ${first.text}` : first.text.split(/(?<=\.)\s+/)[0];
    return `<button class="module-card${id === selectedComponent ? " selected" : ""}" data-component="${esc(id)}"><div class="eyebrow module-kind">${esc(n.kind)}</div><h3>${esc(n.name)}</h3><p>${esc(summary)}</p><div class="eyebrow">Depends on / ${esc(n.dependsOn.length ? n.dependsOn.join(", ") : "nothing")}</div></button>`;
  }).join("");
  filterModules();
}
function filterModules() {
  const q = $("#module-search").value.trim().toLowerCase();
  let shown = 0;
  $$(".module-card").forEach((card) => {
    const n = NODES.get(card.dataset.component);
    const match = !q || [n.name, n.subtitle, ...n.facts.map((f) => f.text)].join(" ").toLowerCase().includes(q);
    card.hidden = !match;
    shown += match;
  });
  $("#module-empty").hidden = shown > 0;
}

/* Data flows view. */
function flowAnchor(flow) {
  return headingAnchor("flows", flow.name);
}
function renderFlow() {
  const f = MODEL.flows[flowIndex];
  if (!f) return;
  stepIndex = Math.max(0, Math.min(stepIndex, f.steps.length - 1));
  const s = f.steps[stepIndex];
  $("#flow-select").value = String(flowIndex);
  $("#flow-name").textContent = f.name;
  $("#flow-counter").textContent = `${pad2(stepIndex + 1)} / ${pad2(f.steps.length)}`;
  const chain = [...new Set(s.path.flat())].map((id) => NODES.get(id).name);
  $("#flow-current").textContent = `Step ${stepIndex + 1} / ${s.owners.join(" + ")}${chain.length ? " / " + chain.join(" → ") : ""}`;
  $("#flow-steps").innerHTML = f.steps
    .map((step, i) => `<button class="step-button ${i === stepIndex ? "active" : ""}" data-step="${i}" aria-current="${i === stepIndex ? "step" : "false"}"><span class="step-number">${i + 1}</span><span>${esc(step.text)}<small>${esc(step.owners.join(" + "))}</small></span></button>`)
    .join("");
  renderDiagram("#flow-diagram", { active: s.nodes, path: s.path });
  const routes = s.routes.map((i) => `<a href="#api/${i + 1}">${esc(ROUTES[i].route)} →</a>`).join("");
  const owners = s.owners.map((o) => BY_NAME.get(o)).filter(Boolean).map((id) => `<a href="#modules/${esc(id)}">${esc(NODES.get(id).name)} →</a>`).join("");
  const hops = s.path.map(([a, b]) => `${NODES.get(a).name} → ${NODES.get(b).name}`).join("; ");
  $("#step-detail").innerHTML = `<article class="step-detail"><div class="eyebrow">Step ${stepIndex + 1} of ${f.steps.length} / ${esc(f.name)}</div><h3>${esc(s.text)}</h3><div class="detail-grid">${detail("Owned by", s.owners.join(" and "))}${detail(s.path.length > 1 ? "Path on the map, in order" : "Path on the map", hops || "Stays inside the owning component.")}</div>${routes ? `<div class="detail"><div class="eyebrow">Routes</div><div class="linkrow">${routes}</div></div>` : ""}<div class="linkrow">${owners}${docLink(`docs/flows.md#${flowAnchor(f)}`, "Read this flow")}${f.see ? docLink(f.see, `See ${SOURCE_BY_PATH.get(f.see.split("#")[0])?.title}`) : ""}</div></article>`;
  $("#previous-step").disabled = stepIndex === 0;
  $("#next-step").disabled = stepIndex === f.steps.length - 1;
  if (currentView === "flows") setHash(`#flows/${flowIndex + 1}/${stepIndex + 1}`, false);
}

/* API view. */
const METHOD = /^((?:ANY|GET|POST|PUT|PATCH|DELETE)(?:,\s*(?:GET|POST|PUT|PATCH|DELETE))*)\s+(.*)$/;
function splitRoute(route) {
  const m = route.match(METHOD);
  return m ? [m[1], m[2]] : ["", route];
}
function renderApi() {
  const q = $("#api-search").value.trim().toLowerCase(),
    group = $("#api-filter").value;
  const rows = ROUTES.map((r, i) => [r, i]).filter(([r]) => (!group || r.group === group) && [r.route, r.auth, r.owner, r.purpose, r.group].join(" ").toLowerCase().includes(q));
  $("#api-rows").innerHTML = rows.length
    ? rows
        .map(([r, i]) => {
          const [method, path] = splitRoute(r.route);
          return `<tr data-api-row="${i}" tabindex="0" aria-label="Inspect ${esc(r.route)}" aria-selected="${i === selectedRoute}"><td>${method ? `<span class="method">${esc(method)}</span> ` : ""}<span class="route">${esc(path)}</span><small>${esc(r.purpose)}</small></td><td>${esc(r.auth)}</td><td>${esc(r.owner || "HTTP surface")}</td></tr>`;
        })
        .join("")
    : '<tr><td colspan="3" class="no-results">No route matches this filter.</td></tr>';
}
function selectApi(i) {
  const r = ROUTES[i];
  if (!r) return;
  selectedRoute = i;
  $$("[data-api-row]").forEach((row) => row.setAttribute("aria-selected", String(Number(row.dataset.apiRow) === i)));
  const [method, path] = splitRoute(r.route);
  const owner = BY_NAME.get(r.owner || "HTTP surface");
  const uses = [];
  MODEL.flows.forEach((f, fi) => f.steps.forEach((s, si) => s.routes.includes(i) && uses.push(`<a href="#flows/${fi + 1}/${si + 1}">${esc(f.name)} / step ${si + 1} →</a>`)));
  $("#api-detail").innerHTML = `<div class="surface-head"><h3>${esc(r.group)}</h3></div><div class="surface-body"><p class="route">${method ? `<span class="method">${esc(method)}</span> ` : ""}${esc(path)}</p><div class="detail-grid" style="margin-top:18px">${detail("Purpose", r.purpose)}${detail("Auth", r.auth)}${detail("Owner", r.owner || "HTTP surface")}${detail("Applies to this group", MODEL.api.notes[r.group])}</div>${uses.length ? `<div class="detail" style="margin-top:18px"><div class="eyebrow">Used in flows</div><div class="linkrow">${uses.join("")}</div></div>` : ""}<div class="linkrow">${owner ? `<a href="#modules/${esc(owner)}">Inspect owner →</a>` : ""}${docLink(`docs/api.md#${headingAnchor("api", r.group)}`)}</div></div>`;
}

/* Verification view. */
function renderVerification() {
  const v = MODEL.verification;
  $("#verification-summary").innerHTML = [
    ["Automated tests", v.checks.length, "Checks that run with npm test."],
    ["Not verified live", v.unverified.length, "Behavior not yet run against a deployed installation."],
    ["Known limitations", v.limitations.length, "What the service does not do today."],
  ]
    .map(([label, count, text]) => `<div><div class="eyebrow">${esc(label)}</div><strong>${count}</strong><p>${esc(text)}</p></div>`)
    .join("");
  $("#check-count").textContent = `${v.checks.length} checks`;
  $("#verification-intro").textContent = v.intro.join(" ");
  $("#unverified-count").textContent = String(v.unverified.length);
  $("#unverified-intro").textContent = v.unverifiedIntro;
  $("#unverified").innerHTML = v.unverified.map((item) => `<li>${esc(item)}</li>`).join("");
  $("#limitation-count").textContent = String(v.limitations.length);
  $("#limitations").innerHTML = v.limitations.map((item) => `<li>${esc(item)}</li>`).join("");
  renderChecks();
}
function renderChecks() {
  const q = $("#check-search").value.trim().toLowerCase();
  const rows = MODEL.verification.checks.filter((c) => [c.id, c.shows, c.tests].join(" ").toLowerCase().includes(q));
  $("#check-rows").innerHTML = rows.length
    ? rows.map((c) => `<tr><td>${esc(c.id)}</td><td>${esc(c.shows)}</td><td>${esc(c.tests)}</td></tr>`).join("")
    : '<tr><td colspan="3" class="no-results">No check matches this filter.</td></tr>';
}

/* Documents view. */
function openDocument(id, anchor) {
  const source = SOURCES.get(id) || MODEL.sources[0];
  currentDocument = source.id;
  $$("#document-nav button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.document === source.id)));
  if ($("#document-body").dataset.document !== source.id) {
    $("#document-body").dataset.document = source.id;
    $("#document-body").innerHTML = source.html;
    const sections = source.headings.filter((h) => h.depth === 2);
    $("#document-toc").innerHTML = sections.length ? `<div class="linkrow">${sections.map((h) => `<a href="${esc(docHref(source.id, h.anchor))}">${esc(h.title)}</a>`).join("")}</div>` : "";
    $("#document-toc").hidden = !sections.length;
    $("#document-meta").innerHTML = `<code>${esc(source.path)}</code> / SHA-256 ${esc(source.sha256)}`;
  }
  return source;
}
function scrollToDocument(source, anchor) {
  const target = anchor ? document.getElementById(`doc-${source.id}-${anchor}`) : null;
  if (!target) return;
  target.scrollIntoView({ block: "start" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1400);
}

/* Overview, chrome and print. */
function renderOverview() {
  const product = SOURCES.get("product");
  const html = product.html;
  const start = html.indexOf("</h2>") + 5, end = html.indexOf("<h3");
  $("#product-overview").innerHTML = html.slice(start, end > start ? end : undefined).replaceAll('id="doc-product-', 'id="overview-product-');
  const p = MODEL.product;
  $("#audience").innerHTML = p.audience.map((a) => `<div><div class="eyebrow">Who uses it</div><strong>${esc(a.who)}</strong><p>${esc(capital(a.text))}</p></div>`).join("");
  $("#capabilities").innerHTML = p.capabilities.map((c) => `<section class="surface"><div class="eyebrow">What it does</div><h3>${esc(c.group)}</h3><ul>${c.points.map((pt) => `<li>${esc(pt)}</li>`).join("")}</ul></section>`).join("");
  $("#journeys").innerHTML = p.journeys.map((j) => `<tr><td>${esc(j.name)}</td><td>${esc(j.text)}</td></tr>`).join("");
  $("#exclusions").innerHTML = p.exclusions.map((x) => `<li>${esc(x)}</li>`).join("");
  const components = SYSTEM.nodes.filter((n) => n.category === "component").length;
  const steps = MODEL.flows.reduce((sum, f) => sum + f.steps.length, 0);
  $("#overview-callout").textContent = `${MODEL.sources.length} documents, ${components} components, ${ROUTES.length} routes, ${MODEL.flows.length} flows in ${steps} steps and ${MODEL.verification.checks.length} automated checks, all read from the current documents when this file was built.`;
  $("#heading-meta").innerHTML = `<div class="eyebrow">Current documents</div><p style="margin-top:14px">${MODEL.sources.length} documents · ${components} components<br>${ROUTES.length} routes · ${MODEL.verification.checks.length} automated checks</p>`;
  $("#rail-note").innerHTML = `<div class="eyebrow">Generated view</div><p style="margin-top:12px">Inspect a component.<br>Trace a request.<br>Read the documents.</p>`;
}
function renderPrintReview() {
  const table = (heads, rows) =>
    `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const page = (title, body) => `<section class="print-page"><div class="eyebrow">Tableau Data App Service / application documentation</div><h2>${esc(title)}</h2>${body}</section>`;
  const p = MODEL.product, v = MODEL.verification;
  const modules = MODULE_ORDER.map((id) => NODES.get(id));
  $("#print-review").innerHTML =
    page("0. What this service does", $("#product-overview").innerHTML.replace(/ id="[^"]*"/g, "") + table(["Who uses it", ""], p.audience.map((a) => [a.who, capital(a.text)])) + table(["Not included"], p.exclusions.map((x) => [x]))) +
    page("1. System map", diagramSvg("print") + `<p class="print-note">${esc(MODEL.architecture.notes.join(" "))}</p><p class="print-note">${esc(MODEL.architecture.direction.join(" "))}</p>`) +
    page("2. Components", table(["Component", "Owns", "Invariants"], modules.map((n) => [n.name, capital(n.facts[0].text), capital(n.facts.find((f) => f.label === "Invariants")?.text || "")]))) +
    page("3. Data flows", MODEL.flows.map((f) => `<h3>${esc(f.name)}</h3>${table(["Step", "Owner"], f.steps.map((s, i) => [`${i + 1}. ${s.text}`, s.owners.join(" + ")]))}`).join("")) +
    page("4. API", `<p class="print-note">${esc(MODEL.api.preamble)}</p>${table(["Route", "Auth", "Owner"], ROUTES.map((r) => [r.route, r.auth, r.owner || "HTTP surface"]))}`) +
    page(
      "5. Verification",
      `<p class="print-note">${esc(v.intro.join(" "))}</p>${table(["Check", "Shows", "Tests"], v.checks.map((c) => [c.id, c.shows, c.tests]))}<div class="print-columns"><div><h3>Not verified live</h3>${v.unverified.map((x) => `<article class="print-card">${esc(x)}</article>`).join("")}</div><div><h3>Known limitations</h3>${v.limitations.map((x) => `<article class="print-card">${esc(x)}</article>`).join("")}</div></div><p class="print-note">The interactive file embeds all ${MODEL.sources.length} documents in full with their content hashes; this summary omits their bodies.</p>`,
    );
}

/* Navigation. Every view and selection has a hash, so links, back and reload all land in the same place. */
const VIEW_LABEL = { overview: "overview", system: "system map", flows: "data flows", modules: "modules", api: "api", verification: "verification", documents: "documents" };
function setHash(hash, push) {
  if (location.protocol === "about:" || location.hash === hash) return;
  history[push ? "pushState" : "replaceState"](null, "", hash);
}
function showView(view) {
  currentView = view;
  $$(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
  $$("[data-view]").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#crumb").textContent = VIEW_LABEL[view];
  window.scrollTo({ top: 0 });
}
function route(hash, push) {
  const [view, a, b] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  if (!VIEW_LABEL[view]) return route("#overview", false);
  let canonical = `#${view}`;
  if (view === "flows") {
    if (a) {
      flowIndex = Math.max(0, Math.min(Number(a) - 1 || 0, MODEL.flows.length - 1));
      stepIndex = Number(b) - 1 || 0;
    }
    $("#flow-inspector").hidden = true;
    renderFlow();
    canonical = `#flows/${flowIndex + 1}/${stepIndex + 1}`;
  } else if ((view === "modules" || view === "system") && NODES.has(a)) {
    selectComponent(a);
    canonical = `#${view}/${a}`;
  } else if (view === "api" && ROUTES[Number(a) - 1]) {
    $("#api-search").value = "";
    $("#api-filter").value = "";
    selectedRoute = Number(a) - 1;
    renderApi();
    selectApi(selectedRoute);
    canonical = `#api/${a}`;
  }
  let source = null;
  if (view === "documents") {
    source = openDocument(a || currentDocument);
    canonical = docHref(source.id, b && source.headings.some((h) => h.anchor === b) ? b : "");
  }
  showView(view);
  if (source) scrollToDocument(source, b);
  if (view === "api" && a) $(`[data-api-row="${selectedRoute}"]`)?.scrollIntoView({ block: "nearest" });
  setHash(canonical, push);
}

function init() {
  renderOverview();
  renderSystem();
  $("#flow-select").innerHTML = MODEL.flows.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join("");
  $("#api-preamble").textContent = MODEL.api.preamble;
  $("#api-filter").innerHTML += [...new Set(ROUTES.map((r) => r.group))].map((g) => `<option>${esc(g)}</option>`).join("");
  $("#document-nav").innerHTML = MODEL.sources.map((s) => `<button type="button" data-document="${esc(s.id)}" aria-current="false">${esc(s.title)}<small>${esc(s.kind)} / ${esc(s.path.replace(/^docs\//, ""))}</small></button>`).join("");
  renderModules();
  selectComponent(selectedComponent);
  renderApi();
  selectApi(0);
  renderVerification();
  renderFlow();
  openDocument(currentDocument);
  renderPrintReview();
  route(location.hash || "#overview", false);
}

document.addEventListener("click", (event) => {
  const lens = event.target.closest("[data-system-lens]");
  if (lens) return showLens(lens.dataset.systemLens);
  const component = event.target.closest("[data-component]");
  if (component) {
    selectComponent(component.dataset.component);
    if (currentView !== "flows") setHash(`#${currentView}/${component.dataset.component}`, false);
    return;
  }
  const step = event.target.closest("[data-step]");
  if (step) {
    stepIndex = Number(step.dataset.step);
    return renderFlow();
  }
  const api = event.target.closest("[data-api-row]");
  if (api) {
    selectApi(Number(api.dataset.apiRow));
    setHash(`#api/${Number(api.dataset.apiRow) + 1}`, false);
    if (innerWidth < 1200) $("#api-detail").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const doc = event.target.closest("[data-document]");
  if (doc) return route(docHref(doc.dataset.document), true);
  const a = event.target.closest('a[href^="#"]');
  if (a && !a.classList.contains("skip-link")) {
    event.preventDefault();
    route(a.getAttribute("href"), true);
  }
});
document.addEventListener("keydown", (event) => {
  const c = event.target.closest("[data-component],[data-api-row]");
  if (c && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  if (event.target.closest("[data-step]") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault();
    stepIndex += event.key === "ArrowRight" ? 1 : -1;
    renderFlow();
    $("[data-step].active")?.focus();
  }
});
$("#flow-select").addEventListener("change", (event) => {
  flowIndex = Number(event.target.value);
  stepIndex = 0;
  renderFlow();
});
$("#previous-step").addEventListener("click", () => {
  stepIndex--;
  renderFlow();
});
$("#next-step").addEventListener("click", () => {
  stepIndex++;
  renderFlow();
});
$("#module-search").addEventListener("input", filterModules);
$("#check-search").addEventListener("input", renderChecks);
$("#api-search").addEventListener("input", renderApi);
$("#api-filter").addEventListener("change", renderApi);
$("#print-button").addEventListener("click", () => window.print());
window.addEventListener("popstate", () => route(location.hash, false));
init();
