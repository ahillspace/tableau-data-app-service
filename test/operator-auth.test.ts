import assert from "node:assert/strict";
import { test } from "node:test";
import { tableauSignIn } from "./support/identity.ts";
import { intakeFixture } from "./support/intake.ts";

class Browser {
  readonly jar = new Map<string, string>();
  readonly origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("cookie", [...this.jar].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(`${this.origin}${path}`, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const at = (pair as string).indexOf("=");
      const name = (pair as string).slice(0, at),
        value = (pair as string).slice(at + 1);
      if (/Max-Age=0(?:;|$)/.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }
  async consent(decision = "approve") {
    const begin = await this.request("/operator-sign-in?mode=console");
    assert.equal(begin.status, 303);
    const page = await this.request(begin.headers.get("location") as string);
    if (page.status !== 200) return page;
    const html = await page.text();
    const field = (name: string) =>
      new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1] as string;
    return this.request("/operator-sign-in", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        transaction: field("transaction"),
        consent: field("consent"),
        decision,
      }).toString(),
    });
  }
  admin(path: string, init: RequestInit = {}) {
    return this.request(path, {
      ...init,
      headers: { "sec-fetch-site": "same-origin", ...init.headers },
    });
  }
}

test("console uses the operator consent grant and confines its cookie to same-origin admin authority", async () => {
  const f = await intakeFixture(true);
  try {
    const browser = new Browser(f.origin);
    browser.jar.set("__Host-tdas-sign-in", f.operator.cookie);
    assert.equal(
      (await browser.admin("/v1/admin/session")).status,
      401,
      "plain sign-in cookie is not an operator grant",
    );
    const approved = await browser.consent();
    assert.equal(approved.status, 303, await approved.clone().text());
    assert.equal(approved.headers.get("location"), "/console");
    const operatorCookie = approved.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-tdas-operator="));
    assert.ok(operatorCookie);
    for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"])
      assert.ok(operatorCookie.includes(attribute));
    assert.equal(/Domain=/i.test(operatorCookie), false);
    assert.equal(browser.jar.has("__Host-tdas-console-tx"), false);
    const session = await browser.admin("/v1/admin/session");
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("access-control-allow-credentials"), null);
    const data = await session.json();
    assert.equal(data.operator.displayName, "op@example.com");
    assert.ok(data.csrfToken);
    assert.equal(
      JSON.stringify(data).includes(browser.jar.get("__Host-tdas-operator") as string),
      false,
    );
    assert.equal(
      (await browser.request("/v1/admin/definitions")).status,
      403,
      "cookie reads need same-origin context",
    );
    assert.equal(
      (
        await browser.admin("/v1/admin/definitions", {
          headers: { origin: "https://cross.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await browser.admin("/v1/admin/definitions", {
          headers: { "Tableau-Service-Authorization": `Bearer ${f.grant.bearer}` },
        })
      ).status,
      400,
    );
    assert.equal(
      (await browser.request("/v1/native/missing")).status,
      401,
      "operator cookie never authorizes app routes",
    );
    const body = {
      id: "cookie-key",
      displayName: "Cookie key",
      ownership: "shared",
      apiHosts: ["https://api.example"],
      authentication: { method: "static" },
      audience: [f.siteId],
    };
    const mutation = (headers: Record<string, string>) =>
      browser.admin("/v1/admin/definitions", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await mutation({})).status, 403);
    assert.equal((await mutation({ origin: "https://service.test" })).status, 403);
    assert.equal(
      (await mutation({ origin: "https://cross.example", "x-tdas-csrf": data.csrfToken })).status,
      403,
    );
    assert.equal(
      (await mutation({ origin: "https://service.test", "x-tdas-csrf": "wrong" })).status,
      403,
    );
    assert.equal(
      (await mutation({ origin: "https://service.test", "x-tdas-csrf": data.csrfToken })).status,
      201,
    );
    assert.equal(
      (
        await browser.admin("/v1/admin/session/logout", {
          method: "POST",
          headers: {
            origin: "https://service.test",
            "content-type": "application/x-www-form-urlencoded",
            "x-tdas-csrf": data.csrfToken,
          },
          body: "x=1",
        })
      ).status,
      415,
    );
    const logout = await browser.admin("/v1/admin/session/logout", {
      method: "POST",
      headers: {
        origin: "https://service.test",
        "content-type": "application/json",
        "x-tdas-csrf": data.csrfToken,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal(browser.jar.has("__Host-tdas-operator"), false);
    assert.equal((await browser.admin("/v1/admin/session")).status, 401);
    // Replaying a copied cookie after logout cannot restore its deleted operator session.
    browser.jar.set("__Host-tdas-operator", /=([^;]+)/.exec(operatorCookie)?.[1] as string);
    assert.equal((await browser.admin("/v1/admin/session")).status, 401);
  } finally {
    await f.close();
  }
});

test("console denial, non-operator, removed authority, expiry and disabled helpers fail closed", async () => {
  const f = await intakeFixture(true);
  try {
    const browser = new Browser(f.origin);
    browser.jar.set("__Host-tdas-sign-in", f.operator.cookie);
    const denied = await browser.consent("deny");
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.get("location"), "/console?auth=denied");
    assert.equal(browser.jar.has("__Host-tdas-operator"), false);
    const nonOperator = await tableauSignIn(f.h, f.tableau, {
      siteId: "site-a",
      siteContentUrl: "alpha",
      userId: "viewer",
      userName: "viewer@example.com",
    });
    const viewer = new Browser(f.origin);
    viewer.jar.set("__Host-tdas-sign-in", nonOperator.cookie);
    const refused = await viewer.consent();
    assert.equal(refused.status, 403);
    const refusal = await refused.text();
    assert.match(refusal, /not an operator/);
    assert.match(refusal, /<h1>Operator access required<\/h1>/);
    assert.match(refusal, /Tableau sign-in succeeded/);
    assert.equal(viewer.jar.has("__Host-tdas-operator"), false);
    assert.equal((await browser.consent()).status, 303);
    await f.db.deleteFrom("operators").where("user_id", "=", "user-op").execute();
    assert.equal(
      (await browser.admin("/v1/admin/session")).status,
      403,
      "authority is rechecked on every request",
    );
    f.h.clock.offsetMs += 8 * 86400_000;
    assert.equal((await browser.admin("/v1/admin/session")).status, 401);
  } finally {
    await f.close();
  }
  const disabled = await intakeFixture();
  try {
    assert.equal((await fetch(`${disabled.origin}/console`)).status, 404);
    assert.equal((await fetch(`${disabled.origin}/console/assets/index.js`)).status, 404);
    assert.equal((await fetch(`${disabled.origin}/operator-sign-in?mode=console`)).status, 404);
  } finally {
    await disabled.close();
  }
});
