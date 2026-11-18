import type {
  Authentication,
  CatalogTemplate,
  ClientAuthentication,
  Definition,
  DefinitionView,
  Placement,
  SecretField,
  SecretMeta,
} from "../contracts/operator.ts";
import {
  type AdminApi,
  ApiError,
  badge,
  Dialogs,
  date,
  element,
  errorText,
  esc,
  showFormError,
  stateBox,
} from "./dom.ts";
import {
  clientAuthenticationReader,
  defaultAuthentication,
  definitionChanges,
  editableDefinition,
  FormError,
  METHODS,
  newDefinition,
  SECRET_LABELS,
  STATE_LABELS,
  serializeSecret,
} from "./model.ts";

type Site = { id: string; contentUrl: string; enabled: boolean };
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const option = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
const field = (label: string, name: string, value: unknown = "", type = "text", wide = false) =>
  `<label class="field ${wide ? "wide" : ""}">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}"></label>`;
const meta = (m: SecretMeta) => (m.set ? `Set - ${date(m.setAt)}` : "Not set");
const liveConnections = (d: DefinitionView) =>
  d.connectionCounts.connected + d.connectionCounts.needsAuthorization;

export class Providers {
  readonly #api: AdminApi;
  readonly #dialogs: Dialogs;
  readonly #notify: (message: string) => void;
  readonly #changed: (definitions: DefinitionView[]) => void;
  #definitions: DefinitionView[] = [];
  #epoch = 0;
  #workflow = 0;
  #popupCleanup: (() => void) | undefined;

