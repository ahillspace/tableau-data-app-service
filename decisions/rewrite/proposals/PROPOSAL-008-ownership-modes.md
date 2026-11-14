# PROPOSAL-008: One session core with selectable ownership establishment

Status: unaccepted recommendation, informed by Astra architecture analysis and source research.
Recorded: 2026-11-08.
This does not supersede REWRITE-003's conditional Tableau direction.

## Recommendation

Use one internal owner/session contract, with Tableau-backed establishment preferred if the actual experience passes validation.
Reserve a narrow browser-possession establishment path as an explicit alternative without implementing two full identity systems immediately.
Use one mode per deployment initially; add per-app selection only for an actual requirement.
Both use the same downstream session, connection ownership, provider authorization, proxy, job, and event code.
An opaque owner ID is a resource-ownership record, not a user profile or a registration system.
A verified Tableau identity mapping contains only the identifiers required to recover that owner.

## Why and costs

Tableau ownership fits an always-Tableau frontend and allows the same owner to recover connections and retained jobs across browsers after verified authorization.
Browser ownership removes that extra identity integration but proves control of a browser credential rather than a Tableau person.
Losing that credential can lose access; sharing a browser profile can share access.
Neither mode removes provider consent or MFA when the provider requires it.

Both modes can run in the same deployment without another service or identity provider.
The added work is a second session-establishment journey, Tableau configuration and token lifecycle handling, tests, and an explicit mode-change policy.
Session persistence is a separate choice; fresh Tableau authorization after every reload is not inherent in Tableau ownership.
Neither mode can guarantee remembered access until the embedded browser persistence and authorization journey are tested.

## Prevent unnecessary complexity

Do not create separate proxy or provider pipelines for the two modes.
A Tableau-configured deployment rejects browser-only authority rather than silently falling back after OAuth failure.
Mode changes are operator decisions and must not make previously inaccessible connections visible.
Do not merge owners using email, provider account, or browser profile.
If a mode changes, reconnect under the new owner by default; a transfer proving both owners is a separate feature only if needed.
Browser possession does not establish Tableau site membership or authorize a shared provider installation credential.
Access to shared connections still needs explicit trusted admission and grants.

## Live decision gate

First validate custom Tableau client registration, intended audience and minimum scopes, and server-verifiable stable site/user identity.
Test the published Data App and extension with an existing Tableau login, first consent, repeat use, reload, another tab, expiry, next-day return, logout, and account changes.
Record clicks, consent prompts, credential entry, MFA challenges, failures, and recovery.
Distinguish initial consent from repeated authentication and from provider authorization.
Do not promise no additional login or MFA, nor current-page viewer matching, before the evidence establishes supported behavior.
If silent authorization is supported, handle interaction-required results explicitly; do not silently change ownership mode.
If ordinary repeat use requires unacceptable authentication, adopt browser ownership explicitly instead of maintaining a confusing runtime fallback.

## Next step and runner-up

Build a bounded authentication experience prototype before the final persistence choice; keep provider operations out of the prototype until identity is established.
If Tableau fits, ship it as the only initially enabled establishment mode.
If it fails the experience requirement, ship browser ownership with its explicit portability limits.
Fully implementing both immediately is the runner-up, justified only if actual apps need different configured modes.
No live prototype or runtime authentication test has been performed.
