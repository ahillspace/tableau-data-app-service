import type { FieldError } from "../platform/errors.ts";

export const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing console element: ${id}`);
  return node as T;
}
export const date = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : "Not observed";
export const badge = (label: string, state = ""): string =>
  `<span class="badge ${state === "ok" || state === "ready" ? "ok" : state === "stale" || state === "needs-setup" ? "warn" : state === "unavailable" ? "bad" : ""}">${esc(label)}</span>`;
export const stateBox = (title: string, message: string, action?: string): string =>
  `<div class="state" role="status"><h2>${esc(title)}</h2><p class="muted">${esc(message)}</p>${action ? `<button data-retry>${esc(action)}</button>` : ""}</div>`;
export const field = (label: string, name: string, value = "", type = "text", hint = ""): string =>
  `<label class="field">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}">${hint ? `<span class="hint">${esc(hint)}</span>` : ""}<span class="error" data-error="${esc(name)}"></span></label>`;
export const option = (value: string, label: string, selected: string): string =>
  `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
export function toast(message: string): void {
  const node = element("toast");
  node.textContent = message;
  node.hidden = false;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];
  constructor(status: number, code: string, message: string, fields: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export class AdminApi {
  csrf = "";
  onDenied: (error: ApiError) => void = () => {};
  #epoch = 0;
  readonly #requests = new Set<AbortController>();
  clear(): void {
    this.csrf = "";
    this.#epoch++;
    for (const c of this.#requests) c.abort();
    this.#requests.clear();
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/v1/admin/")) throw new Error("Invalid operator API path");
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const mutation = method !== "GET";
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(mutation ? { "content-type": "application/json", "X-TDAS-CSRF": this.csrf } : {}),
        },
        ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const data = response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : undefined;
      if (epoch !== this.#epoch) throw new DOMException("Session changed", "AbortError");
      if (!response.ok) {
        const error = new ApiError(
          response.status,
          data?.error?.code ?? "request-failed",
          data?.error?.message ?? "The service could not complete the request.",
          data?.error?.fields ?? [],
        );
        if (
          response.status === 401 ||
          (response.status === 403 && error.code === "operator-required")
        )
          this.onDenied(error);
        throw error;
      }
      if (data === undefined) throw new Error("The service returned an unexpected response.");
      return data as T;
    } finally {
      clearTimeout(timer);
      this.#requests.delete(controller);
    }
  }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError || (error instanceof Error && error.name !== "AbortError"))
    return error.message;
  return "The request did not complete. Refresh the latest state before trying again.";
}

export function showFormError(form: HTMLFormElement, error: unknown): void {
  const target = form.querySelector<HTMLElement>("[data-form-error]")!;
  target.hidden = false;
  target.textContent = errorText(error);
  form.querySelectorAll("[data-error]").forEach((n) => {
    n.textContent = "";
  });
  form.querySelectorAll("[aria-invalid]").forEach((n) => n.removeAttribute("aria-invalid"));
  const fields =
    error instanceof ApiError
      ? error.fields
      : error && typeof error === "object" && "path" in error
        ? [{ path: String(error.path), rule: errorText(error) }]
        : [];
  if (fields.length) {
    const list = document.createElement("ul");
    list.className = "error-list";
    for (const f of fields) {
      const item = document.createElement("li");
      item.textContent = `${f.path || "definition"}: ${f.rule}`;
      list.append(item);
      for (const n of form.querySelectorAll<HTMLElement>("[data-error]"))
        if (n.dataset.error === f.path) n.textContent = f.rule;
      const control = form.elements.namedItem(f.path);
      if (control instanceof HTMLElement) control.setAttribute("aria-invalid", "true");
    }
    target.append(list);
  }
  target.tabIndex = -1;
  target.focus();
}

export class Dialogs {
  readonly modal = element<HTMLDialogElement>("modal");
  readonly peek = element<HTMLDialogElement>("peek");
  #opener: HTMLElement | undefined;
  constructor() {
    for (const dialog of [this.modal, this.peek]) {
      dialog.addEventListener("click", (e) => {
        if ((e.target as Element).closest("[data-close]")) dialog.close();
      });
      dialog.addEventListener("close", () => {
        dialog
          .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-secret]")
          .forEach((n) => {
            n.value = "";
          });
        if (dialog === this.modal) {
          element("modalBody").replaceChildren();
          element("modalFoot").replaceChildren();
          element<HTMLFormElement>("form").onsubmit = null;
          element<HTMLFormElement>("form").oninput = null;
        } else element("peekBody").replaceChildren();
        if (!this.modal.open && !this.peek.open) {
          const opener = this.#opener;
          this.#opener = undefined;
          const target =
            opener?.isConnected && opener.getClientRects().length
              ? opener
              : document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
          if (target?.getClientRects().length) target.focus();
          else document.querySelector<HTMLElement>("#auth a")?.focus();
        }
      });
    }
  }
  close(): void {
    this.modal.close();
    this.peek.close();
  }
  showPeek(): void {
    this.#rememberOpener();
    this.peek.showModal();
  }
  #rememberOpener(): void {
    if (!this.modal.open && !this.peek.open)
      this.#opener =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  }
  open(title: string, body: string, submit = "Save"): HTMLFormElement {
    this.#rememberOpener();
    this.peek.close();
    element<HTMLFormElement>("form").oninput = null;
    element<HTMLFormElement>("form").onsubmit = null;
    element("modalTitle").textContent = title;
    element("modalBody").innerHTML =
      `<div class="notice error" data-form-error role="alert" hidden></div>${body}`;
    element("modalFoot").innerHTML =
      `<button type="button" data-close>Cancel</button>${submit ? `<button class="primary" type="submit">${esc(submit)}</button>` : ""}`;
    if (!this.modal.open) this.modal.showModal();
    return element<HTMLFormElement>("form");
  }
}