  constructor(
    api: AdminApi,
    dialogs: Dialogs,
    notify: (message: string) => void,
    changed: (definitions: DefinitionView[]) => void,
  ) {
    this.#api = api;
    this.#dialogs = dialogs;
    this.#notify = notify;
    this.#changed = changed;
    this.#dialogs.modal.addEventListener("close", () => {
      this.#workflow++;
      this.#popupCleanup?.();
    });
  }

  clear(): void {
    this.#epoch++;
    this.#workflow++;
    this.#definitions = [];
    this.#popupCleanup?.();
    element("providers").replaceChildren();
  }

  mount(): void {
    element("providers").innerHTML =
      `<div class="heading"><div><h1>Providers</h1><p class="muted">Connect the services your Data Apps use.</p></div><button class="primary" id="add">+ Add provider</button></div>
      <div class="toolbar"><label class="screen-reader" for="search">Search providers</label><input id="search" type="search" placeholder="Search providers…">
      <label class="screen-reader" for="methodFilter">Method</label><select id="methodFilter"><option value="">All methods</option>${METHODS.map((m) => option(m, m, "")).join("")}</select>
      <label class="screen-reader" for="ownerFilter">Ownership</label><select id="ownerFilter"><option value="">All ownership</option><option value="shared">Shared</option><option value="personal">Personal</option></select>
      <label class="screen-reader" for="stateFilter">State</label><select id="stateFilter"><option value="">All states</option>${Object.entries(
        STATE_LABELS,
      )
        .map(([s, label]) => option(s, label, ""))
        .join(
          "",
        )}</select><span class="spacer"></span><button class="flat" id="refreshProviders">Refresh</button></div><div id="providerContent"></div>`;
    element("add").onclick = () => {
      void this.#chooser();
    };
    element("refreshProviders").onclick = () => {
      void this.load();
    };
    for (const id of ["search", "methodFilter", "ownerFilter", "stateFilter"])
      element(id).oninput = () => this.#table();
    element("providerContent").onclick = (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button");
      if (button?.dataset.peek) void this.#peek(button.dataset.peek);
      if (button?.hasAttribute("data-retry")) void this.load();
      if (button?.hasAttribute("data-add")) void this.#chooser();
      if (button?.hasAttribute("data-reset")) {
        for (const id of ["search", "methodFilter", "ownerFilter", "stateFilter"])
          element<HTMLInputElement>(id).value = "";
        this.#table();
      }
    };
  }

  async load(): Promise<void> {
    const epoch = ++this.#epoch;
    element("providerContent").innerHTML = stateBox(
      "Loading providers",
      "Reading the latest definition state.",
    );
    try {
      const result = await this.#api.request<{ definitions: DefinitionView[] }>(
        "GET",
        "/v1/admin/definitions",
      );
      if (epoch !== this.#epoch) return;
      this.#definitions = result.definitions;
      this.#changed(this.#definitions);
      this.#table();
    } catch (error) {
      if (epoch !== this.#epoch) return;
      this.#definitions = [];
      this.#changed([]);
      element("providerContent").innerHTML =
        `${stateBox("Providers could not be loaded", errorText(error))}<button data-retry>Retry</button>`;
    }
  }

  #table(): void {
    const q = element<HTMLInputElement>("search").value.toLocaleLowerCase();
    const selected = (id: string) => element<HTMLSelectElement>(id).value;
    const rows = this.#definitions.filter(
      (d) =>
        `${d.id} ${d.displayName} ${d.apiHosts.join(" ")}`.toLocaleLowerCase().includes(q) &&
        (!selected("methodFilter") || d.authentication.method === selected("methodFilter")) &&
        (!selected("ownerFilter") || d.ownership === selected("ownerFilter")) &&
        (!selected("stateFilter") || d.setup.state === selected("stateFilter")),
    );
    if (!this.#definitions.length) {
      element("providerContent").innerHTML =
        `${stateBox("Add your first provider", "Start from a catalog template or configure a supported method.")}<button data-add>Add provider</button>`;
      return;
    }
    if (!rows.length) {
      element("providerContent").innerHTML =
        `${stateBox("No matching providers", "Try another name or remove a filter.")}<button data-reset>Clear filters</button>`;
      return;
    }
    element("providerContent").innerHTML =
      `<div class="scroll-x"><table><caption class="screen-reader">Provider definitions</caption><thead><tr><th>Name</th><th>Method</th><th>Ownership</th><th>API hosts</th><th>State</th><th>Generation</th><th>Connections</th></tr></thead><tbody>${rows.map((d) => `<tr><td><button class="flat" data-peek="${esc(d.id)}">${esc(d.displayName)}</button><small>${esc(d.id)}</small></td><td><code>${esc(d.authentication.method)}</code></td><td>${d.ownership === "shared" ? "Shared" : "Personal"}</td><td>${esc(d.apiHosts[0] ?? "No hosts")}${d.apiHosts.length > 1 ? `<small>+ ${d.apiHosts.length - 1} host${d.apiHosts.length > 2 ? "s" : ""}</small>` : ""}</td><td>${badge(STATE_LABELS[d.setup.state], d.setup.state)}</td><td class="num">${d.generation}</td><td class="num">${d.connectionCounts.connected}<small>${d.connectionCounts.needsAuthorization} need authorization</small></td></tr>`).join("")}</tbody></table></div><div class="table-foot"><span>${rows.length} providers</span><span>Observed ${esc(date(new Date().toISOString()))}</span></div>`;
  }

  async #peek(id: string): Promise<void> {
    const workflow = ++this.#workflow;
    element("peekBody").innerHTML =
      `<h1 id="peekTitle">Provider properties</h1>${stateBox("Loading properties", "Reading current version and setup state.")}`;
    this.#dialogs.showPeek();
    try {
      const { definition: d } = await this.#api.request<{ definition: DefinitionView }>(
        "GET",
        `/v1/admin/definitions/${encodeURIComponent(id)}`,
      );
      if (workflow !== this.#workflow || !this.#dialogs.peek.open) return;
      element("peekBody").innerHTML =
        `<h1 id="peekTitle">${esc(d.displayName)}</h1><p class="hint">${esc(d.id)}</p><div class="actions">${badge(STATE_LABELS[d.setup.state], d.setup.state)}<span class="badge">Generation ${d.generation}</span><span class="badge">Version ${d.version}</span></div><div class="divider"></div><dl class="props"><dt>Method</dt><dd><code>${esc(d.authentication.method)}</code></dd><dt>Ownership</dt><dd>${esc(d.ownership)}</dd><dt>API hosts</dt><dd>${d.apiHosts.map(esc).join("<br>")}</dd><dt>Audience site IDs</dt><dd>${d.audience.map(esc).join("<br>") || "No sites"}</dd><dt>Scopes</dt><dd>${d.scopes.map(esc).join("<br>") || "None"}</dd><dt>Connections</dt><dd>${d.connectionCounts.connected} connected · ${d.connectionCounts.needsAuthorization} need authorization · ${d.connectionCounts.disconnected} disconnected</dd><dt>Shared credential</dt><dd>${d.ownership === "personal" ? "Managed by each viewer" : esc(meta(d.credential))}</dd>${Object.entries(
          SECRET_LABELS,
        )
          .filter(([f]) => f !== "credential")
          .map(
            ([f, label]) =>
              `<dt>${esc(label)}</dt><dd>${esc(meta(d.secrets[f as SecretField]))}</dd>`,
          )
          .join(
            "",
          )}<dt>Placement</dt><dd>${esc(d.credentialPlacement.kind)}</dd><dt>Private hosts</dt><dd>${d.privateHosts ? "Allowed; metadata addresses remain refused" : "Refused"}</dd></dl>${d.setup.missing.length ? `<div class="notice">Needs setup: ${d.setup.missing.map((p) => esc(SECRET_LABELS[p.replace("secrets.", "") as keyof typeof SECRET_LABELS] ?? p)).join(", ")}</div>` : ""}<div class="divider"></div><div class="actions"><button id="editProvider" ${d.retired ? "disabled" : ""}>Edit properties</button><button id="setSecret" ${d.retired ? "disabled" : ""}>Set or rotate secret</button>${d.setup.actions.includes("connect") ? '<button id="connectProvider">Connect shared account</button>' : ""}</div><div class="notice">${d.ownership === "personal" ? "Viewers connect their own accounts from a Data App." : "Data Apps in the audience use this shared connection."}</div><p class="hint">Changing hosts or authentication starts a new generation and disconnects existing accounts. Secret rotation keeps the definition generation. Webhook secret setup is separate from native credential readiness.</p><button class="flat danger" id="retireProvider" ${d.retired ? "disabled" : ""}>Retire provider</button>`;
      element("editProvider").onclick = () => {
        void this.#editor(editableDefinition(d), d);
      };
      element("setSecret").onclick = () => this.#secret(d);
      document.getElementById("connectProvider")?.addEventListener("click", () => this.#connect(d));
      element("retireProvider").onclick = () => this.#retire(d);
    } catch (error) {
      if (workflow !== this.#workflow || !this.#dialogs.peek.open) return;
      element("peekBody").innerHTML =
        `<h1 id="peekTitle">Properties unavailable</h1><p>${esc(errorText(error))}</p><button id="retryPeek">Retry</button>`;
      element("retryPeek").onclick = () => {
        this.#dialogs.peek.close();
        void this.#peek(id);
      };
    }
  }

  async #chooser(): Promise<void> {
    const form = this.#dialogs.open(
      "Add a provider",
      stateBox("Loading templates", "Reading the installed catalog."),
      "",
    );
    const workflow = ++this.#workflow;
    try {
      const { templates } = await this.#api.request<{ templates: CatalogTemplate[] }>(
        "GET",
        "/v1/admin/catalog",
      );
      if (workflow !== this.#workflow || !this.#dialogs.modal.open) return;
      element("modalBody").innerHTML =
        `<p class="muted">Start with a template. Your definition is independent of future catalog changes.</p><div class="templates">${templates.map((t, i) => `<button class="template" type="button" data-template="${i}"><b>${esc(t.name)}</b><span>${esc(t.description)}</span></button>`).join("")}<button class="template" type="button" data-scratch><b>From scratch</b><span>Choose a supported method and API hosts.</span></button></div>`;
      form.querySelectorAll<HTMLButtonElement>("[data-template]").forEach((b) => {
        b.onclick = () => {
          void this.#editor(newDefinition(templates[Number(b.dataset.template)]!.definition));
        };
      });
      form.querySelector<HTMLButtonElement>("[data-scratch]")!.onclick = () => {
        void this.#editor(newDefinition());
      };
    } catch (error) {
      if (workflow === this.#workflow && this.#dialogs.modal.open) showFormError(form, error);
    }
  }

  async #editor(draft: Definition, original?: DefinitionView): Promise<void> {
    const loading = this.#dialogs.open(
      original ? "Edit provider" : "Configure provider",
      stateBox("Loading trusted sites", "Reading the audience choices."),
      "",
    );
    const workflow = ++this.#workflow;
    let sites: Site[];
    try {
      sites = (await this.#api.request<{ sites: Site[] }>("GET", "/v1/admin/sites")).sites;
    } catch (error) {
      if (workflow === this.#workflow && this.#dialogs.modal.open) showFormError(loading, error);
      return;
    }
    if (workflow !== this.#workflow || !this.#dialogs.modal.open) return;
    const form = this.#dialogs.open(
      original ? "Edit provider" : "Configure provider",
      `<div class="fields">${field("Name", "displayName", draft.displayName)}${field("Definition ID", "id", draft.id)}<label class="field">Method<select name="method">${METHODS.map((m) => option(m, m, draft.authentication.method)).join("")}</select></label><label class="field">Ownership<select name="ownership">${option("shared", "Shared", draft.ownership)}${option("personal", "Personal", draft.ownership)}</select></label><label class="field wide">API hosts<textarea name="apiHosts">${esc(draft.apiHosts.join("\n"))}</textarea><span class="hint">One HTTPS base URL per line. Wildcard entries require a concrete matching host at use time.</span></label><label class="field wide">Audience<select name="audience" multiple size="${Math.min(5, Math.max(2, sites.length))}">${sites.map((s) => `<option value="${esc(s.id)}" ${draft.audience.includes(s.id) ? "selected" : ""}>${esc(s.contentUrl || "Default site")}${s.enabled ? "" : " (disabled)"}</option>`).join("")}</select><span class="hint">Use Ctrl or Command to select multiple sites. ${sites.length ? "" : "No trusted sites are configured."}</span></label><label class="field wide">Scopes<textarea name="scopes">${esc(draft.scopes.join("\n"))}</textarea><span class="hint">One scope per line.</span></label></div><fieldset class="form-section" id="commonProtocol"><legend>Authentication and placement</legend><div id="methodFields"></div><div class="fields form-section"><label class="field">Credential placement<select name="placement">${["bearer", "header", "query", "basic"].map((p) => option(p, p === "basic" ? "HTTP Basic" : p, draft.credentialPlacement.kind)).join("")}</select></label>${field("Header or query name", "placementName", "name" in draft.credentialPlacement ? draft.credentialPlacement.name : "")}${field("Header prefix", "placementPrefix", "prefix" in draft.credentialPlacement ? draft.credentialPlacement.prefix : "")}</div></fieldset><div class="fields form-section">${field("Reauthorization interval (seconds, optional)", "reauthorizationInterval", draft.reauthorizationInterval ?? "", "number")}</div><label class="inline-check"><input name="enabled" type="checkbox" ${draft.enabled ? "checked" : ""}> Enabled</label><label class="inline-check"><input name="privateHosts" type="checkbox" ${draft.privateHosts ? "checked" : ""}> Allow private host addresses</label><p class="hint">Metadata addresses remain refused. This setting changes the credential destination boundary.</p><div class="notice" id="generationNotice"></div><label class="inline-check" id="generationConfirm" hidden><input name="confirmGeneration" type="checkbox"> I understand existing connections will be disconnected.</label><details><summary>Advanced protocol configuration</summary><p class="hint">Edit the same Authentication, Webhook, AccountLookup, ProtocolRequest and CredentialImport data accepted by the operator API. Editing JSON makes it authoritative for protocol properties and disables the common protocol controls. No secret values belong here.</p><textarea name="advanced" aria-label="Advanced protocol configuration" spellcheck="false"></textarea><button type="button" id="useCommon">Use common protocol controls</button><p class="hint">This button discards unsaved advanced JSON edits.</p></details>`,
      original ? "Save changes" : "Create provider",
    );
    const input = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      name: string,
    ) => form.elements.namedItem(name) as T;
    if (original) input<HTMLInputElement>("id").readOnly = true;
    let auth = structuredClone(draft.authentication);
    let readClientAuthentication = clientAuthenticationReader(auth);
    let advancedMode = false;
    let locked = false;
    const protocol = () => ({
      authentication: auth,
      ...(draft.accountLookup ? { accountLookup: draft.accountLookup } : {}),
      ...(draft.revocation ? { revocation: draft.revocation } : {}),
      ...(draft.webhook ? { webhook: draft.webhook } : {}),
      ...(draft.credentialImport ? { credentialImport: draft.credentialImport } : {}),
    });
    const renderMethod = () => {
      const a = auth;
      element("methodFields").innerHTML =
        `<div class="fields">${"authorizationEndpoint" in a ? field("Authorization endpoint", "authorizationEndpoint", a.authorizationEndpoint, "url", true) : ""}${"tokenEndpoint" in a ? field("Token endpoint", "tokenEndpoint", a.tokenEndpoint, "url", true) : ""}${"refreshEndpoint" in a || a.method === "authorization_code" ? field("Refresh endpoint (optional)", "refreshEndpoint", "refreshEndpoint" in a ? a.refreshEndpoint : "", "url", true) : ""}${"clientAuthentication" in a ? `${field("Client ID", "clientId", a.clientAuthentication.clientId ?? "")}<label class="field">Client authentication<select name="clientAuth">${["none", "client_secret_basic", "client_secret_post", "private_key_jwt"].map((m) => option(m, m, a.clientAuthentication.method)).join("")}</select></label>` : ""}${a.method === "authorization_code" ? `<label class="field">PKCE<select name="pkce">${option("S256", "S256", a.pkce)}${option("none", "None", a.pkce)}</select></label>` : ""}${"scopeParameter" in a ? `${field("Scope parameter", "scopeName", a.scopeParameter.name)}<label class="field">Scope separator<select name="scopeSeparator">${option(" ", "Space", a.scopeParameter.separator)}${option(",", "Comma", a.scopeParameter.separator)}</select></label>` : ""}${"jwt" in a ? `<label class="field">JWT algorithm<select name="jwtAlgorithm">${option("RS256", "RS256", a.jwt.algorithm)}${option("ES256", "ES256", a.jwt.algorithm)}</select></label>${field("JWT lifetime (seconds, 1-3600)", "jwtTtl", a.jwt.ttlSeconds, "number")}${field("JWT audience", "jwtAudience", typeof a.jwt.audience === "string" ? a.jwt.audience : "", "text", true)}${a.method === "signed_jwt_direct" ? `<label class="inline-check"><input type="checkbox" name="selectedOrigin" ${typeof a.jwt.audience === "object" ? "checked" : ""}> Use selected native origin as JWT audience</label>` : ""}<p class="hint">The signing credential belongs to a connection. Configure literal or credential-derived claims in advanced JSON.</p>` : ""}</div>`;
    };
    renderMethod();
    input<HTMLTextAreaElement>("advanced").value = JSON.stringify(protocol(), null, 2);
    const readCommonAuth = (): Authentication => {
      const a = structuredClone(auth);
      const value = (name: string) => input<HTMLInputElement>(name).value;
      if ("authorizationEndpoint" in a)
        a.authorizationEndpoint = value("authorizationEndpoint").trim();
      if ("tokenEndpoint" in a) a.tokenEndpoint = value("tokenEndpoint").trim();
      if (a.method === "authorization_code") {
        const refresh = value("refreshEndpoint").trim();
        if (refresh) a.refreshEndpoint = refresh;
        else delete a.refreshEndpoint;
        a.pkce = value("pkce") as "S256" | "none";
      }
      if ("clientAuthentication" in a) {
        const method = value("clientAuth") as ClientAuthentication["method"];
        const clientId = value("clientId").trim();
        a.clientAuthentication = readClientAuthentication(a.clientAuthentication, {
          method,
          clientId,
          tokenEndpoint: a.tokenEndpoint,
        });
      }
      if ("scopeParameter" in a)
        a.scopeParameter = {
          name: value("scopeName"),
          separator: value("scopeSeparator") as " " | ",",
        };
      if ("jwt" in a) {
        a.jwt.algorithm = value("jwtAlgorithm") as "RS256" | "ES256";
        a.jwt.ttlSeconds = Number(value("jwtTtl"));
        a.jwt.audience =
          a.method === "signed_jwt_direct" && input<HTMLInputElement>("selectedOrigin").checked
            ? { source: "selectedOrigin" }
            : value("jwtAudience");
      }
      return a;
    };
    const read = (): Definition => {
      const definition = structuredClone(draft);
      definition.id = input<HTMLInputElement>("id").value.trim();
      definition.displayName = input<HTMLInputElement>("displayName").value.trim();
      definition.ownership = input<HTMLSelectElement>("ownership").value as Definition["ownership"];
      definition.apiHosts = lines(input<HTMLTextAreaElement>("apiHosts").value);
      definition.scopes = lines(input<HTMLTextAreaElement>("scopes").value);
      definition.audience = [...input<HTMLSelectElement>("audience").selectedOptions].map(
        (o) => o.value,
      );
      definition.enabled = input<HTMLInputElement>("enabled").checked;
      definition.privateHosts = input<HTMLInputElement>("privateHosts").checked;
      const interval = input<HTMLInputElement>("reauthorizationInterval").value;
      if (interval) {
        const n = Number(interval);
        if (!Number.isSafeInteger(n) || n < 1)
          throw new FormError("reauthorizationInterval", "Enter a positive integer interval.");
        definition.reauthorizationInterval = n;
      } else delete definition.reauthorizationInterval;
      const kind = input<HTMLSelectElement>("placement").value as Placement["kind"];
      definition.credentialPlacement =
        kind === "header"
          ? {
              kind,
              name: input<HTMLInputElement>("placementName").value,
              ...(input<HTMLInputElement>("placementPrefix").value
                ? { prefix: input<HTMLInputElement>("placementPrefix").value }
                : {}),
            }
          : kind === "query"
            ? { kind, name: input<HTMLInputElement>("placementName").value }
            : { kind };
      if (advancedMode) {
        let extra: Record<string, unknown>;
        try {
          extra = JSON.parse(input<HTMLTextAreaElement>("advanced").value);
        } catch {
          throw new FormError("advanced", "Advanced configuration must be valid JSON.");
        }
        if (!extra || typeof extra !== "object" || Array.isArray(extra))
          throw new FormError("advanced", "Advanced configuration must be a JSON object.");
        for (const key of Object.keys(extra))
          if (
            ![
              "authentication",
              "credentialPlacement",
              "accountLookup",
              "revocation",
              "webhook",
              "credentialImport",
            ].includes(key)
          )
            throw new FormError(
              `advanced.${key}`,
              "Only protocol properties belong in this editor.",
            );
        if (!Object.hasOwn(extra, "authentication"))
          throw new FormError("authentication", "Advanced configuration requires authentication.");
        for (const key of ["accountLookup", "revocation", "webhook", "credentialImport"] as const)
          delete definition[key];
        Object.assign(definition, extra);
      } else {
        definition.authentication = readCommonAuth();
      }
      return definition;
    };
    const consequences = () => {
      try {
        const current = read();
        const changed =
          original && definitionChanges(editableDefinition(original), current).redefine;
        element("generationNotice").textContent = !original
          ? "Create the definition, then complete the setup actions shown in its properties."
          : changed
            ? `This starts generation ${original.generation + 1} and disconnects ${liveConnections(original)} active connection(s). Accounts must reconnect.`
            : `This keeps generation ${original.generation}. Existing connections remain.`;
        element("generationConfirm").hidden = !changed;
      } catch {
        element("generationNotice").textContent =
          "Complete the configuration to review generation consequences.";
      }
    };
    form.oninput = (e) => {
      if (e.target === input("advanced")) {
        advancedMode = true;
        element<HTMLFieldSetElement>("commonProtocol").disabled = true;
        input<HTMLSelectElement>("method").disabled = true;
      } else if (!advancedMode) {
        auth = readCommonAuth();
        input<HTMLTextAreaElement>("advanced").value = JSON.stringify(
          { ...protocol(), credentialPlacement: read().credentialPlacement },
          null,
          2,
        );
      }
      consequences();
    };
    input<HTMLSelectElement>("method").onchange = () => {
      auth = defaultAuthentication(
        input<HTMLSelectElement>("method").value as Authentication["method"],
      );
      readClientAuthentication = clientAuthenticationReader(auth);
      renderMethod();
      input<HTMLTextAreaElement>("advanced").value = JSON.stringify(protocol(), null, 2);
      consequences();
    };
    element("useCommon").onclick = () => {
      advancedMode = false;
      element<HTMLFieldSetElement>("commonProtocol").disabled = false;
      input<HTMLSelectElement>("method").disabled = false;
      input<HTMLTextAreaElement>("advanced").value = JSON.stringify(protocol(), null, 2);
      consequences();
    };
    consequences();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (locked) return;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      try {
        const definition = read();
        if (!definition.displayName) throw new FormError("displayName", "Enter a readable name.");
        if (!definition.id) throw new FormError("id", "Enter a definition ID.");
        const changes = original
          ? definitionChanges(editableDefinition(original), definition)
          : undefined;
        if (changes?.redefine && !input<HTMLInputElement>("confirmGeneration").checked)
          throw new FormError(
            "confirmGeneration",
            "Confirm the connection consequences before saving.",
          );
        submit.disabled = true;
        await this.#api.request(
          original ? (changes?.redefine ? "PUT" : "PATCH") : "POST",
          `/v1/admin/definitions${original ? `/${encodeURIComponent(original.id)}` : ""}`,
          original
            ? {
                ...(changes?.redefine ? definition : changes!.patch),
                expectedVersion: original.version,
              }
            : definition,
        );
        if (workflow !== this.#workflow) return;
        this.#dialogs.modal.close();
        await this.load();
        this.#notify("Provider saved.");
      } catch (error) {
        if (workflow !== this.#workflow) return;
        showFormError(form, error);
        if (error instanceof ApiError && error.code === "definition-conflict" && original) {
          locked = true;
          this.#conflict(form, original.id);
        }
      } finally {
        if (submit.isConnected) submit.disabled = locked;
      }
    };
  }

  #conflict(form: HTMLFormElement, id: string): void {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload latest properties and discard this draft";
    button.onclick = async () => {
      button.disabled = true;
      try {
        const { definition } = await this.#api.request<{ definition: DefinitionView }>(
          "GET",
          `/v1/admin/definitions/${encodeURIComponent(id)}`,
        );
        if (this.#dialogs.modal.open) void this.#editor(editableDefinition(definition), definition);
      } catch (error) {
        if (this.#dialogs.modal.open) showFormError(form, error);
        button.disabled = false;
      }
    };
    form.querySelector("[data-form-error]")!.append(button);
  }

  #secret(d: DefinitionView): void {
    const destinations = [
      ...(d.ownership === "shared" &&
      ["static", "jwt_bearer", "signed_jwt_direct"].includes(d.authentication.method)
        ? ["credential"]
        : []),
      "clientSecret",
      "signingPrivateKey",
      "signingSecret",
    ] as (SecretField | "credential")[];
    const form = this.#dialogs.open(
      "Set or rotate secret",
      `<p class="muted">${esc(d.displayName)}</p><label class="field">Secret destination<select name="destination">${destinations.map((f) => `<option value="${f}">${SECRET_LABELS[f]}</option>`).join("")}</select></label><p class="hint" id="secretMetadata"></p><div id="secretInputs"></div><label class="inline-check"><input name="clear" type="checkbox"> Explicitly clear this value</label><div class="notice">Blank never clears a value. Rotation invalidates derived credentials across replicas. Clearing a shared credential disconnects it. Personal credentials remain owner-bound in Data Apps.</div>`,
      "Save secret",
    );
    const workflow = ++this.#workflow;
    const destination = form.elements.namedItem("destination") as HTMLSelectElement;
    const render = () => {
      const key = destination.value as SecretField | "credential";
      element("secretMetadata").textContent =
        `Current value: ${meta(key === "credential" ? d.credential : d.secrets[key])}. Values can be replaced, never read back.`;
      const kind = d.credentialImport
        ? "import"
        : d.authentication.method === "jwt_bearer" ||
            d.authentication.method === "signed_jwt_direct"
          ? "jwt"
          : d.credentialPlacement.kind === "basic"
            ? "basic"
            : "token";
      element("secretInputs").innerHTML =
        `${key === "credential" ? `<input name="kind" type="hidden" value="${kind}">${kind === "basic" ? '<label class="field">Basic username<input name="username" data-secret autocomplete="off"></label><label class="field">Basic password<input name="password" type="password" data-secret autocomplete="new-password"></label>' : kind === "jwt" ? '<div class="fields"><label class="field">Issuer<input name="issuer" data-secret autocomplete="off"></label><label class="field">Subject (optional)<input name="subject" data-secret autocomplete="off"></label><label class="field">Key ID (optional)<input name="keyId" data-secret autocomplete="off"></label></div>' : ""}` : ""}${key !== "credential" || kind !== "basic" ? '<label class="field">New value<input name="value" type="password" data-secret autocomplete="new-password"></label><details><summary>Multiline private key or credential JSON</summary><textarea class="secret" name="multiline" data-secret autocomplete="off" spellcheck="false" aria-label="Private key or credential JSON"></textarea><label class="inline-check"><input type="checkbox" id="revealMultiline"> Show multiline value</label></details>' : ""}`;
      document
        .getElementById("revealMultiline")
        ?.addEventListener("change", (e) =>
          form
            .querySelector<HTMLTextAreaElement>("textarea[data-secret]")
            ?.classList.toggle("secret", !(e.target as HTMLInputElement).checked),
        );
    };
    destination.onchange = render;
    render();
    let locked = false;
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (locked) return;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      try {
        const fields: Record<string, string | boolean> = Object.fromEntries(
          new FormData(form).entries(),
        ) as Record<string, string>;
        fields.clear = (form.elements.namedItem("clear") as HTMLInputElement).checked;
        let write: ReturnType<typeof serializeSecret>;
        try {
          write = serializeSecret(fields);
        } finally {
          form
            .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-secret]")
            .forEach((n) => {
              n.value = "";
            });
        }
        submit.disabled = true;
        await this.#api.request(
          "PUT",
          `/v1/admin/definitions/${encodeURIComponent(d.id)}/secrets`,
          { expectedVersion: d.version, ...write },
        );
        if (workflow !== this.#workflow) return;
        this.#dialogs.modal.close();
        await this.load();
        this.#notify("Secret updated. The submitted value was discarded.");
      } catch (error) {
        if (workflow !== this.#workflow) return;
        showFormError(form, error);
        if (error instanceof ApiError && error.code === "definition-conflict") {
          locked = true;
          this.#conflict(form, d.id);
        }
      } finally {
        if (submit.isConnected) submit.disabled = locked;
      }
    };
  }

  #connect(d: DefinitionView): void {
    const form = this.#dialogs.open(
      "Connect shared account",
      `<p>Connect an account to <b>${esc(d.displayName)}</b>.</p><p class="muted">A provider sign-in opens in a separate window. Data Apps in the audience will use this shared account. A successful connection replaces its current shared connection.</p>`,
      "Open provider sign-in",
    );
    const workflow = ++this.#workflow;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const popup = window.open("about:blank", "_blank", "popup,width=620,height=760");
      if (!popup) {
        showFormError(
          form,
          new Error("The sign-in window was blocked. Allow popups and try again."),
        );
        return;
      }
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      submit.disabled = true;
      try {
        const started = await this.#api.request<{
          transactionId: string;
          url: string;
          expiresAt: string;
        }>("POST", `/v1/admin/definitions/${encodeURIComponent(d.id)}/connect`);
        if (workflow !== this.#workflow) {
          popup.close();
          return;
        }
        const url = new URL(started.url);
        if (url.origin !== location.origin || !url.pathname.startsWith("/connect/"))
          throw new Error("The service returned an unexpected connect destination.");
        popup.location.href = url.href;
        element("modalBody").innerHTML =
          '<p role="status">Waiting for provider sign-in.</p><p class="muted">Finish in the provider window. Closing it keeps the current connection unless setup already completed. Refresh properties to check an uncertain result.</p>';
        submit.hidden = true;
        const cleanup = () => {
          clearInterval(timer);
          window.removeEventListener("message", message);
          if (!popup.closed) popup.close();
          this.#popupCleanup = undefined;
        };
        const finish = (text: string) => {
          cleanup();
          this.#dialogs.modal.close();
          void this.load();
          this.#notify(text);
        };
        const message = (event: MessageEvent) => {
          if (
            event.origin !== location.origin ||
            event.source !== popup ||
            event.data?.type !== "tableau-service:connect"
          )
            return;
          if (
            event.data.transactionId !== started.transactionId &&
            !(event.data.status === "failed" && event.data.transactionId === "")
          )
            return;
          if (event.data.definitionId && event.data.definitionId !== d.id) return;
          finish(
            event.data.status === "connected"
              ? "Shared account connected."
              : "Provider connection failed. Refresh properties before trying again.",
          );
        };
        const timer = setInterval(() => {
          if (popup.closed || Date.now() >= Date.parse(started.expiresAt))
            finish("Provider sign-in ended. Refresh properties to check the connection.");
        }, 500);
        window.addEventListener("message", message);
        this.#popupCleanup = cleanup;
      } catch (error) {
        popup.close();
        if (workflow === this.#workflow) {
          showFormError(form, error);
          submit.disabled = false;
        }
      }
    };
  }

  #retire(d: DefinitionView): void {
    const form = this.#dialogs.open(
      "Retire provider",
      `<p>Retire <b>${esc(d.displayName)}</b> and disconnect ${liveConnections(d)} active connection(s)?</p><p class="muted">Its credentials are deleted, its history remains, and this definition ID cannot be reused.</p><label class="inline-check"><input name="confirm" type="checkbox"> I understand accounts will be disconnected and the ID cannot be reused.</label>`,
      "Retire provider",
    );
    const workflow = ++this.#workflow;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      try {
        if (!(form.elements.namedItem("confirm") as HTMLInputElement).checked)
          throw new FormError("confirm", "Confirm the retirement consequences.");
        submit.disabled = true;
        await this.#api.request(
          "POST",
          `/v1/admin/definitions/${encodeURIComponent(d.id)}/retire`,
          { expectedVersion: d.version },
        );
        if (workflow !== this.#workflow) return;
        this.#dialogs.modal.close();
        await this.load();
        this.#notify("Provider retired.");
      } catch (error) {
        if (workflow === this.#workflow) {
          showFormError(form, error);
          submit.disabled = error instanceof ApiError && error.code === "definition-conflict";
        }
      }
    };
  }
}
