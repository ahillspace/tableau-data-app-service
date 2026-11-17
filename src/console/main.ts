import type { OperatorSessionView } from "../contracts/operator.ts";
import { AdminApi, ApiError, Dialogs, element, errorText, esc } from "./dom.ts";
import { Providers } from "./providers.ts";
import { Status } from "./status.ts";
import "./style.css";

const api = new AdminApi();
const dialogs = new Dialogs();
const status = new Status(api);
let toastTimer: ReturnType<typeof setTimeout>;
const notify = (message: string) => {
  clearTimeout(toastTimer);
  element("toast").textContent = message;
  element("toast").hidden = false;
  toastTimer = setTimeout(() => {
    element("toast").hidden = true;
  }, 6000);
};
const providers = new Providers(api, dialogs, notify, (definitions) =>
  status.definitions(definitions),
);
let sessionTimer: ReturnType<typeof setTimeout>;
let session: OperatorSessionView | undefined;
let statusLoaded = false;

function signedOut(
  reason: "required" | "denied" | "nonoperator" | "logout",
  detail?: string,
): void {
  clearTimeout(sessionTimer);
  session = undefined;
  api.clear();
  providers.clear();
  status.clear();
  dialogs.close();
  statusLoaded = false;
  element("app").hidden = true;
  element("tabs").hidden = true;
  element("operatorControls").hidden = true;
  element("operatorName").textContent = "";
  element("toast").hidden = true;
  const title =
    reason === "nonoperator"
      ? "Operator access required"
      : reason === "denied"
        ? "Operator access was not approved"
        : reason === "logout"
          ? "Signed out"
          : "Sign in to continue";
  const message =
    reason === "nonoperator"
      ? "Tableau sign-in succeeded, but this identity is not an operator for this installation. An existing operator can grant access."
      : reason === "denied"
        ? "The operator consent request was denied. No operator access was granted."
        : reason === "logout"
          ? "Your operator console session has ended."
          : "Sign in with Tableau and approve operator access to open the console.";
  element("auth").hidden = false;
  element("auth").innerHTML =
    `<div class="auth"><span class="label">Tableau Data App Service</span><h1>${title}</h1><p class="muted">${message}</p>${detail ? `<p class="hint">${esc(detail)}</p>` : ""}<a class="button primary" href="/operator-sign-in?mode=console">Sign in with Tableau</a></div>`;
}

api.onDenied = (error) =>
  signedOut(error.code === "operator-required" ? "nonoperator" : "required");

function tab(name: "providers" | "status"): void {
  for (const id of ["providers", "status"]) {
    element(id).hidden = id !== name;
    element(`${id}-tab`).setAttribute("aria-selected", String(id === name));
    element(`${id}-tab`).tabIndex = id === name ? 0 : -1;
  }
  if (name === "status" && !statusLoaded) {
    statusLoaded = true;
    void status.load();
  }
}
for (const name of ["providers", "status"] as const) {
  element(`${name}-tab`).onclick = () => tab(name);
  element(`${name}-tab`).onkeydown = (e) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? "providers"
          : e.key === "End"
            ? "status"
            : name === "providers"
              ? "status"
              : "providers";
      tab(next);
      element(`${next}-tab`).focus();
    }
  };
}
element("signout").onclick = async () => {
  const button = element<HTMLButtonElement>("signout");
  button.disabled = true;
  try {
    await api.request("POST", "/v1/admin/session/logout");
    signedOut("logout");
  } catch (error) {
    if (session) notify(`Sign-out did not complete. ${errorText(error)}`);
  } finally {
    button.disabled = false;
  }
};

async function start(): Promise<void> {
  if (new URLSearchParams(location.search).get("auth") === "denied") {
    signedOut("denied");
    return;
  }
  try {
    const current = await api.request<OperatorSessionView>("GET", "/v1/admin/session");
    if (
      !current.csrfToken ||
      !current.operator?.displayName ||
      !Number.isFinite(Date.parse(current.expiresAt))
    )
      throw new Error("The service returned an unexpected operator session.");
    session = current;
    api.csrf = current.csrfToken;
    element("operatorName").textContent = current.operator.displayName;
    element("operatorControls").hidden = false;
    element("tabs").hidden = false;
    element("app").hidden = false;
    element("auth").hidden = true;
    status.mount();
    providers.mount();
    tab("providers");
    sessionTimer = setTimeout(
      () => signedOut("required", "Your operator session has expired."),
      Math.max(0, Date.parse(current.expiresAt) - Date.now()),
    );
    await providers.load();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.code === "operator-required"))
      return;
    signedOut("required", errorText(error));
    const retry = document.createElement("button");
    retry.textContent = "Retry session check";
    retry.onclick = () => {
      retry.disabled = true;
      void start();
    };
    element("auth").querySelector(".auth")!.append(retry);
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && session && Date.now() >= Date.parse(session.expiresAt))
    signedOut("required", "Your operator session has expired.");
});
setInterval(() => status.markStale(), 10_000);
void start();
