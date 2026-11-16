import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { ServiceError } from "../platform/errors.ts";

/** Messages a service page posts to the window that opened it. None carries a bearer or a secret. */
export type OpenerMessage =
  | { type: "tableau-service:sign-in"; transactionId: string; code: string }
  | {
      type: "tableau-service:connect";
      transactionId: string;
      definitionId?: string;
      status: "connected" | "failed";
      code?: string;
    }
  | { type: "tableau-service:operator-sign-in"; code: string; state: string | null }
  | { type: "tableau-service:error"; code: string };

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

/** JSON safe to embed inside a script element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 28rem; padding: 2rem; }
h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
p { line-height: 1.5; margin: 0 0 1rem; }
.code { font-family: ui-monospace, monospace; font-size: 0.85rem; opacity: 0.75; }
form { display: grid; gap: 0.75rem; }
input[type=password] { font: inherit; padding: 0.5rem; }
.actions { display: flex; gap: 0.5rem; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
`;

export type PageOptions = {
  status?: number;
  title: string;
  /** Trusted HTML; every interpolated value must already be escaped. */
  body: string;
  /** A script run with the page's nonce. Values in it must come from `scriptJson`. */
  script?: string;
  /** Extra `form-action` sources, for a form whose answer redirects to a loopback address. */
  formAction?: string[];
};

/**
 * A top-level service page. No caching, no referrer, no framing, and scripts only by nonce.
 * Pages never carry CORS headers: they are not API responses.
 */
export function sendPage(reply: FastifyReply, options: PageOptions): FastifyReply {
  const nonce = randomBytes(16).toString("base64");
  const formAction = ["'self'", ...(options.formAction ?? [])].join(" ");
  reply
    .status(options.status ?? 200)
    .header("content-type", "text/html; charset=utf-8")
    .header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action ${formAction}`,
    )
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY");
  const script = options.script ? `<script nonce="${nonce}">${options.script}</script>` : "";
  return reply.send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${options.body}</main>${script}</body></html>`,
  );
}

/** A page that explains a failure by its stable code, and tells an opener when there is one. */
export function sendErrorPage(
  reply: FastifyReply,
  error: unknown,
  opener?: OpenerMessage,
): FastifyReply {
  const known = error instanceof ServiceError ? error : undefined;
  const status = known?.status ?? 500;
  const code = known?.code ?? "internal-error";
  const message = known?.message ?? "Something went wrong. Close this window and try again.";
  const notify = opener ?? { type: "tableau-service:error", code };
  return sendPage(reply, {
    status,
    title: "Tableau Data App Service",
    body: `<h1>That did not work</h1><p>${escapeHtml(message)}</p><p class="code">${escapeHtml(code)}</p>`,
    script: `if (window.opener) window.opener.postMessage(${scriptJson(notify)}, "*");`,
  });
}

/** Posts a message to the opener and closes. Without an opener it shows `fallback`. */
export function sendOpenerPage(
  reply: FastifyReply,
  message: OpenerMessage,
  title: string,
  fallback: string,
): FastifyReply {
  return sendPage(reply, {
    title,
    body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(fallback)}</p>`,
    script: `if (window.opener) { window.opener.postMessage(${scriptJson(message)}, "*"); window.close(); }`,
  });
}

export function redirect(reply: FastifyReply, location: string, status = 302): FastifyReply {
  return reply
    .status(status)
    .header("location", location)
    .header("referrer-policy", "no-referrer")
    .send();
}
