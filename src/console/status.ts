import type {
  AuditEntry,
  DefinitionView,
  MetricsView,
  Observation,
  StatusView,
} from "../contracts/operator.ts";
import { type AdminApi, badge, date, element, errorText, esc, stateBox } from "./dom.ts";

const number = (value: number) => value.toLocaleString();
const observed = <T>(
  o: Observation<T>,
  content: (v: T) => string,
  current = { label: "Healthy", state: "ok" },
): string =>
  `<span data-observed-at="${esc(o.observedAt ?? "")}" data-observed-state="${o.state}">${badge(o.state === "ok" ? current.label : o.state.charAt(0).toUpperCase() + o.state.slice(1), o.state === "ok" ? current.state : o.state)} ${o.value === null ? "" : content(o.value)} <span class="hint">${esc(date(o.observedAt))}</span></span>`;
const latency = (value: number | null, samples: number) =>
  value === null ? (samples ? ">120,000 ms" : "No samples") : `${number(value)} ms`;

export class Status {
  readonly #api: AdminApi;
  #statusEpoch = 0;
  #metricEpoch = 0;
  #auditEpoch = 0;
  #audit: AuditEntry[] = [];
  #auditMore = false;
  constructor(api: AdminApi) {
    this.#api = api;
  }

  clear(): void {
    this.#statusEpoch++;
    this.#metricEpoch++;
    this.#auditEpoch++;
    this.#audit = [];
    element("status").replaceChildren();
  }

  mount(): void {
    element("status").innerHTML =
      `<div class="heading"><div><h1>Status &amp; analytics</h1><p class="muted">One view across API replicas and workers.</p></div><button id="refreshStatus">Refresh</button></div><div id="statusObservations"></div><div class="toolbar"><label class="label" for="range">Time range</label><select id="range"><option value="1">Last complete hour</option><option value="24">Last 24 complete hours</option></select><label class="label" for="metricDefinition">Definition</label><select id="metricDefinition"><option value="">All providers</option></select><span class="spacer"></span><span class="hint">Minute aggregates - approximate</span></div><div id="metricContent"></div><section class="section"><h2>Recent audit events</h2><div class="toolbar"><label class="field">Action<input id="auditAction" placeholder="Exact action, e.g. definition.update"></label><label class="field">Definition<select id="auditDefinition"><option value="">All definitions</option></select></label><button id="filterAudit">Apply filters</button></div><div id="auditContent"></div></section>`;
    element("refreshStatus").onclick = () => {
      void this.load();
    };
    for (const id of ["range", "metricDefinition"])
      element(id).onchange = () => {
        void this.#metrics();
      };
    element("filterAudit").onclick = () => {
      void this.#audits(true);
    };
    element("auditAction").onkeydown = (e) => {
      if (e.key === "Enter") void this.#audits(true);
    };
    element("status").onclick = (e) => {
      const target = (e.target as Element).closest<HTMLElement>(
        "[data-retry-observations],[data-retry-metrics],[data-retry-audit],[data-more-audit]",
      );
      if (target?.hasAttribute("data-retry-observations")) void this.#observations();
      if (target?.hasAttribute("data-retry-metrics")) void this.#metrics();
      if (target?.hasAttribute("data-retry-audit")) void this.#audits(true);
      if (target?.hasAttribute("data-more-audit")) void this.#audits(false);
    };
  }

  definitions(definitions: DefinitionView[]): void {
    for (const id of ["metricDefinition", "auditDefinition"]) {
      const select = element<HTMLSelectElement>(id);
      const before = select.value;
      select.innerHTML = `<option value="">All providers</option>${definitions.map((d) => `<option value="${esc(d.id)}">${esc(d.displayName)}</option>`).join("")}`;
      if (definitions.some((d) => d.id === before)) select.value = before;
    }
  }

