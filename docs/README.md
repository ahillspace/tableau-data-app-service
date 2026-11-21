# Documentation

These documents specify the current service contract.
The provider-intake and console changes are authorized for implementation; [verification](verification.md) distinguishes required gates from completed implementation and live evidence.
[specification.json](../specification.json) lists them, and [specification.html](specification.html) is an offline view generated from them.

| Document | Owns |
| --- | --- |
| [Product](product.md) | What the service does, who uses it, journeys, and what it does not include. |
| [Architecture](architecture.md) | Topology, trust boundaries, components and dependency direction. |
| [Shared contracts](contracts.md) | Types and rules shared across components. |
| [Identity](identity.md) | Tableau sign-in, sessions, app sign-in, verify app location, operators and bootstrap. |
| [Connections](connections.md) | Definition, application-secret and owner-credential boundaries, setup and generations. |
| [Provider protocol data](provider-protocol.md) | Typed acquisition, client authentication, response mapping, import, hosts and inbound verification. |
| [Provider catalog](presets.md) | Independent templates, provider recipes and code extension boundaries. |
| [Operator console](console.md) | Optional two-tab UI, shared operator transport and failure states. |
| [Metrics](metrics.md) | Minute counts, merged histograms, freshness, boundedness and loss semantics. |
| [Routing](routing.md) | Native request forwarding, streaming and destination checks. |
| [Relational Storage](storage.md) | Opt-in PostgreSQL workspaces, SQL authoring, GraphQL data access and sharing. |
| [Jobs](jobs.md) | Durable work. |
| [Events and SDK](events-sdk.md) | Live events and the browser SDK. |
| [Persistence and operations](operations.md) | Tables, TLS, sealing keys, configuration and health. |
| [API](api.md) | Every route. |
| [Flows](flows.md) | End-to-end sequences. |
| [Verification](verification.md) | What the automated tests cover, what is not verified live, and known limitations. |
| [Running](running.md) | Install, configure, run and operate. |

## Rebuild the offline view

The generator lives in `scripts/specification/`.
Install its pinned Markdown renderer outside the checkout and run from the repository root:

```sh
npm install --prefix /tmp/tdas-doc-tools --save-exact marked@16.4.2
REVIEW_MARKED=/tmp/tdas-doc-tools/node_modules/marked python3 scripts/specification/build.py
```

Do not hand-edit `specification.html`.
