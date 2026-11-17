/**
 * A Slack Data App on the service SDK. It shows one shared bot definition and one personal user
 * definition side by side: the same native calls, with the credential the definition names.
 */
import {
  createService,
  type Definition,
  ServiceError,
  type Subscription,
} from "../../src/sdk/index.ts";

declare const EXAMPLE_CONFIGURATION: {
  serviceOrigin: string;
  appId: string;
  botDefinition: string;
  userDefinition: string;
};

const config = EXAMPLE_CONFIGURATION;
const service = createService({ origin: config.serviceOrigin, appId: config.appId });

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const identity = element<HTMLParagraphElement>("identity");
const signIn = element<HTMLButtonElement>("sign-in");
const list = element<HTMLUListElement>("definitions");
const definitionSelect = element<HTMLSelectElement>("definition");
const method = element<HTMLSelectElement>("method");
const path = element<HTMLInputElement>("path");
const body = element<HTMLTextAreaElement>("body");
const send = element<HTMLButtonElement>("send");
const status = element<HTMLParagraphElement>("status");
const output = element<HTMLPreElement>("response");
const eventsToggle = element<HTMLButtonElement>("events");
const eventLog = element<HTMLOListElement>("event-log");
const tokenForm = element<HTMLFormElement>("token-form");
const tokenInput = element<HTMLInputElement>("slack-token");

let definitions: Definition[] = [];
let subscription: Subscription | undefined;
let tokenDefinition: string | undefined;

function say(text: string): void {
  status.textContent = text;
}

function describe(error: unknown): string {
  if (error instanceof ServiceError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

/** Runs an action, reporting failures; `sign-in-required` brings back the sign-in button. */
async function attempt(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ServiceError && error.code === "sign-in-required") showSignedOut();
    say(describe(error));
  }
}

function showSignedOut(): void {
  identity.textContent = "Sign in with Tableau to use Slack from this view.";
  signIn.hidden = false;
  send.disabled = true;
  eventsToggle.disabled = true;
  list.replaceChildren();
}

async function showSignedIn(): Promise<void> {
  const session = service.session;
  identity.textContent = session
    ? `Signed in as ${session.userName} on ${session.siteContentUrl}.`
    : "Signed in.";
  signIn.hidden = true;
  await refresh();
}

const ours = (d: Definition) => d.id === config.botDefinition || d.id === config.userDefinition;

async function refresh(): Promise<void> {
  definitions = (await service.definitions()).filter(ours);
  list.replaceChildren(...definitions.map(row));
  definitionSelect.replaceChildren(
    ...definitions.map(
      (d) =>
        new Option(
          `${d.displayName} (${d.ownership})`,
          d.id,
          false,
          d.id === definitionSelect.value,
        ),
    ),
  );
  send.disabled = definitions.length === 0;
  eventsToggle.disabled = definitions.length === 0;
  if (!definitions.length) say("Neither Slack definition is available to your site.");
}

function row(definition: Definition): HTMLLIElement {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  title.textContent = definition.displayName;
  const detail = document.createElement("span");
  const account = definition.account
    ? ` to ${definition.account.name ?? definition.account.id}`
    : "";
  const whose =
    definition.ownership === "shared" ? "Shared for your site" : "Your own Slack account";
  detail.textContent = `${whose}: ${definition.status.replace(/-/g, " ")}${account}`;
  item.append(title, detail);
  if (definition.ownership === "personal") {
    const actions = document.createElement("div");
    actions.className = "actions";
    if (definition.setup.oauth)
      actions.append(
        button(definition.status === "connected" ? "Reconnect" : "Connect", () =>
          connect(definition.id),
        ),
      );
    if (definition.setup.credential)
      actions.append(button("Use a token", () => useToken(definition.id), true));
    if (definition.status !== "not-connected")
      actions.append(button("Disconnect", () => disconnect(definition.id), true));
    item.append(actions);
  }
  return item;
}

function button(label: string, onClick: () => void, secondary = false): HTMLButtonElement {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  if (secondary) control.className = "secondary";
  control.addEventListener("click", onClick);
  return control;
}

function connect(definitionId: string): void {
  // The popup opens inside the click, before any await.
  const connecting = service.connect(definitionId);
  say("Finish connecting Slack in the window that opened.");
  void attempt(async () => {
    await connecting;
    say("Slack is connected.");
    await refresh();
  });
}

function useToken(definitionId: string): void {
  tokenDefinition = definitionId;
  tokenForm.hidden = false;
  tokenInput.focus();
}

function closeTokenForm(): void {
  tokenDefinition = undefined;
  tokenInput.value = "";
  tokenForm.hidden = true;
}

tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const definitionId = tokenDefinition;
  const token = tokenInput.value.trim();
  // The token is cleared from the page at once; the service seals it and never returns it.
  closeTokenForm();
  if (!definitionId || !token) return;
  void attempt(async () => {
    await service.setCredential(definitionId, { kind: "token", value: token });
    say("Your Slack token is stored.");
    await refresh();
  });
});
element<HTMLButtonElement>("token-cancel").addEventListener("click", closeTokenForm);

function disconnect(definitionId: string): void {
  void attempt(async () => {
    await service.disconnect(definitionId);
    say("Disconnected.");
    await refresh();
  });
}

signIn.addEventListener("click", () => {
  const signingIn = service.signIn();
  say("Sign in with Tableau in the window that opened.");
  void attempt(async () => {
    await signingIn;
    say("Ready.");
    await showSignedIn();
  });
});

send.addEventListener("click", () => {
  const init: RequestInit = { method: method.value };
  if (method.value === "POST") {
    init.body = body.value;
    init.headers = { "content-type": "application/json; charset=utf-8" };
  }
  void attempt(async () => {
    say("Sending…");
    const response = await service.fetch(definitionSelect.value, path.value, init);
    const text = method.value === "HEAD" ? "" : await response.text();
    const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
    output.textContent = `${response.status} ${response.statusText}\n${headers}\n\n${text}`;
    say(`Slack answered ${response.status}.`);
  });
});

eventsToggle.addEventListener("click", () => {
  if (subscription) {
    subscription.close();
    subscription = undefined;
    eventsToggle.textContent = "Listen for events";
    return;
  }
  eventsToggle.textContent = "Stop listening";
  subscription = service.events.subscribe(
    definitions.map((d) => d.id),
    (event) => note(`${event.definitionId}: ${event.type} in ${event.account}`),
    {
      onLoss: (reason) => note(`Events may have been missed (${reason}).`),
      onEnd: (reason) => {
        note(`The event stream ended (${reason}).`);
        subscription = undefined;
        eventsToggle.textContent = "Listen for events";
      },
    },
  );
});

function note(text: string): void {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  eventLog.prepend(item);
  while (eventLog.children.length > 50) eventLog.lastElementChild?.remove();
}

void attempt(async () => {
  if (await service.restore()) await showSignedIn();
  else showSignedOut();
});