  async load(): Promise<void> {
    await Promise.all([this.#observations(), this.#metrics(), this.#audits(true)]);
  }

  async #observations(): Promise<void> {
    const epoch = ++this.#statusEpoch;
    element("statusObservations").innerHTML = stateBox(
      "Loading service observations",
      "Reading dependencies, processes and current state counts.",
    );
    try {
      const s = await this.#api.request<StatusView>("GET", "/v1/admin/status");
      if (epoch !== this.#statusEpoch) return;
      const counts = (value: Record<string, number>) =>
        Object.entries(value)
          .map(([key, n]) => `${number(n)} ${esc(key)}`)
          .join(" · ") || "No records";
      element("statusObservations").innerHTML =
        `<div class="row"><div class="actions">${observed(s.readiness, (v) => (v.ready ? "Ready to serve requests" : "Requests are not ready"), s.readiness.value?.ready === false ? { label: "Not ready", state: "unavailable" } : undefined)}</div><span class="hint">v${esc(s.version)} · revision ${s.revision}</span></div><div class="notice" id="observationAge" hidden>These observations have aged. Refresh before relying on their state.</div><div class="cols"><section><h2>Dependencies</h2><dl class="props"><dt>Database</dt><dd>${observed(s.database, (v) => (v.reachable ? "Reachable" : "Not reachable"))}</dd><dt>Events</dt><dd>${observed(s.events, (v) => (v.connected ? "Redis connected" : "Not connected"))}${s.events.state === "disabled" ? '<span class="hint">No event bus configured</span>' : ""}</dd></dl></section><section><h2>Connections &amp; Jobs</h2><dl class="props"><dt>Connections</dt><dd>${observed(s.connections, counts)}</dd><dt>Jobs</dt><dd>${observed(s.jobs, counts)}</dd></dl></section></div><section class="section"><h2>Processes</h2>${s.processes.length ? `<div class="scroll-x"><table><caption class="screen-reader">API and worker heartbeat observations</caption><thead><tr><th>Instance</th><th>Role</th><th>Uptime</th><th>Last heartbeat</th><th>State</th></tr></thead><tbody>${s.processes.map((p) => `<tr><td><code>${esc(p.instanceId)}</code></td><td>${p.role === "api" ? "API" : "Worker"}</td><td>${Math.floor(p.uptimeSeconds / 3600)}h ${Math.floor(p.uptimeSeconds / 60) % 60}m</td><td>${esc(date(p.lastHeartbeatAt))}</td><td>${observed({ state: p.state, observedAt: p.lastHeartbeatAt, value: null }, () => "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="notice">No process heartbeats have been observed. Worker presence is unknown.</div>'}</section><section class="section"><h2>Activity in the last 15 minutes</h2>${observed(s.activity, (v) => `${number(v.activeSessions)} active sessions · ${number(v.activeApps)} active apps`)}<p class="hint section-note">Unexpired sessions with recent authenticated requests, and distinct registered app IDs among those app sessions. Last-seen writes are coalesced to once per minute. These counts do not represent people or workbook instances.</p></section>`;
      this.markStale();
    } catch (error) {
      if (epoch === this.#statusEpoch)
        element("statusObservations").innerHTML =
          `${stateBox("Status is unavailable", errorText(error))}<button data-retry-observations>Retry status</button>`;
    }
  }

  markStale(): void {
    const root = document.getElementById("statusObservations");
    if (!root) return;
    let aged = false;
    root.querySelectorAll<HTMLElement>("[data-observed-at]").forEach((node) => {
      if (
        node.dataset.observedState === "disabled" ||
        node.dataset.observedState === "unavailable" ||
        node.dataset.observedState === "unknown"
      )
        return;
      if (
        node.dataset.observedState === "stale" ||
        Date.now() - Date.parse(node.dataset.observedAt!) > 45_000
      ) {
        aged = true;
        const b = node.querySelector<HTMLElement>(".badge")!;
        b.textContent = "Stale";
        b.className = "badge warn";
      }
    });
    const note = document.getElementById("observationAge");
    if (note) note.hidden = !aged;
  }

  async #metrics(): Promise<void> {
    const epoch = ++this.#metricEpoch;
    element("metricContent").innerHTML = stateBox(
      "Loading minute aggregates",
      "Combining request counts and upstream histograms across replicas.",
    );
    const to = Math.floor(Date.now() / 60_000) * 60_000;
    const from = to - Number(element<HTMLSelectElement>("range").value) * 3600_000;
    const definition = element<HTMLSelectElement>("metricDefinition").value;
    const query = new URLSearchParams({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      ...(definition ? { definition } : {}),
    });
    try {
      const m = await this.#api.request<MetricsView>("GET", `/v1/admin/metrics?${query}`);
      if (epoch !== this.#metricEpoch) return;
      const t = m.totals;
      element("metricContent").innerHTML =
        `${m.mayBeIncomplete ? '<div class="notice">Coverage is incomplete or unknown. These aggregates may omit requests.</div>' : ""}<div class="metrics"><div class="metric"><span>Native requests</span><strong>${number(t.requests)}</strong><span>Completed in selected interval</span></div><div class="metric"><span>Errors</span><strong>${number(t.errors)}${t.requests ? ` (${((t.errors / t.requests) * 100).toFixed(1)}%)` : ""}</strong><span>HTTP ≥400, failed or cancelled</span></div><div class="metric"><span>Upstream p50 / p95</span><strong>${latency(t.upstreamP50Ms, t.upstreamSamples)} / ${latency(t.upstreamP95Ms, t.upstreamSamples)}</strong><span>Time to response headers</span></div><div class="metric"><span>Credential failures</span><strong>${number(t.refreshFailures + t.exchangeFailures)}</strong><span>${number(t.refreshFailures)} refresh · ${number(t.exchangeFailures)} exchange</span></div></div><section><h2>Request volume</h2>${this.#chart(m)}<p class="hint">Counts are combined across replicas. Approximate latency percentiles use merged histogram counts; credential checkout and streaming body duration are excluded. A percentile beyond 120,000 ms is shown as overflow.</p><dl class="props subtle"><dt>Selected interval</dt><dd>${esc(date(m.from))} - ${esc(date(m.to))}</dd><dt>Flushed through</dt><dd>${esc(date(m.flushedThrough))}</dd><dt>Observed</dt><dd>${esc(date(m.observedAt))}</dd><dt>Coverage</dt><dd>Best effort. With a healthy database, a crash can lose up to the current 10-second unflushed interval. An outage can lose all buffered data.</dd></dl></section><section class="section"><h2>By provider and response status</h2>${m.series.length ? `<div class="scroll-x"><table><caption class="screen-reader">Request and credential failure minute aggregates</caption><thead><tr><th>Minute</th><th>Definition</th><th>Status</th><th>Requests</th><th>Errors</th><th>Upstream p50 / p95</th><th>Refresh / exchange failures</th></tr></thead><tbody>${m.series.map((s) => `<tr><td>${esc(date(s.minute))}</td><td>${esc(s.definitionId)}</td><td>${esc(s.status)}</td><td>${number(s.requests)}</td><td>${number(s.errors)}</td><td>${latency(s.upstreamP50Ms, s.upstreamSamples)} / ${latency(s.upstreamP95Ms, s.upstreamSamples)}</td><td>${number(s.refreshFailures)} / ${number(s.exchangeFailures)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="notice">No request or credential-operation samples in this interval.</div>'}</section>`;
    } catch (error) {
      if (epoch === this.#metricEpoch)
        element("metricContent").innerHTML =
          `${stateBox("Metrics are unavailable", errorText(error))}<button data-retry-metrics>Retry metrics</button>`;
    }
  }

  #chart(m: MetricsView): string {
    const start = Date.parse(m.from);
    const end = Date.parse(m.to);
    const minutes = Array.from({ length: (end - start) / 60_000 }, () => 0);
    for (const row of m.series) {
      const i = (Date.parse(row.minute) - start) / 60_000;
      if (Number.isInteger(i) && i >= 0 && i < minutes.length) minutes[i]! += row.requests;
    }
    const max = Math.max(1, ...minutes);
    const points = minutes
      .map((n, i) => `${40 + (i / Math.max(1, minutes.length - 1)) * 590},${120 - (n / max) * 100}`)
      .join(" ");
    return `<svg class="chart" viewBox="0 0 650 150" role="img" aria-label="Native requests per minute. Maximum ${max}. Total ${m.totals.requests}."><line x1="40" x2="630" y1="20" y2="20"/><line x1="40" x2="630" y1="70" y2="70"/><line x1="40" x2="630" y1="120" y2="120"/><text x="0" y="24">${max}</text><text x="20" y="124">0</text><polyline points="${points}"/><text x="40" y="145">${esc(new Date(start).toISOString().slice(11, 16))} UTC</text><text x="550" y="145">${esc(new Date(end).toISOString().slice(11, 16))} UTC</text></svg>`;
  }

  async #audits(reset: boolean): Promise<void> {
    const epoch = ++this.#auditEpoch;
    const query = new URLSearchParams({ limit: "100" });
    const action = element<HTMLInputElement>("auditAction").value.trim();
    const definition = element<HTMLSelectElement>("auditDefinition").value;
    if (action) query.set("action", action);
    if (definition) query.set("definition", definition);
    if (!reset && this.#audit.length) query.set("before", this.#audit.at(-1)!.id);
    if (reset) {
      this.#audit = [];
      element("auditContent").innerHTML = stateBox(
        "Loading audit events",
        "Reading the filtered operator audit log.",
      );
    } else element<HTMLButtonElement>("moreAudit").disabled = true;
    try {
      const { entries } = await this.#api.request<{ entries: AuditEntry[] }>(
        "GET",
        `/v1/admin/audit?${query}`,
      );
      if (epoch !== this.#auditEpoch) return;
      this.#audit = reset ? entries : [...this.#audit, ...entries];
      this.#auditMore = entries.length === 100;
      element("auditContent").innerHTML = this.#audit.length
        ? `<div class="scroll-x"><table><caption class="screen-reader">Recent audit events</caption><thead><tr><th>Time</th><th>Action</th><th>Subject</th><th>Actor</th></tr></thead><tbody>${this.#audit.map((entry) => `<tr><td>${esc(date(entry.at))}</td><td>${esc(entry.action)}</td><td>${esc(entry.subject ?? "-")}</td><td>${esc(entry.actor)}</td></tr>`).join("")}</tbody></table></div>${this.#auditMore ? '<button id="moreAudit" data-more-audit>Load older events</button>' : '<p class="hint">No more events in this result.</p>'}`
        : '<div class="notice">No audit events match these filters.</div>';
    } catch (error) {
      if (epoch === this.#auditEpoch)
        element("auditContent").innerHTML =
          `${stateBox("Audit events could not be loaded", errorText(error))}<button data-retry-audit>Retry audit</button>`;
    }
  }
}
