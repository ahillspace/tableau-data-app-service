"use strict";
const $ = (q, root = document) => root.querySelector(q),
  $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const badge = (s = "Proposed") =>
  `<span class="status ${s.toLowerCase()}">${esc(s)}</span>`;
const sourceLink = (id, label = "Inspect source") =>
  `<a href="#sources" data-source="${esc(id)}">${esc(label)} ↗</a>`;
const detail = (label, value) =>
  `<div class="detail"><div class="eyebrow">${esc(label)}</div><p>${esc(value)}</p></div>`;
let currentView = "overview",
  selectedComponent = MODEL.components[0]?.id,
  flowIndex = 0,
  selectedFlow = MODEL.flows[0]?.id;
function showView(view, updateHash = true) {
  if (!$(`#view-${view}`)) return;
  currentView = view;
  $$(".view").forEach((s) => (s.hidden = s.id !== `view-${view}`));
  $$("[data-view]").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#crumb").textContent = view;
  if (updateHash && location.protocol !== "about:")
    history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0 });
}
function componentById(id) {
  return [...MODEL.components, ...(MODEL.modules || [])].find(
    (c) => c.id === id,
  );
}
function renderDiagram(target, activeIds = [], activeEdge = null) {
  const uid = target.replace(/[^a-zA-Z0-9_-]/g, "");
  const nodes = MODEL.diagram.nodes;
  const edges = MODEL.diagram.edges;
  const selected = activeEdge ? null : selectedComponent;
  const edgeMarkup = edges
    .map((e) => {
      const on = false;
      return `<path class="diagram-edge ${e.optional ? "optional-edge" : ""} ${on ? "edge-active" : ""}" d="${esc(e.path)}" marker-end="url(#arrow-${uid}-${on ? "active" : "base"})"/><text x="${e.labelX}" y="${e.labelY}" fill="var(--${on ? "accent" : "dim"})" font-size="9" text-anchor="middle">${esc(e.label)}</text>`;
    })
    .join("");
  let activeMarkup = "";
  if (activeEdge) {
    for (const edgePair of Array.isArray(activeEdge[0])
      ? activeEdge
      : [activeEdge]) {
      const a = nodes.find((n) => n.id === edgePair[0]),
        b = nodes.find((n) => n.id === edgePair[1]);
      if (a && b) {
        let x1, y1, x2, y2;
        if (a.id === b.id) {
          x1 = a.x + a.w;
          y1 = a.y + 20;
          x2 = x1;
          y2 = a.y + a.h - 12;
          activeMarkup += `<path class="diagram-edge edge-active" d="M${x1} ${y1} C${x1 + 45} ${y1},${x2 + 45} ${y2},${x2} ${y2}" marker-end="url(#arrow-${uid}-active)"/>`;
        } else if (a.x === b.x) {
          x1 = a.x + a.w / 2;
          x2 = b.x + b.w / 2;
          y1 = a.y < b.y ? a.y + a.h : a.y;
          y2 = a.y < b.y ? b.y : b.y + b.h;
          activeMarkup += `<path class="diagram-edge edge-active" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#arrow-${uid}-active)"/>`;
        } else {
          x1 = a.x < b.x ? a.x + a.w : a.x;
          y1 = a.y + a.h / 2;
          x2 = a.x < b.x ? b.x : b.x + b.w;
          y2 = b.y + b.h / 2;
          const mid = (x1 + x2) / 2;
          activeMarkup += `<path class="diagram-edge edge-active" d="M${x1} ${y1} C${mid} ${y1},${mid} ${y2},${x2} ${y2}" marker-end="url(#arrow-${uid}-active)"/>`;
        }
      }
    }
  }
  const nodeMarkup = nodes
    .map((n) => {
      const c = componentById(n.id);
      return `<g class="component ${selected === n.id || activeIds.includes(n.id) ? "selected" : ""}" data-component="${esc(n.id)}" role="button" tabindex="0" aria-label="Inspect ${esc(c.name)}" data-ohp-ref="${target.toUpperCase()}-COMPONENT-${esc(n.id.toUpperCase())}"><rect class="component-box" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="4"/><text x="${n.x + 13}" y="${n.y + 20}" font-size="8" fill="var(--dim)" letter-spacing="1">${esc(n.kind)}</text><text x="${n.x + 13}" y="${n.y + 42}" font-size="12" fill="var(--fg)" font-weight="600">${esc(c.shortName || c.name)}</text><text x="${n.x + 13}" y="${n.y + 60}" font-size="9" fill="var(--muted)">${esc(n.subtitle)}</text><circle cx="${n.x + n.w - 13}" cy="${n.y + 15}" r="3" fill="var(--${c.status === "Accepted" ? "ok" : c.status === "Evidence-needed" ? "risk" : c.status === "Open" ? "warn" : "accent"})"/></g>`;
    })
    .join("");
  $(target).innerHTML =
    `<svg class="architecture-diagram" viewBox="0 0 770 490" role="img" aria-label="Runtime architecture diagram. Components can be selected for details."><defs><marker id="arrow-${uid}-base" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--strong)"/></marker><marker id="arrow-${uid}-active" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="var(--accent)"/></marker></defs><rect x="225" y="18" width="300" height="450" rx="5" fill="var(--soft)" stroke="var(--line)" stroke-dasharray="4 5"/><text x="241" y="37" font-size="9" fill="var(--accent)" letter-spacing="1.2">SHARED SERVICE / ONE CODEBASE</text>${edgeMarkup}${activeMarkup}${nodeMarkup}<text x="23" y="469" font-size="8" fill="var(--dim)">CLIENT / OPERATOR / HOST</text><text x="561" y="469" font-size="8" fill="var(--dim)">IDENTITY / PROVIDERS / EVENTS</text></svg>`;
}
function renderInspector(id, target = "#system-inspector") {
  const c = componentById(id);
  if (!c) return;
  $(target).innerHTML =
    `<div class="inspector-head"><div class="eyebrow">Component / ${esc(c.id)}</div><h3>${esc(c.name)}</h3>${badge(c.status)}</div><div class="inspector-body">${detail("Owner", c.owner)}${detail("Responsibility", c.responsibility)}${c.input ? detail("Input / output", c.input + " " + c.output) : ""}${c.state ? detail("Owned state", c.state) : ""}${detail("Interfaces", c.interfaces)}${detail("Invariant", c.invariant)}${detail("Failure / recovery", c.failure)}${detail("Extension path", c.extension)}${c.holds ? detail("Implementation holds", c.holds) : ""}${c.modules ? `<div class="detail"><div class="eyebrow">Module owners</div><div class="linkrow">${c.modules.map((m) => `<a href="#modules" data-component-link="${esc(m)}">${esc(m)} →</a>`).join("")}</div></div>` : ""}<div class="detail"><div class="eyebrow">Traceability</div><div class="linkrow">${sourceLink(c.source)}${c.api ? `<a href="#api" data-api="${esc(c.api)}">API contract →</a>` : ""}${(
      c.decisions || [c.decision]
    )
      .filter(Boolean)
      .map(
        (d) => `<a href="#decisions" data-decision="${esc(d)}">${esc(d)} →</a>`,
      )
      .join("")}</div></div></div>`;
}
function selectComponent(id) {
  selectedComponent = id;
  renderModuleDependencies(id);
  renderInspector(id);
  renderInspector(id, "#module-inspector");
  renderDiagram("#system-diagram");
  $$(".module-card").forEach((card) =>
    card.classList.toggle("selected", card.dataset.component === id),
  );
  if (currentView === "flows") {
    renderFlow();
    $("#flow-inspector").hidden = false;
    renderInspector(id, "#flow-inspector");
    $("#flow-inspector").scrollIntoView({ block: "nearest" });
  }
}
function renderModuleDependencies(id) {
  const c = componentById(id);
  if (!c?.id?.startsWith("M")) return;
  const peers = (ids) =>
    ids?.length
      ? ids
          .map(
            (id) =>
              `<button data-component="${esc(id)}">${esc(id)}<small>${esc(componentById(id)?.name)}</small></button>`,
          )
          .join("")
      : '<p class="muted">None shown</p>';
  $("#module-dependencies").innerHTML =
    `<div class="surface-head"><h3>Dependency direction / ${esc(c.id)}</h3><span class="eyebrow">Select a related owner</span></div><div class="dependency-lens"><div><div class="eyebrow">Called by</div>${peers(c.calledBy)}</div><div class="dependency-selected"><span class="muted">→</span><button data-component="${esc(c.id)}">${esc(c.id)}<small>${esc(c.name)}</small></button><span class="muted">→</span></div><div><div class="eyebrow">Depends on</div>${peers(c.dependsOn)}</div></div>`;
}
function renderModules() {
  const q = $("#module-search").value.toLowerCase();
  const found = (MODEL.modules || MODEL.components).filter((c) =>
    JSON.stringify(c).toLowerCase().includes(q),
  );
  $("#module-grid").innerHTML = found.length
    ? found
        .map(
          (c) =>
            `<button class="module-card" data-component="${esc(c.id)}" data-ohp-ref="MODULE-${esc(c.id.toUpperCase())}">${badge(c.status)}<h3>${esc(c.name)}</h3><p>${esc(c.responsibility)}</p><div class="eyebrow">Owner / ${esc(c.owner)}</div></button>`,
        )
        .join("")
    : '<p class="no-results">No modules match this filter.</p>';
}
function renderFlow() {
  const f = MODEL.flows.find((f) => f.id === selectedFlow);
  if (!f) return;
  flowIndex = Math.max(0, Math.min(flowIndex, f.steps.length - 1));
  const s = f.steps[flowIndex];
  s.local = f.id === "F01" && flowIndex === 0;
  $("#flow-name").textContent = f.name;
  $("#flow-status").outerHTML =
    `<span id="flow-status" class="status ${f.id === "F01" ? "evidence-needed" : "proposed"}">${f.id === "F01" ? "Engineering / evidence-needed" : "Proposed sequence"}</span>`;
  $("#flow-current").textContent = `${s.title} / ${s.route}`;
  $("#flow-counter").textContent =
    `${String(flowIndex + 1).padStart(2, "0")} / ${String(f.steps.length).padStart(2, "0")}`;
  $("#flow-steps").innerHTML = f.steps
    .map(
      (s, i) =>
        `<button class="step-button ${i === flowIndex ? "active" : ""}" data-step="${i}" aria-current="${i === flowIndex ? "step" : "false"}"><span class="step-number">${i + 1}</span><span>${esc(s.title)}<small>${esc(s.route || `${s.from} → ${s.to}`)}</small></span></button>`,
    )
    .join("");
  renderDiagram(
    "#flow-diagram",
    s.local ? [s.from] : [...new Set((s.edges || [[s.from, s.to]]).flat())],
    s.local ? [] : s.edges || [s.from, s.to],
  );
  $("#step-detail").innerHTML =
    `<article class="step-detail" data-ohp-ref="FLOW-${esc(f.id.toUpperCase())}-${flowIndex + 1}"><div class="eyebrow">Step ${flowIndex + 1} / ${s.local ? "Local interaction" : esc(s.route)}</div><h3>${esc(s.title)}</h3>${badge(s.status)}<p class="muted" style="font-size:11px;margin:10px 0">${esc(s.route)} / ${esc(f.routes)}</p><div class="detail-grid">${detail("Data crossing the boundary", s.data)}${detail("Authority / durable effect", s.authority)}${detail("Failure / interruption", s.failure)}</div><div class="linkrow">${sourceLink(s.source || f.source)}${s.api ? `<a href="#api" data-api="${esc(s.api)}">API contract →</a>` : ""}</div></article>`;
  $("#previous-step").disabled = flowIndex === 0;
  $("#next-step").disabled = flowIndex === f.steps.length - 1;
  $("#flow-decision").innerHTML = f.decision
    ? decisionWidget(
        MODEL.decisions.find((d) => d.id === f.decision),
        "flow",
      )
    : "";
}
function renderApi() {
  const q = $("#api-search").value.toLowerCase(),
    family = $("#api-filter").value;
  const rows = MODEL.apis.filter(
    (a) =>
      (!family || a.family === family) &&
      JSON.stringify(a).toLowerCase().includes(q),
  );
  $("#api-rows").innerHTML = rows.length
    ? rows
        .map(
          (a) =>
            `<tr data-api-row="${esc(a.id)}" tabindex="0" aria-label="Inspect ${esc(a.name)}" aria-selected="false"><td><span class="method">${esc(a.method)}</span> <span class="route">${esc(a.route)}</span><small>${esc(a.name)}</small></td><td>${esc(a.caller)}<small>${esc(a.authority)}</small></td><td>${esc(a.owner)}</td><td>${badge(a.status)}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="no-results">No API contracts match this filter.</td></tr>';
}
function selectApi(id) {
  const a = MODEL.apis.find((a) => a.id === id);
  if (!a) return;
  $$("[data-api-row]").forEach((row) =>
    row.setAttribute("aria-selected", String(row.dataset.apiRow === id)),
  );
  $("#api-detail").innerHTML =
    `<div class="surface-head"><h3>${esc(a.name)}</h3>${badge(a.status)}</div><div class="surface-body" data-ohp-ref="API-${esc(a.id.toUpperCase())}"><p class="route"><span class="method">${esc(a.method)}</span> ${esc(a.route)}</p><div class="detail-grid" style="margin-top:18px">${detail("Caller / authority", `${a.caller}. ${a.authority}`)}${detail("Request", a.request)}${detail("Response / transport", a.response)}${detail("Errors / interruption", a.failure)}${detail("Engineering / evidence holds", a.holds)}</div><div class="linkrow">${sourceLink(a.source)}<a href="#modules" data-component-link="${esc(a.component)}">Inspect owner →</a></div></div>`;
  $("#api-decision").innerHTML = a.decision
    ? decisionWidget(
        MODEL.decisions.find((d) => d.id === a.decision),
        "api",
      )
    : "";
}
function decisionWidget(d, location) {
  if (!d) return "";
  const ref = `DECISION-${d.id.toUpperCase()}-${location.toUpperCase()}`;
  return `<article class="surface decision-card" id="decision-${esc(d.id)}-${location}" data-ohp-ref="${esc(ref)}"><div class="decision-context">${badge(d.status)}<span class="eyebrow">${esc(d.id)} / ${esc(d.owner)}</span></div><h3>${esc(d.question)}</h3><p>${esc(d.context)}</p><div class="callout"><h3>${d.status === "Accepted" ? "Accepted policy" : "Engineering approach"}</h3><p>${esc(d.recommendation)}</p></div><div class="detail-grid">${detail("Remaining engineering / evidence", d.engineering)}</div><div class="linkrow">${sourceLink(d.source)}${d.flow ? `<a href="#flows" data-flow="${esc(d.flow)}">Related flow →</a>` : ""}</div></article>`;
}
function renderPlanDependencies(id) {
  const phase = MODEL.phases.find((p) => p.id === id);
  if (!phase) return;
  const peers = (ids) =>
    ids.length
      ? ids
          .map(
            (id) =>
              `<button data-plan-node="${esc(id)}">${esc(id)}<small>${esc(MODEL.phases.find((p) => p.id === id)?.title.slice(6))}</small></button>`,
          )
          .join("")
      : '<p class="muted">No graph prerequisite</p>';
  $("#plan-dependencies").innerHTML =
    `<div class="surface-head"><h3>Implementation dependencies / ${esc(id)}</h3><span class="eyebrow">Select a slice</span></div><div class="dependency-lens"><div><div class="eyebrow">Requires</div>${peers(MODEL.planEdges.filter((e) => e[1] === id).map((e) => e[0]))}</div><div class="dependency-selected"><span class="muted">→</span><a href="#phase-${esc(id)}">${esc(id)}<small>${esc(phase.title.slice(6))}</small></a><span class="muted">→</span></div><div><div class="eyebrow">Enables</div>${peers(MODEL.planEdges.filter((e) => e[0] === id).map((e) => e[1]))}</div></div>`;
}
function showSourceLens(lens) {
  $$(".source-lens").forEach(
    (panel) => (panel.hidden = panel.id !== `source-${lens}`),
  );
  $$("[data-source-lens]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.sourceLens === lens)),
  );
}
function renderLimitations() {
  const q = $("#limits-search").value.toLowerCase();
  const rows = MODEL.limitations.filter((row) =>
    row.join(" ").toLowerCase().includes(q),
  );
  $("#limits-rows").innerHTML = rows.length
    ? rows
        .map((row) => {
          const cells =
            row.length === 5
              ? row
              : [row[0], row[1], "Behavioral gap", row[2], row[3]];
          return `<tr data-ohp-ref="LIMIT-${esc(cells[0])}">${cells.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`;
        })
        .join("")
    : '<tr><td colspan="5">No limitations match this search.</td></tr>';
}
function renderSources() {
  $("#document-index").innerHTML = MODEL.sources.map(s => sourceLink(s.id, s.title)).join("");
  $("#source-list").innerHTML = MODEL.sources.map(s =>
    `<article class="surface source-row" id="source-doc-${esc(s.id)}" data-ohp-ref="SOURCE-${esc(s.id.toUpperCase())}"><div class="eyebrow">${esc(s.kind)}</div><h3>${esc(s.title)}</h3><p>${esc(s.description)}</p><details class="document-details"><summary>Read current document</summary><div class="document-content">${s.html}</div></details><details class="source-metadata"><summary>Source file and verification</summary><code>${esc(s.path)}</code><p>SHA-256 ${esc(s.sha256)}</p><details><summary>Original Markdown</summary><pre>${esc(s.content)}</pre></details></details></article>`
  ).join("");
}
function renderOverview() {
  const product = MODEL.sources.find(s => s.id === "product");
  const prd = MODEL.sources.find(s => s.id === "prd");
  const inline = source => source.html.replaceAll(`id="doc-${source.id}-`, `id="intro-${source.id}-`);
  $("#product-overview").innerHTML = inline(product).replaceAll('href="#sources" data-source="prd" data-anchor=""', 'href="#intro-prd-product-requirements" data-scroll-id="intro-prd-product-requirements"');
  $("#product-requirements").innerHTML = inline(prd);
  $("#prd-toc").innerHTML = prd.headings.slice(1).map(h => `<a href="#intro-prd-${esc(h.anchor)}" data-scroll-id="intro-prd-${esc(h.anchor)}">${esc(h.title)}</a>`).join("");
}
function navigateLink(a) {
  if (a.dataset.scrollId) {
    document.getElementById(a.dataset.scrollId)?.scrollIntoView({block: "start"});
    return;
  }
  if (a.dataset.sourceLensLink) showSourceLens(a.dataset.sourceLensLink);
  if (a.dataset.source) showSourceLens("snapshots");
  if (a.hash.startsWith("#decision-") || a.hash.startsWith("#phase-")) {
    document
      .getElementById(a.hash.slice(1))
      ?.scrollIntoView({ block: "start" });
    return;
  }
  if (a.dataset.flow) {
    selectedFlow = a.dataset.flow;
    flowIndex = 0;
    $("#flow-select").value = selectedFlow;
    renderFlow();
  }
  if (a.dataset.api) {
    $("#api-search").value = "";
    $("#api-filter").value = "";
    renderApi();
    selectApi(a.dataset.api);
  }
  if (a.dataset.componentLink) {
    selectComponent(a.dataset.componentLink);
  }
  showView(a.hash.slice(1));
  if (a.dataset.source) {
    const el = $(`#source-doc-${a.dataset.source}`);
    if (el) $(".document-details", el).open = true;
    const target = a.dataset.anchor ? document.getElementById(`doc-${a.dataset.source}-${a.dataset.anchor}`) : el;
    target?.scrollIntoView({ block: "start" });
  }
  if (a.dataset.decision) {
    setTimeout(
      () =>
        $(`#decision-${a.dataset.decision}-queue`)?.scrollIntoView({
          block: "center",
        }),
      20,
    );
  }
}
function renderPrintReview() {
  const table = (heads, rows) =>
    `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const page = (title, body) =>
    `<section class="print-page"><div class="eyebrow">Tableau integration backend / current specification / ${esc(MODEL.date)}</div><h2>${title}</h2>${body}</section>`;
  const firstSentence = (text) => text.split(/(?<=\.)\s+/)[0];
  const apis = MODEL.apis.map((a) => [
    `${a.id} ${a.method} ${a.route}`,
    a.owner,
    a.status,
  ]);
  const midpoint = Math.ceil(apis.length / 2);
  const highLimits = MODEL.limitations.filter((r) =>
    ["L01", "L02", "L13", "L14", "L19", "L24"].includes(r[0]),
  );
  $("#print-review").innerHTML =
    page("0. What this service does", $("#product-overview").innerHTML.replace(/ id="[^"]*"/g, "") + `<p class="print-note">This is a compact summary. The standalone HTML includes the full PRD, all ${MODEL.sources.length} current source documents, contracts and verification criteria.</p>`) +
    page(
      "1. " + $("#system-title").textContent.trim().replace(/\.$/, ""),
      `<p class="print-note">Accepted deployment shape; ordinary HTTP and explicit Jobs are separate. Revised documents and runtime remain unverified. No application or hosting verification is implied.</p>${$(
        "#system-diagram",
      )
        .innerHTML.replaceAll("system-diagram", "print-system-diagram")
        .replace(
          / data-ohp-ref="[^"]*"/g,
          "",
        )}<p class="print-note">${esc(MODEL.streamingSummary)}</p><p class="print-note">API and worker exchange durable job state through Postgres. Entrusted authenticators stay private; intentional native provider-created credentials may be returned. Optional Redis events can be missed; durable Jobs and callbacks are independent.</p>`,
    ) +
    page(
      "2. Seven journeys to verify",
      table(
        ["Journey", "Status and unresolved mechanism", "API routes", "Hold"],
        MODEL.flows.map((f) => [f.name, f.statusNote, f.routes, f.decision]),
      ) +
        `<p class="print-note">The interactive HTML exposes every exact payload, authority/durable effect and failure boundary across ${MODEL.flows.reduce((n, f) => n + f.steps.length, 0)} steps. No ordinary business request is automatically replayed.</p>`,
    ) +
    page(
      "3. Module ownership",
      table(
        ["Owner", "Responsibility", "Invariant", "Holds"],
        MODEL.modules.map((m) => [
          `${m.id} ${m.name}`,
          m.responsibility,
          m.invariant,
          m.decisions.join(", "),
        ]),
      ) +
        `<p class="print-note">Modules are code boundaries in one maintained codebase. Inputs/outputs, state, dependencies, recovery and extension interfaces remain inspectable in the HTML.</p>`,
    ) +
    page(
      "4. API inventory / first half",
      `<p class="print-note">Draft wire shape; routes with unresolved holds are not implemented. ${MODEL.apis.filter(a => a.status === "Open").map(a => a.id).join("/")} are intentionally unset Open surfaces.</p>${table(["Contract", "Owner", "State"], apis.slice(0, midpoint))}`,
    ) +
    page(
      "4. API inventory / second half",
      `${table(["Contract", "Owner", "State"], apis.slice(midpoint))}`,
    ) +
    page(
      "5. Accepted policies and engineering work",
      `<p class="print-note">These current policies are settled; implementation and platform evidence remain outstanding.</p><div class="print-columns">${[MODEL.decisions.slice(0, 4), MODEL.decisions.slice(4)].map((group) => `<div>${group.map((d) => `<article class="print-card">${badge(d.status)} <strong>${esc(d.id)}</strong><h3>${esc(d.question)}</h3><p>${esc(firstSentence(d.recommendation))}</p></article>`).join("")}</div>`).join("")}</div>`,
    ) +
    page(
      "6. Dependency-ordered build slices",
      table(
        ["Slice", "Owners / dependency", "Exit evidence", "Tasks"],
        MODEL.phases.map((p) => [
          p.title,
          p.owners + " / " + ([...new Set(p.dependsOn.match(/B\d\d/g) || [])].join(", ") || "External prerequisites"),
          firstSentence(p.gate),
          String(p.tasks.length),
        ]),
      ) +
        `<p class="print-note">This is planning, not application implementation authorization. The HTML includes the exact proposed tasks, engineering holds, risks and dependency navigation. B01 evidence collection can run alongside interface/test planning.</p>`,
    ) +
    page(
      "7. Limits, evidence and source traceability",
      `<div class="print-columns"><div><h3>Accepted caps and engineering limits</h3>${table(
        ["ID / area", "Status"],
        highLimits.map((r) => [r[0] + " " + r[1], r[2]]),
      )}<p class="print-note">All ${MODEL.limitations.length} current limitation findings and treatments remain searchable in the HTML. Native streams have measured physical resource bounds; job input and result size policies remain separate.</p></div><div><h3>Evidence gates</h3>${MODEL.evidence.map((r) => `<article class="print-card"><strong>${esc(r[0])}</strong> ${esc(r[1])}</article>`).join("")}</div></div><h3>Complete current specification</h3><p class="print-note">All ${MODEL.sources.length} maintained source documents are embedded with working internal links and content hashes in the HTML. This print summary omits their full bodies. Historical decision records are excluded from current build guidance.</p>`,
    );
}

function init() {
  renderSources();
  renderOverview();
  renderLimitations();
  $("#evidence-gates").innerHTML = MODEL.evidence
    .map(
      (row) =>
        `<article class="surface surface-body" data-ohp-ref="EVIDENCE-${esc(row[0])}">${badge("Evidence-needed")}<h3 style="margin:10px 0">${esc(row[0])}</h3><p>${esc(row[1])}</p><p class="muted" style="margin-top:10px">${esc(row[2])}</p><div class="linkrow">${sourceLink("decisions")}</div></article>`,
    )
    .join("");
  $("#trust-lens").innerHTML =
    `<div class="table-wrap"><table><thead><tr><th>Boundary / data</th><th>Producer → consumer</th><th>Enforcement</th><th>Persistence</th></tr></thead><tbody>${(MODEL.classifications || []).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="diagram-caption">${sourceLink("system", "Inspect trust and data classification source")}</div>`;
  $("#flow-select").innerHTML = MODEL.flows
    .map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`)
    .join("");
  $("#api-filter").innerHTML += [...new Set(MODEL.apis.map((a) => a.family))]
    .map((f) => `<option>${esc(f)}</option>`)
    .join("");
  $("#decision-jumps").innerHTML = MODEL.decisions
    .map((d) => `<a href="#decision-${esc(d.id)}-queue">${esc(d.id)}</a>`)
    .join("");
  $("#decision-list").innerHTML = MODEL.decisions
    .map((d) => decisionWidget(d, "queue"))
    .join("");
  $("#plan-list").innerHTML = MODEL.phases
    .map(
      (p) =>
        `<article class="surface plan-row" id="phase-${esc(p.id)}" data-ohp-ref="PLAN-${esc(p.id)}"><div class="plan-num">${esc(p.id)}</div><div>${badge("Proposed")}<h3>${esc(p.title.slice(6))}</h3><div class="detail-grid">${detail("Owners", p.owners)}${detail("Depends on / holds", p.dependsOn + " " + p.holds)}</div><details class="plan-tasks"><summary>Inspect ${p.tasks.length} proposed tasks</summary><ul>${p.tasks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details><div class="plan-gate"><div class="eyebrow">Exit evidence</div><p>${esc(p.gate)}</p></div>${p.risk ? `<div class="callout warning"><h3>Risk boundary</h3><p>${esc(p.risk)}</p></div>` : ""}<div class="linkrow"><button data-plan-node="${esc(p.id)}">Inspect dependencies</button>${sourceLink(p.source)}</div></div></article>`,
    )
    .join("");
  renderPlanDependencies("B00");
  $("#streaming-summary").textContent = MODEL.streamingSummary;
  $("#system-summary").innerHTML =
    `<div class="strip">${MODEL.summary.map((s) => `<div><div class="eyebrow">${esc(s.label)}</div><strong>${esc(s.title)}</strong><p>${esc(s.detail)}</p></div>`).join("")}</div>`;
  $("#system-decision").innerHTML = MODEL.systemDecision
    ? decisionWidget(
        MODEL.decisions.find((d) => d.id === MODEL.systemDecision),
        "system",
      )
    : "";
  $("#all-flows-print").innerHTML = MODEL.flows
    .map(
      (f) =>
        `<h3 style="margin-top:20px">${esc(f.name)}</h3>${f.steps.map((s, i) => `<div class="print-step"><strong>${i + 1}. ${esc(s.title)}</strong><p>${esc(s.route)} / ${esc(s.data)}</p><p>Authority / durable effect: ${esc(s.authority)}</p><p>Failure: ${esc(s.failure)}</p></div>`).join("")}`,
    )
    .join("");
  renderDiagram("#system-diagram");
  renderInspector(selectedComponent);
  renderInspector(
    MODEL.modules?.[0]?.id || selectedComponent,
    "#module-inspector",
  );
  renderModules();
  renderModuleDependencies(MODEL.modules?.[0]?.id);
  renderApi();
  selectApi(MODEL.apis[0]?.id);
  renderFlow();
  renderPrintReview();
  showView(location.hash.slice(1) || "overview", false);
}
document.addEventListener("click", (event) => {
  const planNode = event.target.closest("[data-plan-node]");
  if (planNode) {
    renderPlanDependencies(planNode.dataset.planNode);
    $("#plan-dependencies").scrollIntoView({ block: "nearest" });
    return;
  }
  const sourceLens = event.target.closest("[data-source-lens]");
  if (sourceLens) {
    showSourceLens(sourceLens.dataset.sourceLens);
    return;
  }
  const lens = event.target.closest("[data-system-lens]");
  if (lens) {
    $("#system-workspace").classList.toggle(
      "trust-active",
      lens.dataset.systemLens === "trust",
    );
    $("#system-inspector").hidden = lens.dataset.systemLens === "trust";
    $("#runtime-lens").hidden = lens.dataset.systemLens !== "runtime";
    $("#trust-lens").hidden = lens.dataset.systemLens !== "trust";
    $$("[data-system-lens]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b === lens)),
    );
    return;
  }
  const component = event.target.closest("[data-component]");
  if (component) {
    selectComponent(component.dataset.component);
    return;
  }

  const step = event.target.closest("[data-step]");
  if (step) {
    flowIndex = Number(step.dataset.step);
    renderFlow();
    return;
  }
  const api = event.target.closest("[data-api-row]");
  if (api) {
    selectApi(api.dataset.apiRow);
    if (innerWidth < 1200)
      $("#api-detail").scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const a = event.target.closest('a[href^="#"]');
  if (a && !a.classList.contains("skip-link")) {
    event.preventDefault();
    navigateLink(a);
  }
});
document.addEventListener("keydown", (event) => {
  const c = event.target.closest("[data-component],[data-api-row]");
  if (c && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    c.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  if (
    event.target.closest("[data-step]") &&
    ["ArrowLeft", "ArrowRight"].includes(event.key)
  ) {
    event.preventDefault();
    flowIndex += event.key === "ArrowRight" ? 1 : -1;
    renderFlow();
    $("[data-step].active")?.focus();
  }
});
$("#flow-select").addEventListener("change", (event) => {
  selectedFlow = event.target.value;
  flowIndex = 0;
  renderFlow();
});
$("#previous-step").addEventListener("click", () => {
  flowIndex--;
  renderFlow();
});
$("#next-step").addEventListener("click", () => {
  flowIndex++;
  renderFlow();
});
$("#limits-search").addEventListener("input", renderLimitations);
$("#module-search").addEventListener("input", renderModules);
$("#api-search").addEventListener("input", renderApi);
$("#api-filter").addEventListener("change", renderApi);
$("#print-button").addEventListener("click", () => window.print());
window.addEventListener("hashchange", () =>
  showView(location.hash.slice(1), false),
);
init();
