# Identity

The identity component verifies who a viewer or operator is through Tableau and issues the sessions every other component relies on.
It owns deployments, trusted sites, operators, sign-in sessions, app sessions, the app registry and the "verify app location" step.
Shared types are in [contracts](contracts.md).

## Identity

An identity is a deployment ID, a Tableau site ID and a Tableau user ID.
The site and user IDs are the stable identifiers Tableau returns for the current session, never a name or an email.
Two users with the same username on different sites are different identities.
Display names are kept for display only and never compared, and emails are not stored.

## Deployments and trusted sites

A deployment is one Tableau Cloud pod, named in the bootstrap configuration with its pod origin and OAuth client ID.
A deployment adapter implements Tableau sign-in for its deployment kind.
The one adapter kind is `tableau-cloud`.

A trusted site belongs to one deployment.
Only users signed in to a trusted site get sessions.
A trusted site is first named by its content URL.
On the first verified sign-in to that site, the record binds to the site ID Tableau returns, and from then on only the site ID is matched, so renaming the site's content URL does not change trust.
Operators add, disable and remove trusted sites through the operator API.
Disabling a site ends every session on it at the next request.
Removing a site also removes it from every definition audience and deletes its sessions.
Content URLs are matched case-insensitively.
Trusting a site never adds it to any connection definition's audience.

## Tableau Cloud sign-in

Sign-in uses OAuth authorization code with PKCE against Tableau's central sign-in service, as a public client with the deployment's client ID and scopes `openid email`.

1. The service creates a sign-in transaction with a random `state`, a PKCE verifier and an OpenID Connect `nonce`, stored in Postgres so any replica can complete it.
   A short-lived `__Host-tdas-tableau-tx` cookie binds the transaction to the browser that started it.
   When the installation has several deployments, the popup first asks the viewer to choose a Tableau Cloud pod.
2. The popup redirects to Tableau's authorization endpoint.
3. Tableau redirects to the service's Tableau callback with a code and `state`.
4. The service exchanges the code, validates the ID token's issuer, audience, signature, expiry, nonce and access token hash, and checks the userinfo subject matches.
5. The service calls the pod's REST API `GET /api/3.24/sessions/current` with the access token and reads the site ID, site content URL, user ID and user name.
6. The site must be a trusted site on that deployment, matched by bound site ID or, before binding, by content URL.
7. The service records the identity's last verified Tableau sign-in time and discards Tableau's tokens.

The service keeps no Tableau token.
Any failure from step 3 on fails the sign-in with a reason code and no partial session.

## Sessions

Three records carry a sign-in, each held in a different place.

**Sign-in session.**
Held by the browser as the `__Host-tdas-sign-in` cookie on the service's own origin: `Secure`, `HttpOnly`, `SameSite=Lax`, host-only.
It is set and read only in top-level service windows: the sign-in popup, the connect page and the operator pages.
It records the identity and the last verified Tableau sign-in time.
It is valid while that time is less than the sign-in limit old, seven days by default and configurable.
Nothing but a new Tableau sign-in moves that time.

**Restore cookie.**
Held by the browser for Data App frames as the `__Host-tdas-restore` cookie: `Secure`, `HttpOnly`, `SameSite=None`, `Partitioned`.
Browsers keep a partitioned cookie per top-level site, so every Data App shown under the same Tableau host shares one restore cookie.
It points to the sign-in session and expires with it.

**App session.**
Held by one Data App page as a bearer in memory.
It records the identity, app ID and attribution, and expires when the sign-in session's limit is reached.
Its bearer is a random value; Postgres stores only its hash.
Closing the page discards the bearer and ends nothing on the server.

An operator can revoke every session for an identity.

## App sign-in

A viewer signs in once and every Data App reuses that sign-in until the sign-in limit is reached.

### Restore

