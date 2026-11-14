# Goal assessment

Status: independent initial design proposal, not accepted design or verified software.
This draft was authored from the current goal baseline and private architecture research before consulting earlier specifications.

## Required outcome

A solutions engineer configures a Tableau Data App once, then uses one browser client to discover and invoke the capabilities enabled for that app.
The shared service owns external authorization and credentials, attributes activity to the configured app, and keeps provider differences behind narrow server modules.
The service has one administrative boundary and serves multiple configured apps.
The user has selected Node.js LTS, strict TypeScript, Fastify, Postgres, and Kysely as the working technology direction.

Individual actions use individual delegated authorization wherever supported.
An operation that requires no external credentials does not trigger a connection flow.
An explicitly configured service operation may use a service credential without requiring the viewer to connect an account.
A failed delegated operation never changes execution identity to get a successful result.

The viewer's Tableau session, a configured app ID, a URL, and an allowed browser origin are not sufficient authority for this backend.
The front door and onboarding remain deferred.
The design must therefore specify a trusted request-binding contract without inventing its transport or claiming a deployable authentication solution.
No general user directory, developer tenancy, provider-specific workflow, or provider implementation is part of this work.

## Recommended initial shape

Use one server process, one Postgres database, statically registered provider and capability modules, and a framework-independent browser SDK.
Organize the server around access, connections, credentials, capabilities, execution, and events, with thin HTTP and persistence adapters.
These are ownership boundaries within one application, not separate deployable services or packages by default.
Run capabilities inline within bounded requests.
Persist operation receipts so a lost response or interrupted write can be represented honestly without building a job system.
Use a durable event feed with authenticated polling first; additional delivery transports can consume the same feed later.

External protocol handling uses maintained libraries.
Provider adapters supply validated endpoint configuration, credential behavior, permission interpretation, and operation-specific request/response mapping.
The core supplies authority checks, encrypted storage, renewal coordination, controlled outbound requests, limits, receipts, and event delivery.

## Acceptance evidence

The ten goal scenarios are mapped to executable future checks in [verification.md](verification.md).
At this stage a design is reviewable when each scenario has an owner, precise contracts, failure states, and a recovery path.
Source inspection and contract walkthroughs do not establish live Tableau or provider compatibility.
Acceptance by the user and implementation verification remain separate later milestones.

## Open dependencies

| Dependency | Required decision or evidence | What remains possible now |
| --- | --- | --- |
| Trusted request binding | Select how a request proves its configured app and, when needed, a private execution holder. | Specify and test the domain boundary using trusted fixtures. |
| Holder continuity | Decide whether a holder survives only one browser session or can be recovered through a trusted external subject. | Bind delegated connections to the exact verified holder; provide no unproven cross-session recovery. |
| Tableau/browser support | Test selected Cloud/Server versions, Data App hosting, browser network access and authorization return behavior. | Keep the SDK independent and document required browser operations. |
| First real provider | Confirm its grant types, identity evidence, scopes, renewal, idempotency, pagination and event guarantees. | Prove module composition with synthetic providers. |
| Operational limits | Select request deadlines, event retention, receipt retention, credential key custody and backup policy. | Define validated configuration and safe failure behavior for absent requirements. |

No missing dependency authorizes an insecure default.
In particular, an unconfigured access adapter rejects requests instead of trusting app IDs, headers, origins, or Tableau display metadata.
