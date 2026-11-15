# Routing

The router forwards a Data App's native request to a provider with the right credential and streams the response back.
It owns the native request path, destination checks and streaming.
Requirements come from [product](product.md); credentials come from [connections](connections.md).

## Request shape

A Data App calls `/v1/native/{definitionId}/{path}` with any HTTP method, query, headers and body.
The router joins `{path}` and the query to the definition's first API host, or to the host the app names with the `Tableau-Service-Host` request header when that host is one of the definition's `apiHosts`.
The path is forwarded byte for byte as the app sent it.
The joined URL must stay on the chosen API host and under its base path; that is the only path rule.

## What the router changes

On the request, the router:

- removes every `Tableau-Service-*` header, including the service bearer, which the SDK always sends as `Tableau-Service-Authorization`;
- removes hop-by-hop headers (`Connection` and the headers it names, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) and sets `Host`;
- places the credential the definition calls for, setting that one header or query parameter and leaving every other app header, including `Authorization` when the placement is elsewhere, as sent.

On the response, the router removes hop-by-hop headers and adds CORS headers that expose every response header to the app.
It changes nothing else: status, headers, caching, content type and body pass through.

The router sets no size limit on bodies or headers, no limit on method names, no content-type rule, and no cap on concurrent outgoing connections.
It blocks no provider endpoint.

## Streaming

Request and response bodies stream through with backpressure; the router never buffers a whole body.
A healthy stream has no total time limit.
Idle timeouts apply to connecting, to waiting for response headers, and to a stream that makes no progress, each configurable.
A client abort aborts the upstream request; an upstream abort ends the client response with an error.

## Retries

The router never retries a request.
A failure is reported with whether the request may have reached the provider:

| Code | Meaning |
| --- | --- |
| `upstream-unreachable` | Connection was never established; the provider did not receive the request. |
| `upstream-interrupted` | The connection failed after the request started; the provider may have acted. |
| `upstream-timeout` | An idle timeout fired; the provider may have acted. |

A provider's own error is not a router failure; its status and body pass through unchanged.

## Destination checks

The router protects the credentials it holds and the network it runs in.

- Only HTTPS API hosts are reached, with verified TLS against the system trust store.
- Each connection's resolved address is checked when the socket opens, so DNS changes cannot redirect a credential.
  Loopback, link-local, private, unique-local, multicast and cloud metadata addresses are refused unless the definition sets `privateHosts`; metadata addresses are refused always.
- Redirects are returned to the app, never followed by the router, so a credential never follows a redirect.

## Credential placement

| Placement | Request change |
| --- | --- |
| `bearer` | `Authorization: Bearer <token>`. |
| `header` | A named header with an optional prefix. |
| `query` | A named query parameter. |

## Capabilities

A preset may register capabilities: named operations, written in code, that run inside an API request with the same checkout and transport as native requests.
They are called at `/v1/capabilities/{definitionId}/{name}`.
They exist for preset convenience; every native endpoint stays reachable through the router.
The Slack preset registers none in the first build.

## Failure and recovery

| Failure | Behavior |
| --- | --- |
| Checkout fails | The checkout's code is returned with status 401, 403 or 404; nothing is sent upstream. |
| Destination refused | `destination-refused`, naming the host, not the address. |
| TLS verification fails | `upstream-tls-failed`. |
| Upstream failure | One of the codes in [retries](#retries). |

## Extension

A preset may set its API hosts, its credential placement, and capabilities.
A new placement is a new entry in the placement table, implemented once in the router.
