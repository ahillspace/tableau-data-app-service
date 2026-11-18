import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadCatalog, templates } from "../src/catalog/index.ts";
import { validateDefinition } from "../src/connections/validation.ts";
import { standardTokenResponse } from "./support/definitions.ts";

test("catalog JSON is validated, cloned and ships without secret or executable setup fields", async () => {
  const raw = await Promise.all(
    templates.map(async (t) =>
      JSON.parse(
        await readFile(new URL(`../src/catalog/templates/${t.id}.json`, import.meta.url), "utf8"),
      ),
    ),
  );
  const loaded = loadCatalog(raw);
  assert.deepEqual(loaded, templates);
  loaded[0]!.definition.displayName = "Independent draft";
  assert.notEqual(raw[0].definition.displayName, loaded[0]!.definition.displayName);
  assert.throws(() => loadCatalog([...raw, raw[0]]), /Duplicate/);
  assert.throws(
    () =>
      loadCatalog([
        {
          ...raw[0],
          definition: { ...raw[0].definition, secrets: { clientSecret: "never-in-catalog" } },
        },
      ]),
    /schema/,
  );
  assert.throws(
    () =>
      loadCatalog([
        {
          ...raw[0],
          definition: {
            ...raw[0].definition,
            authentication: { method: "execute", script: "not-code" },
          },
        },
      ]),
    /schema/,
  );
  assert.throws(
    () =>
      loadCatalog([
        { ...raw[0], definition: { ...raw[0].definition, credentialPlacement: { kind: "basic" } } },
      ]),
    /Invalid catalog/,
  );
});

test("private_key_jwt binds assertion client claims to the authoritative client ID", () => {
  const definition = {
    id: "client-assertion",
    displayName: "Client assertion",
    ownership: "shared",
    apiHosts: ["https://provider.example"],
    audience: [],
    authentication: {
      method: "client_credentials",
      tokenEndpoint: "https://provider.example/token",
      scopeParameter: { name: "scope", separator: " " },
      response: standardTokenResponse,
      clientAuthentication: {
        method: "private_key_jwt",
        clientId: "client-one",
        jwt: {
          algorithm: "RS256",
          issuer: "different-client",
          subject: "client-one",
          audience: "https://provider.example/token",
          ttlSeconds: 300,
        },
      },
    },
  };
  const wrongIssuer = validateDefinition(definition, { siteIds: new Set() });
  assert.ok(
    wrongIssuer.errors.some((e) => e.path === "authentication.clientAuthentication.jwt.issuer"),
  );
  definition.authentication.clientAuthentication.jwt.issuer = "client-one";
  definition.authentication.clientAuthentication.jwt.subject = "different-client";
  const wrongSubject = validateDefinition(definition, { siteIds: new Set() });
  assert.ok(
    wrongSubject.errors.some((e) => e.path === "authentication.clientAuthentication.jwt.subject"),
  );
  definition.authentication.clientAuthentication.jwt.subject = "client-one";
  assert.deepEqual(validateDefinition(definition, { siteIds: new Set() }).errors, []);
});

test("scope parameter names cannot replace engine-owned protocol parameters", () => {
  const owned = [
    "grant_type",
    "state",
    "code",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "code_verifier",
    "assertion",
    "client_assertion",
    "client_assertion_type",
    "client_id",
    "client_secret",
    "response_type",
    "refresh_token",
  ];
  for (const method of ["authorization_code", "client_credentials"] as const) {
    const definition = {
      id: "scope-parameter",
      displayName: "Scope parameter",
      ownership: "shared",
      apiHosts: ["https://provider.example"],
      audience: [],
      scopes: ["read", "write"],
      authentication: {
        method,
        tokenEndpoint: "https://provider.example/token",
        clientAuthentication: { method: "none", clientId: "client" },
        scopeParameter: { name: "scope", separator: " " },
        response: standardTokenResponse,
        ...(method === "authorization_code"
          ? { authorizationEndpoint: "https://provider.example/authorize", pkce: "S256" }
          : {}),
      },
    };
    for (const name of owned) {
      definition.authentication.scopeParameter.name = name;
      const result = validateDefinition(definition, { siteIds: new Set() });
      assert.ok(
        result.errors.some((error) => error.path === "authentication.scopeParameter.name"),
        `${method} rejects engine-owned scope parameter ${name}`,
      );
    }
    for (const name of ["scope", "user_scope", "permissions"]) {
      definition.authentication.scopeParameter.name = name;
      assert.deepEqual(
        validateDefinition(definition, { siteIds: new Set() }).errors,
        [],
        `${method} retains provider scope parameter ${name}`,
      );
    }
    definition.authentication.scopeParameter.name = "scope";
    for (const field of method === "authorization_code"
      ? ["authorizeParameters", "tokenParameters", "refreshParameters"]
      : ["tokenParameters"]) {
      for (const name of owned) {
        const result = validateDefinition(
          {
            ...definition,
            authentication: { ...definition.authentication, [field]: { [name]: "literal" } },
          },
          { siteIds: new Set() },
        );
        assert.ok(
          result.errors.some((error) => error.path === `authentication.${field}`),
          `${method} keeps ${name} reserved in ${field}`,
        );
      }
    }
  }
});