On load, the SDK calls `POST /v1/session/restore` with credentials included, sending the app ID and the attribution the app declares (site content URL, workbook and view, read from the page).
If the restore cookie points to a valid sign-in session on a site that is still trusted, the service runs [verify app location](#verify-app-location), records the app and returns a bearer.
The viewer sees nothing.
Otherwise the service returns `sign-in-required`.

### First sign-in

Browsers open popups only from a user gesture, so the first sign-in in a browser starts from a viewer action such as a click.

1. The SDK creates a random proof and asks the service to start an app sign-in, sending the proof's hash, the app ID and the declared attribution.
2. The service stores a short-lived app sign-in transaction and returns its ID.
3. The SDK opens a popup at the service's app sign-in page for that transaction.
4. If the browser has no valid sign-in session, the popup runs [Tableau Cloud sign-in](#tableau-cloud-sign-in).
5. The service issues a one-time completion code bound to the transaction, and the popup posts it to its opener and closes.
6. The SDK redeems the completion code together with its proof, with credentials included.
   The response carries the bearer and sets the restore cookie for the frame's partition.

The completion code is useless without the proof, which never leaves the SDK instance that started the transaction.
The popup posts the code only to the window that opened it, and refuses to run a transaction when it has no opener, so a link sent to a viewer cannot complete someone else's sign-in.
The bearer never appears in a URL or a cross-window message.
Transactions expire after ten minutes, and a completion code can be redeemed once.

When the browser already has a sign-in session, for example from a Data App under a different Tableau host, step 4 is skipped and the popup closes at once.

### Credentialed routes

Restore and redeem are the only routes that read or set a cookie from a Data App frame.
They answer CORS by echoing the request's `Origin`, including `null`, with `Access-Control-Allow-Credentials: true`.
Every other API route is called without credentials.

### What restore trusts

A restore cookie exists only in the partition of a Tableau host where the viewer signed in, so a page outside Tableau cannot use it.
Any Data App shown under that same Tableau host can restore the viewer's session, including an app on another site of the same pod whose administrators allow the service's origin.
This follows from [verify app location](#verify-app-location), which does not prove the calling app's site.

### Verify app location

Restore and redeem both run one named step, "verify app location", before they issue a bearer.
It decides what the service knows about where the calling app runs.
It records the declared app ID, site content URL, workbook and view as attribution only and reports the location as unverified.
The bearer's authority comes from the verified Tableau sign-in on a trusted site, never from the declared attribution.
A check that proves the app's location would replace this step's body without changing its callers or any other component.

## App registry

The app ID is a label the Data App declares: a printable string of 1 to 200 characters, with each attribution field up to 1,000.
The first app sign-in or restore with a new app ID records it, and every app session records the app ID and declared attribution.
The registry gives operators a list of apps with first seen, last seen, sites, workbooks and session counts.
It is attribution, not access control; no request is refused because of its app ID.

## Operators

An operator is a named identity with authority over the whole installation.
An operator record is first named by deployment, site content URL and Tableau username.
On that person's first verified sign-in to that site, the record binds to their site ID and user ID, and from then on the name is never matched.
No Tableau role makes anyone an operator.
Operators add and remove other operators through the operator API.
The last operator cannot be removed through the API.

Operators sign in with Tableau through two paths:

- **Browser tools** open the service's operator sign-in page in a popup with `?mode=popup` and receive an operator bearer the same way the SDK redeems a completion code.
- **The command-line tool** uses a loopback sign-in, as many developer command-line tools do.
  It listens on a random port on `127.0.0.1`, creates a PKCE verifier, and opens the browser at the service's operator sign-in page with the loopback address and the PKCE challenge.
  The operator signs in with Tableau if needed and approves on a consent screen that states operator access.
  The service redirects to the loopback address with a one-time code, and the CLI redeems the code with its verifier for an operator bearer, which it stores in the host's credential store.
  The code reaches only the machine that started the sign-in, so a link sent to an operator cannot hand operator access to someone else.

Operator bearers come only from the operator sign-in page, which runs in a top-level service window and asks the operator to approve operator access.
App sessions, including restored ones, never carry operator authority, so a Data App that restores an operator's session cannot use the operator API.
The operator API checks the bearer's identity against the operators table on every call.
Operator bearers expire with the operator's sign-in limit.

### Recovery

The `tdas-admin operators add --deployment <id> --site <content-url> --user <username>` command, run on the service host with the service's own settings, adds a named operator record without any sign-in.
It is the only path that changes operators without an operator session, and it writes an audit record.

## Bootstrap

The bootstrap configuration holds:

- deployments: ID, kind, pod origin and OAuth client ID;
- the first trusted site: deployment ID and content URL;
- the first operator: deployment ID, site content URL and username;
- the service's public origin, optional when `PUBLIC_ORIGIN` is set;
- the sign-in limit, if not the default.

Deployments are applied on every start of the API role, because each needs an OAuth client registered with Tableau.
The first site and first operator are applied only while their table is empty.
After that, trusted sites and operators are runtime data and bootstrap entries for them are ignored with a log line naming the ignored fields.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Tableau sign-in unavailable | New sign-ins fail with `tableau-unavailable`; existing sessions keep working. |
| User signs in to an untrusted site | Sign-in fails with `site-not-trusted`, naming the site content URL. |
| Popup blocked | The SDK reports `popup-blocked` so the app can ask for another click. |
| Popup closed before completion | The SDK reports `popup-closed`; the transaction expires. |
| Sign-in limit reached | Restore and the next request return `sign-in-required`; the app calls `signIn` again from a viewer action. |
| Browser blocks partitioned cookies | Restore returns `sign-in-required` on each load and the viewer signs in from a click; the popup closes at once while the sign-in session is valid. |
| Every operator locked out | Recover with `tdas-admin operators add` on the host. |

## Extension

- A new deployment kind is a `DeploymentAdapter` with `authorizationUrl` and `complete` that returns the same identity.
- A proof of the app's location replaces the body of [verify app location](#verify-app-location).
