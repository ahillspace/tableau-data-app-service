/* Offline documentation viewer. Every value comes from MODEL, which build.py derives from docs/. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const VIEWS = ["overview", "capabilities", "architecture", "flows", "api", "verification", "documents"];
  const sources = new Map(MODEL.sources.map((s) => [s.id, s]));
  const sourceByPath = new Map(MODEL.sources.map((s) => [s.path, s]));

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const clear = (node) => {
    node.replaceChildren();
    return node;
  };
  const fill = (node, ...children) => clear(node).append(el("div", { style: "display:contents" }, ...children));

  function highlight(text, query) {
    if (!query) return [text];
    const out = [];
    const lower = text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, at)) {
      out.push(text.slice(at, i), el("mark", { text: text.slice(i, i + query.length) }));
      at = i + query.length;
    }
    out.push(text.slice(at));
    return out;
  }

  function docLink(path, label) {
    const [file, anchor] = String(path).split("#");
    const source = sourceByPath.get(file);
    if (!source) return el("span", { class: "muted", text: label || path });
    return el("a", {
      href: `#documents/${source.id}${anchor ? `/${anchor}` : ""}`,
      text: label || source.title,
    });
  }

  /* Overview */
  function renderOverview() {
    const product = sources.get("product");
    const intro = clear($("product-intro"));
    if (product) {
      const doc = new DOMParser().parseFromString(product.html, "text/html");
      const nodes = [...doc.body.children];
      const end = nodes.findIndex((n, i) => i > 0 && /^H[23]$/.test(n.tagName));
      for (const node of nodes.slice(0, end === -1 ? 4 : end)) intro.append(document.importNode(node, true));
      intro.append(el("p", {}, docLink(product.path, "Read the full product document")));
    }
    const v = MODEL.verification;
    const summary = clear($("gate-summary"));
    summary.append(
      el("p", {}, el("strong", { text: `${v.checks.length} automated checks` }), el("span", { class: "muted", text: " run with npm test against real Postgres and Redis." })),
      el("p", {}, el("strong", { text: `${v.unverified.length} items` }), el("span", { class: "muted", text: " not yet verified against live Tableau Cloud and Slack." })),
      el("p", {}, el("strong", { text: `${v.limitations.length} known limitations.` })),
    );
    summary.append(el("p", {}, el("a", { href: "#verification", text: "Open the verification view" })));
    const journeys = clear($("journeys"));
    for (const j of MODEL.product.journeys) journeys.append(el("dt", { text: j.name }), el("dd", { text: j.text }));
    $("rail-foot").textContent = `${MODEL.sources.length} documents - ${MODEL.verification.checks.length} checks - ${MODEL.api.routes.length} routes`;
  }

  /* What it does */
  function renderCapabilities() {
    const query = $("capability-filter").value.trim().toLowerCase();
    const match = (...texts) => !query || texts.some((t) => t.toLowerCase().includes(query));
    const list = clear($("capability-list"));
    let shown = 0;
    for (const c of MODEL.product.capabilities) {
      const points = c.points.filter((p) => match(p, c.group));
      if (!points.length) continue;
      shown++;
      list.append(el("div", { class: "group" }, el("h3", { text: c.group }), el("ul", { class: "bullets" }, points.map((p) => el("li", {}, highlight(p, query))))));
    }
    if (!shown) list.append(el("p", { class: "empty", text: "Nothing matches." }));
    const exclusions = clear($("exclusion-list"));
    for (const x of MODEL.product.exclusions) if (match(x)) exclusions.append(el("li", {}, highlight(x, query)));
  }

  /* Architecture */
  let selectedComponent = 0;
  function componentFacts(c) {
    return el("dl", { class: "facts" },
      [["Owns", c.owns], ["Interface", c.interface], ["Invariants", c.invariants], ["Failure and recovery", c.failure], ["Extension path", c.extension]]
        .filter(([, v]) => v)
        .map(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]));
  }
  function componentArticle(c, index) {
    return [
      el("p", { class: "eyebrow", text: `Component ${index + 1} of ${MODEL.architecture.components.length}` }),
      el("h2", { text: c.name }),
      componentFacts(c),
      c.detail ? el("p", { class: "doc-meta" }, "Detail: ", docLink(c.detail)) : null,
    ];
  }
  function renderArchitecture() {
    const arch = MODEL.architecture;
    $("topology").textContent = arch.topology;
    const direction = clear($("direction"));
    for (const d of arch.direction) direction.append(el("li", { text: d }));
    const roles = clear($("roles"));
    for (const r of arch.roles) roles.append(el("dt", { text: r.role }), el("dd", { text: r.runs }), el("dd", { class: "muted", text: `Scaling: ${r.scales}` }));
    const list = clear($("component-list"));
    arch.components.forEach((c, i) => {
      list.append(
        el("button", { type: "button", role: "option", "aria-selected": String(i === selectedComponent), onclick: () => selectComponent(i) },
          el("span", {}, el("span", { class: "order", text: String(i + 1).padStart(2, "0") }), c.name),
          el("small", { text: c.owns.split(/[;,.]/)[0] })),
      );
    });
    fill($("component-detail"), componentArticle(arch.components[selectedComponent], selectedComponent));
    table($("trust"), ["Boundary", "What crosses", "Relies on"], arch.trust.map((t) => [t.boundary, t.crosses, t.relies]));
    table($("dependencies"), ["Package", "Used by", "Job"], arch.dependencies.map((d) => [el("code", { text: d.package }), d.usedBy, d.job]));
  }
  function selectComponent(i) {
    selectedComponent = i;
    renderArchitecture();
    history.replaceState(null, "", `#architecture/${encodeURIComponent(MODEL.architecture.components[i].name)}`);
  }
  function table(node, headers, rows) {
    clear(node).append(
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, rows.map((row) => el("tr", {}, row.map((cell, i) => el("td", { class: i === 0 ? "" : "prose" }, cell))))),
    );
  }

  /* Flows */
  let selectedFlow = 0;
  function flowArticle(flow, index) {
    return [
      el("p", { class: "eyebrow", text: `Flow ${index + 1} of ${MODEL.flows.length}` }),
      el("h2", { text: flow.name }),
      el("ol", { class: "steps" },
        flow.steps.map((s) => el("li", {}, el("div", {}, el("div", { class: "text", text: s.text }),
          s.owners.length ? el("div", { class: "owners" }, s.owners.map((o) => ownerChip(o))) : null)))),
      flow.see ? el("p", { class: "doc-meta" }, "Detail: ", docLink(flow.see)) : null,
    ];
  }
  function ownerChip(name) {
    const index = MODEL.architecture.components.findIndex((c) => c.name === name);
    if (index === -1) return el("span", { class: "chip", text: name });
    return el("button", { type: "button", class: "chip", title: `Open the ${name} component`, onclick: () => { selectedComponent = index; go(`#architecture/${encodeURIComponent(name)}`); } }, name);
  }
  function renderFlows() {
    const list = clear($("flow-list"));
    MODEL.flows.forEach((f, i) =>
      list.append(el("button", { type: "button", "aria-current": String(i === selectedFlow), onclick: () => { selectedFlow = i; renderFlows(); history.replaceState(null, "", `#flows/${i + 1}`); } },
        el("span", { text: f.name }), el("small", { text: `${f.steps.length} steps` }))));
    fill($("flow-detail"), flowArticle(MODEL.flows[selectedFlow], selectedFlow));
  }

  /* API */
  function renderApiControls() {
    const select = $("api-group");
    select.append(el("option", { value: "", text: "All groups" }));
    for (const g of [...new Set(MODEL.api.routes.map((r) => r.group))]) select.append(el("option", { value: g, text: g }));
    $("api-preamble").textContent = MODEL.api.preamble;
  }
  function renderApi() {
    const query = $("api-filter").value.trim().toLowerCase();
    const group = $("api-group").value;
    const routes = MODEL.api.routes.filter((r) => (!group || r.group === group) && (!query || [r.route, r.auth, r.owner, r.purpose, r.group].some((t) => t.toLowerCase().includes(query))));
    const out = clear($("api-groups"));
    const groups = new Map();
    for (const r of routes) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }
    for (const [name, items] of groups) {
      const t = el("table", {});
      clear(t).append(
        el("thead", {}, el("tr", {}, ["Route", "Auth", "Owner", "Purpose"].map((h) => el("th", { scope: "col", text: h })))),
        el("tbody", {}, items.map((r) => {
          const [method, ...rest] = r.route.split(" ");
          return el("tr", {},
            el("td", { class: "route" }, el("span", { class: `method ${method.toLowerCase()}`, text: method }), highlight(rest.join(" "), query)),
            el("td", { class: "prose" }, highlight(r.auth, query)),
            el("td", {}, ownerChip(r.owner)),
            el("td", { class: "prose" }, highlight(r.purpose, query)));
        })),
      );
      out.append(el("section", { class: "surface api-group" }, el("h2", { text: name }), MODEL.api.notes[name] ? el("p", { text: MODEL.api.notes[name] }) : null, el("div", { class: "table-wrap" }, t)));
    }
    if (!groups.size) out.append(el("p", { class: "empty", text: "No route matches." }));
    $("api-count").textContent = `${routes.length} of ${MODEL.api.routes.length} routes`;
  }

  /* Verification */
  function renderVerification() {
    const v = MODEL.verification;
    table($("checks"), ["Check", "Shows", "Tests"], v.checks.map((c) => [el("strong", { text: c.id }), c.shows, c.tests]));
    const unverified = clear($("unverified"));
    for (const u of v.unverified) unverified.append(el("li", { text: u }));
    const limits = clear($("limitations"));
    for (const l of v.limitations) limits.append(el("li", { text: l }));
  }

  /* Documents */
  let selectedDoc = MODEL.sources[0].id;
  function renderDocList() {
    const list = clear($("doc-list"));
    for (const s of MODEL.sources)
      list.append(el("button", { type: "button", "aria-current": String(s.id === selectedDoc), onclick: () => go(`#documents/${s.id}`) },
        el("span", { text: s.title }), el("small", { text: `${s.kind} - ${s.path}` })));
  }
  function showDocument(id, anchor) {
    const source = sources.get(id) || MODEL.sources[0];
    selectedDoc = source.id;
    renderDocList();
    const body = $("doc-body");
    body.innerHTML = source.html;
    const toc = clear($("doc-toc"));
    for (const h of source.headings.filter((h) => h.depth === 2).slice(0, 40))
      toc.append(el("button", { type: "button", onclick: () => go(`#documents/${source.id}/${h.anchor}`) }, h.title));
    $("doc-meta").textContent = `${source.path} - sha256 ${source.sha256}`;
    const target = anchor && source.headings.find((h) => h.anchor === anchor);
    if (target) {
      const node = document.getElementById(target.id);
      node?.scrollIntoView({ block: "start" });
      node?.classList.add("flash");
      setTimeout(() => node?.classList.remove("flash"), 1500);
    } else window.scrollTo(0, 0);
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-source]");
    if (!link) return;
    event.preventDefault();
    go(`#documents/${link.dataset.source}${link.dataset.anchor ? `/${link.dataset.anchor}` : ""}`);
  });

  /* Routing */
  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }
  function route() {
    const [view, ...rest] = location.hash.slice(1).split("/").map(decodeURIComponent);
    const active = VIEWS.includes(view) ? view : "overview";
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== active;
    for (const a of document.querySelectorAll("#views a")) {
      if (a.dataset.view === active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    if (active === "architecture") {
      const i = MODEL.architecture.components.findIndex((c) => c.name === rest[0]);
      if (i !== -1) selectedComponent = i;
      renderArchitecture();
    } else if (active === "flows") {
      const i = Number(rest[0]) - 1;
      if (i >= 0 && i < MODEL.flows.length) selectedFlow = i;
      renderFlows();
    } else if (active === "documents") showDocument(rest[0] || selectedDoc, rest.slice(1).join("/"));
    if (active !== "documents" || !rest[1]) {
      window.scrollTo(0, 0);
      $("main").focus({ preventScroll: true });
    }
    document.title = `${$(`view-${active}`).querySelector(".eyebrow").textContent} - Tableau Data App Service documentation`;
  }

  /* Print shows every view, every component, every flow and every document. */
  window.addEventListener("beforeprint", () => {
    for (const v of VIEWS) $(`view-${v}`).hidden = false;
    fill($("component-detail"), MODEL.architecture.components.map((c, i) => el("section", {}, componentArticle(c, i))));
    fill($("flow-detail"), MODEL.flows.map((f, i) => el("section", {}, flowArticle(f, i))));
    $("doc-body").innerHTML = MODEL.sources.map((s) => s.html).join("");
    $("doc-meta").textContent = "";
  });
  window.addEventListener("afterprint", route);

  renderOverview();
  renderCapabilities();
  renderApiControls();
  renderApi();
  renderVerification();
  $("capability-filter").addEventListener("input", renderCapabilities);
  $("api-filter").addEventListener("input", renderApi);
  $("api-group").addEventListener("change", renderApi);
  window.addEventListener("hashchange", route);
  route();
})();
