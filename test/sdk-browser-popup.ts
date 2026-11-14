import { correlatedPopup } from "../src/sdk/handoff.js";

declare const EXAMPLE_CONFIGURATION: { serviceOrigin: string };
document.getElementById("launch")!.addEventListener("click", () => {
  const mode = document.body.dataset.case!;
  const popup = window.open("about:blank", "_blank", "popup,width=500,height=400");
  if (!popup) throw new Error("Fixture popup blocked");
  const status = document.getElementById("status")!;
  const controller = new AbortController();
  const foreign =
    mode === "wrong-origin"
      ? "foreign"
      : mode === "wrong-transaction"
        ? "wrong-transaction"
        : ["wrong-window", "closed", "aborted"].includes(mode)
          ? "quiet"
          : "valid";
  const extra = document.createElement("iframe");
  const pending = correlatedPopup({
    popup,
    serviceOrigin: EXAMPLE_CONFIGURATION.serviceOrigin,
    transactionId: "window-test",
    launchUrl: `/fixture/popup/window-test/${foreign}`,
    proof: "test-only-window-proof",
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    signal: controller.signal,
  });
  if (mode === "wrong-window") {
    extra.hidden = true;
    extra.src = "/fixture/popup/window-test/valid";
    document.body.append(extra);
  }
  if (mode === "closed") setTimeout(() => popup.close(), 100);
  if (mode === "aborted")
    setTimeout(() => controller.abort(new DOMException("Fixture abort", "AbortError")), 100);
  void pending
    .then(
      () => {
        status.textContent =
          mode === "valid" ? `passed:${mode}` : `FAILED:${mode}:unexpected completion`;
      },
      (error) => {
        status.textContent =
          mode !== "valid" ? `passed:${mode}:${error.message}` : `FAILED:${mode}:${error.message}`;
      },
    )
    .finally(() => {
      popup.close();
      extra.remove();
    });
});
