import { type ConnectionView, type ProviderView, ServiceClient } from "../../src/sdk/index.js";

declare const EXAMPLE_CONFIGURATION: { serviceOrigin: string; appId: string; deploymentId: string };
const client = new ServiceClient(EXAMPLE_CONFIGURATION);
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing example control ${id}`);
  return value as T;
}
const status = element("status"),
  identity = element("identity"),
  output = element("response");
const signIn = element<HTMLButtonElement>("sign-in"),
  connect = element<HTMLButtonElement>("connect"),
  reauthorize = element<HTMLButtonElement>("reauthorize");
const selection = element<HTMLSelectElement>("connection"),
  send = element<HTMLButtonElement>("send"),
  cancel = element<HTMLButtonElement>("cancel");
const token = element<HTMLInputElement>("slack-token"),
  staticSetup = element<HTMLDetailsElement>("static-setup");
let provider: ProviderView | undefined,
  connections: ConnectionView[] = [],
  signedIn = false,
  busy = false,
  request: AbortController | undefined,
  tokenReplacement: ConnectionView | undefined;
const selected = () => connections.find((connection) => connection.id === selection.value);
function controls() {
  signIn.disabled = busy;
  connect.disabled = busy || !signedIn || !provider;
  selection.disabled = busy || !connections.length;
  reauthorize.disabled = busy || !selected()?.canManage;
  send.disabled =
    busy ||
    !selected() ||
    selected()?.state !== "active" ||
    !!selected()?.connectorReauthRequired ||
    !selected()?.readyEndpoints.includes("api");
  cancel.disabled = !request;
}
function clearPrivateView() {
  request?.abort();
  request = undefined;
  connections = [];
  selection.replaceChildren(new Option("Connect an account to continue", ""));
  output.textContent = "Your response will appear here.";
  signedIn = false;
  provider = undefined;
  staticSetup.hidden = true;
  controls();
}
async function refresh(preferred?: string) {
  const discovery = await client.discover();
  provider = discovery.providers.find((entry) => entry.id === "slack");
  connections = await client.connections({ provider: "slack" });
  selection.replaceChildren(
    ...connections.map(
      (connection) =>
        new Option(
          `${connection.display.accountLabel ?? connection.display.label ?? "Slack"}${connection.state === "active" ? "" : ` - ${connection.state}`}`,
          connection.id,
        ),
    ),
  );
  if (!connections.length) selection.add(new Option("Connect an account to continue", ""));
  if (preferred && connections.some((connection) => connection.id === preferred))
    selection.value = preferred;
  staticSetup.hidden = !provider?.setupModes.includes("static");
  identity.textContent = "Signed in with Tableau.";
  signIn.textContent = "Use another Tableau account";
  signedIn = true;
  controls();
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "The request failed";
}
async function action(work: () => Promise<void>) {
  busy = true;
  controls();
  try {
    await work();
  } catch (error) {
    status.textContent = message(error);
  } finally {
    busy = false;
    controls();
  }
}
signIn.addEventListener("click", () => {
  clearPrivateView();
  identity.textContent = "Signing in…";
  // signIn preopens its popup synchronously inside this user gesture.
  const pending = client.signIn();
  void action(async () => {
    await pending;
    await refresh();
    status.textContent = "Signed in. Choose or connect a Slack account.";
  });
});
connect.addEventListener("click", () => {
  tokenReplacement = undefined;
  if (!provider?.setupModes.includes("oauth")) {
    staticSetup.open = true;
    token.focus();
    return;
  }
  const pending = client.connect({ providerRegistrationId: "slack" });
  void action(async () => {
    const connection = await pending;
    await refresh(connection.id);
    status.textContent = "Slack connected.";
  });
});
reauthorize.addEventListener("click", () => {
  const connection = selected();
  if (!connection) return;
  tokenReplacement = connection;
  if (!provider?.setupModes.includes("oauth")) {
    staticSetup.open = true;
    token.focus();
    status.textContent = "Enter a token to reconnect this selected account.";
    return;
  }
  const pending = client.connect({
    providerRegistrationId: "slack",
    replacement: {
      connectionId: connection.id,
      expectedAuthorityGeneration: connection.authorityGeneration,
    },
  });
  void action(async () => {
    const updated = await pending;
    await refresh(updated.id);
    status.textContent = "Slack account reconnected.";
  });
});
selection.addEventListener("change", () => {
  output.textContent = "Your response will appear here.";
  controls();
});
element("connect-token").addEventListener("click", () => {
  if (!element<HTMLFormElement>("token-form").reportValidity()) return;
  const value = token.value;
  token.value = "";
  const replacement = tokenReplacement;
  tokenReplacement = undefined;
  void action(async () => {
    const connection = await client.setupStatic({
      providerRegistrationId: "slack",
      inputs: { token: value, tokenMode: element<HTMLSelectElement>("token-mode").value },
      ...(replacement
        ? {
            replacement: {
              connectionId: replacement.id,
              expectedAuthorityGeneration: replacement.authorityGeneration,
            },
          }
        : {}),
    });
    staticSetup.open = false;
    await refresh(connection.id);
    status.textContent = "Slack connected.";
  });
});
cancel.addEventListener("click", () => request?.abort());
send.addEventListener("click", () => {
  if (!element<HTMLFormElement>("request-form").reportValidity()) return;
  const connection = selected();
  if (!connection) return;
  const controller = (request = new AbortController());
  output.textContent = "";
  status.textContent = "Sending native request…";
  void action(async () => {
    try {
      const entered = element<HTMLInputElement>("path").value;
      if (!entered.startsWith("/") || entered.startsWith("//"))
        throw new Error("Enter a native Slack API path beginning with /.");
      const path = new URL(entered, "https://native.invalid");
      const body = element<HTMLTextAreaElement>("body").value;
      const response = await client.request(
        {
          providerRegistrationId: "slack",
          endpoint: "api",
          connectionId: connection.id,
          method: element<HTMLSelectElement>("method").value as "GET" | "POST" | "HEAD",
          path: path.pathname,
          query: path.searchParams,
          ...(body
            ? { body, headers: [["content-type", "application/x-www-form-urlencoded"]] }
            : {}),
        },
        { signal: controller.signal },
      );
      output.textContent = `HTTP ${response.status}\n${[...response.headers].map(([key, value]) => `${key}: ${value}`).join("\n")}\n\n`;
      status.textContent = "Response headers received. Reading body…";
      if (response.body) {
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let count = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const text = decoder.decode(next.value, { stream: true });
            output.textContent += text.slice(0, Math.max(0, 40000 - count));
            count += text.length;
            if (count >= 40000) {
              await reader.cancel();
              status.textContent = "Preview reached 40,000 characters. Reading stopped.";
              return;
            }
          }
          output.textContent += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      status.textContent = `Native response complete (HTTP ${response.status}).`;
    } catch (error) {
      status.textContent = controller.signal.aborted
        ? "Reading stopped. The provider may already have processed the request."
        : `Request or body read failed: ${message(error)}`;
    } finally {
      request = undefined;
      controls();
    }
  });
});
window.addEventListener("pagehide", () => {
  request?.abort();
  client.close();
});
// Fetch controls also work in script-enabled opaque frames without native form navigation permission.
for (const [formId, buttonId] of [
  ["token-form", "connect-token"],
  ["request-form", "send"],
]) {
  element(formId!).addEventListener("submit", (event) => event.preventDefault());
  element(formId!).addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      element<HTMLButtonElement>(buttonId!).click();
    }
  });
}
void action(async () => {
  try {
    await client.initialize();
    await refresh();
    status.textContent = "Session restored.";
  } catch (error) {
    clearPrivateView();
    identity.textContent = "Sign in with Tableau to continue.";
    status.textContent = message(error);
  }
});
