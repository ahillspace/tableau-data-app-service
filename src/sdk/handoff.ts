import { ProtocolError } from "./http.js";

export async function initiationProof(): Promise<{ proof: string; verifier: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const proof = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof));
  return {
    proof,
    verifier: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}
export function openPopup(): Window {
  const popup = window.open("about:blank", "_blank", "popup,width=560,height=720");
  if (!popup) throw new Error("Allow the sign-in popup and try again");
  return popup;
}
export function correlatedPopup(input: {
  popup: Window;
  serviceOrigin: string;
  transactionId: string;
  launchUrl: string;
  proof: string;
  expiresAt: string;
  signal?: AbortSignal;
}): Promise<void> {
  const url = new URL(input.launchUrl, input.serviceOrigin);
  if (url.origin !== input.serviceOrigin || url.search || url.hash)
    throw new ProtocolError("Invalid popup launch locator");
  const remaining = Date.parse(input.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Handoff expired");
  return new Promise((resolve, reject) => {
    let transferred = false;
    const cleanup = () => {
      window.removeEventListener("message", message);
      input.signal?.removeEventListener("abort", abort);
      clearTimeout(deadline);
      clearInterval(closed);
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const abort = () =>
      fail(input.signal?.reason ?? new DOMException("Handoff aborted", "AbortError"));
    const message = (event: MessageEvent) => {
      if (
        event.source !== input.popup ||
        event.origin !== input.serviceOrigin ||
        !event.data ||
        event.data.transactionId !== input.transactionId
      )
        return;
      if (event.data.type === "integration:ready" && !transferred) {
        transferred = true;
        input.popup.postMessage(
          { type: "integration:proof", transactionId: input.transactionId, proof: input.proof },
          input.serviceOrigin,
        );
      } else if (event.data.type === "integration:complete" && transferred) {
        cleanup();
        resolve();
      }
    };
    const deadline = setTimeout(() => fail(new Error("Handoff expired")), remaining);
    const closed = setInterval(() => {
      if (input.popup.closed) fail(new Error("Popup closed before verified completion"));
    }, 250);
    window.addEventListener("message", message);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.popup.location.href = url.href;
  });
}
