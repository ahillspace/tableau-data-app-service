# What we are building

A shared backend lets developers build Tableau Data Apps on Cloud and Server that use native external APIs without a separate backend for every app.
The service verifies the person/site, manages their provider credentials and streams native requests and responses.
The app owns its behavior, including deliberate reads and writes across registered providers.

Personal connections and retained jobs follow the verified owner across configured apps.
Shared operator accounts have explicit site/user audiences; app IDs supply defaults and attribution rather than feature permissions or package identity proof.
Entrusted credentials stay private, while native provider-created credentials may be returned under provider permissions.

Optional capabilities reuse provider code through ordinary HTTP, sharing the same identity, credentials and transport without another permission system or saved inputs/results.
Downloads can stream directly; large output alone does not create a Job.
Explicitly chosen durable jobs keep working after a page closes and release execution capacity while external tasks wait.
Saved results remain available after provider disconnect under current identity and retention.
Optional live notifications use Redis Pub/Sub and authenticated SSE with possible loss; durable job callbacks do not depend on Redis.

The accepted architecture has two independently replicable roles from one codebase, authoritative Postgres and optional Redis, initially one API and one worker.
The worker runs bounded core expiry/mutation recovery even without Jobs, and only relevant Job/source maintenance.
Trusted Job handlers share the worker process; a forced restart can interrupt sibling work with honest unknown outcomes and no replay.

## How Slack fits

Slack is the first real provider/test example; the exact bespoke capability is not selected.
After verified Tableau login and authorized Slack connection setup, a Data App can call native `POST auth.test` through A18; the service reads current authority and its coherent bundle, injects credentials and streams Slack's response.
Slack documents this as an authentication/identity check, with native `ok` and error fields that the app still interprets ([Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/)).
A reusable Slack helper could expose the same or other chosen provider logic through ordinary A39 invocation without storing input/result or requiring a worker Job.
Only a deliberately selected background/recoverable operation uses A20 and its saved-outcome contract; no such Slack feature is mandated here.
If Slack events are enabled, verified native event data can reach authorized Data Apps through Redis/SSE; Slack describes event JSON payloads, not a universal Job-ID completion protocol ([Slack Events API](https://docs.slack.dev/apis/events-api/)).
Source hooks are added only for that chosen integration's actual setup/renewal needs.

## Evidence

Nothing is implemented or deployed.
A Cloud experiment supports separate verified login and site/user identity only; full Cloud/Server sessions, media, recovery and capacity still need proof.
The [PRD](../PRD.md) maps required journeys to the complete owning contracts.
