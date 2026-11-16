import { applyBootstrap } from "../../src/identity/directory.ts";
import { IdentityService } from "../../src/identity/sessions.ts";
import { TableauCloudAdapter, tableauClientMetadata } from "../../src/identity/tableau-cloud.ts";
import type { Db } from "../../src/persistence/database.ts";
import type { Clock } from "../../src/platform/clock.ts";
import { Log } from "../../src/platform/log.ts";
import { Outbound } from "../../src/platform/outbound.ts";
import { pkceChallenge, randomToken } from "../../src/platform/secrets.ts";
import { loopback, testCa } from "./https.ts";
import { type TableauStandIn, type TableauUser } from "./tableau.ts";

export const DEPLOYMENT = "cloud-test";
export const SERVICE_ORIGIN = "https://service.test";

export function testOutbound(): Outbound {
  return new Outbound({
    connectTimeoutMs: 2000,
    headersTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    extraCa: [testCa()],
    resolver: loopback,
  });
}

export class MovableClock implements Clock {
  offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

export type IdentityHarness = {
  identity: IdentityService;
  clock: MovableClock;
  outbound: Outbound;
  lines: string[];
  close: () => Promise<void>;
};

export async function identityHarness(
  db: Db,
  tableau: TableauStandIn,
  options: {
    site?: string;
    operator?: { site: string; username: string };
    signInLimitSeconds?: number;
  } = {},
): Promise<IdentityHarness> {
  const lines: string[] = [];
  const log = new Log((line) => lines.push(line));
  const outbound = testOutbound();
  await applyBootstrap(
    db,
    {
      deployments: [
        {
          id: DEPLOYMENT,
          kind: "tableau-cloud",
          podOrigin: tableau.origin,
        },
      ],
      firstSite: { deploymentId: DEPLOYMENT, contentUrl: options.site ?? "alpha" },
      firstOperator: {
        deploymentId: DEPLOYMENT,
        siteContentUrl: options.operator?.site ?? "alpha",
        username: options.operator?.username ?? "op@example.com",
      },
    },
    log,
  );
  const adapter = new TableauCloudAdapter({
    deploymentId: DEPLOYMENT,
    podOrigin: tableau.origin,
    clientId: tableauClientMetadata(SERVICE_ORIGIN).client_id,
    fetch: outbound.fetcher(true),
    metadata: tableau.metadata,
  });
  const clock = new MovableClock();
  const identity = new IdentityService({
    db,
    adapters: new Map([[DEPLOYMENT, adapter]]),
    publicOrigin: SERVICE_ORIGIN,
    signInLimitSeconds: options.signInLimitSeconds ?? 7 * 86400,
    clock,
    log,
  });
  return { identity, clock, outbound, lines, close: () => outbound.close() };
}

/** Runs a full Tableau sign-in as the given user and returns the sign-in cookie. */
export async function tableauSignIn(
  h: IdentityHarness,
  tableau: TableauStandIn,
  user: TableauUser,
  returnTo = "/done",
) {
  const begun = await h.identity.beginTableauSignIn({ deploymentId: DEPLOYMENT, returnTo });
  const query = tableau.authorize(begun.authorizationUrl, user);
  return await h.identity.completeTableauSignIn({ query, browserToken: begun.browserToken });
}

/** Runs an app sign-in through a valid sign-in cookie and redeems it. */
export async function appSignIn(h: IdentityHarness, cookie: string, appId = "app-one") {
  const proof = randomToken();
  const { transactionId } = await h.identity.startAppSignIn({
    proofHash: pkceChallenge(proof),
    appId,
    attribution: { workbook: "wb" },
  });
  const session = await h.identity.readSignInSession(cookie);
  if (!session) throw new Error("no sign-in session");
  const code = await h.identity.issueCompletionCode(transactionId, session);
  return await h.identity.redeemAppSignIn(transactionId, { code, proof });
}

/** Runs the operator consent flow and returns an operator bearer. */
export async function operatorSignIn(h: IdentityHarness, cookie: string) {
  const verifier = randomToken();
  const id = await h.identity.beginOperatorSignIn({
    mode: "loopback",
    redirectUri: "http://127.0.0.1:4555/cb",
    codeChallenge: pkceChallenge(verifier),
  });
  const session = await h.identity.readSignInSession(cookie);
  if (!session) throw new Error("no sign-in session");
  const { consent } = await h.identity.prepareOperatorConsent(id, session);
  const { code } = await h.identity.approveOperatorSignIn(id, consent, session);
  return await h.identity.redeemOperatorCode({ code, verifier });
}
