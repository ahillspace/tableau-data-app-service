import type { Attribution } from "../persistence/schema.ts";

export type { Attribution };

/** An identity is a deployment, a Tableau site ID and a Tableau user ID; all three must match. */
export type Identity = { deploymentId: string; siteId: string; userId: string };

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.deploymentId === b.deploymentId && a.siteId === b.siteId && a.userId === b.userId;
}

/** The route key for an identity, as used by `POST /v1/admin/identities/{key}/revoke-sessions`. */
export function identityKey(identity: Identity): string {
  return `${identity.deploymentId}:${identity.siteId}:${identity.userId}`;
}

export function parseIdentityKey(key: string): Identity | undefined {
  const parts = key.split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) return undefined;
  const [deploymentId, siteId, userId] = parts as [string, string, string];
  return { deploymentId, siteId, userId };
}

/** Who is calling, resolved from a service bearer on every request. */
export type Principal = {
  sessionId: string;
  kind: "app" | "operator";
  identityId: string;
  identity: Identity;
  /** The trusted site record the identity signed in through; definition audiences name these. */
  trustedSiteId: string;
  siteContentUrl: string;
  userName: string;
  appId: string | null;
  attribution: Attribution;
  location: { verified: boolean };
  expiresAt: Date;
};

/** A valid sign-in session, read from the sign-in cookie in a top-level service window. */
export type SignInSession = {
  id: string;
  identityId: string;
  identity: Identity;
  trustedSiteId: string;
  siteContentUrl: string;
  userName: string;
  verifiedAt: Date;
  expiresAt: Date;
};

/** The audit actor for a caller: operators and viewers are both named by identity. */
export function actorOf(principal: Pick<Principal, "kind" | "identity">): string {
  return `${principal.kind === "operator" ? "operator" : "identity"}:${identityKey(principal.identity)}`;
}
