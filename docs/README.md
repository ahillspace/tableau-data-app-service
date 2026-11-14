# Documentation

The working application serves Tableau Data Apps on Cloud and Server through native provider authentication/proxy, with optional HTTP capabilities, Jobs and Events.
Slack ships `capabilities: []`.

Open [specification.html](specification.html) for the complete offline specification, including navigation, source text and SHA-256 hashes.
[specification.json](../specification.json) is the sole current source inventory.
Archives preserve prior evidence and never supply current requirements or implementation defaults.

| Current source | Owns |
| --- | --- |
| [Product](product.md) | Accepted policy, scope and observable user journeys. |
| [Architecture](architecture.md) | Topology, trust boundaries, module ownership, dependency direction and extension paths. |
| [Shared contracts](contracts.md) | Illustrative shared types and cross-component handoffs. |
| [Access and connections](access-connections.md) | Identity, sessions, registry, audiences and credential lifecycle. |
| [Providers and execution](providers-execution.md) | Native transport, ordinary capabilities and deliberate durable Jobs. |
| [Events and wire](events-http-sdk.md) | Source lifecycle, Redis/SSE, HTTP carriers and browser SDK. |
| [Persistence and operations](persistence-operations.md) | State ownership, snapshots/locks, resources, migration and key maintenance. |
| [API](api.md) / [flows](flows.md) | Route/resource boundary map and end-to-end sequences, linked to component owners. |
| [Verification](verification.md) | Acceptance obligations, E gates and limitations; unchecked scenarios are not pass evidence. |
| [Implementation](implementation.md) | Observed application evidence, five test coverage gaps, deferred login risk and live limits. |
| [Setup and operation](running.md) | Install/configure/run commands, extension setup and synthetic browser procedure. |

## Rebuild the offline specification

The generator and editable presentation sources live in `scripts/specification/`.
The presentation is derived from the sources above, not separately maintained policy.
Install the pinned build-time Markdown renderer outside the checkout and run from the repository root:

```sh
npm install --prefix /tmp/tdas-doc-tools --save-exact marked@16.4.2
REVIEW_MARKED=/tmp/tdas-doc-tools/node_modules/marked python scripts/specification/build.py
python scripts/spec_snapshot.py
```

The HTML has no runtime network dependencies.
The generator requires every manifest source and validates embedded document/heading links before writing `docs/specification.html`.
Do not hand-edit that generated file.
The repository, runtime source, examples and tooling references remain repository references in the offline view.

For local browser verification, use an existing `playwright-core` installation and Chromium:

```sh
REVIEW_PLAYWRIGHT=/path/to/node_modules/playwright-core REVIEW_OUTPUT_DIR=/tmp/tdas-doc-check node scripts/specification/check-ui.cjs
```

The existing checker exercises navigation, API/flow/module selection, current source links/hashes, all expanded sources at narrow width, keyboard controls, print and a local iframe.
Set `REVIEW_OUTPUT_DIR` outside the checkout to keep screenshots, PDF and check records out of current requirements.
This checks the document only and does not rerun application, live Tableau or Slack acceptance.
Prior plans, decisions, reviews, frozen designs and the earlier HTML are preserved under [archives](../archives/README.md), with their original evidence scope.
