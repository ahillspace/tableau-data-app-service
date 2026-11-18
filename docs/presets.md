# Provider catalog and code extensions

The catalog owns JSON data templates in src/catalog/templates/ that prefill independent runtime connection definitions.
The owning module validates the JSON with the shared definition schemas at startup, and the service build copies the JSON beside the compiled loader.
Blank top-level setup stays absent from catalog defaults, while required nested identifiers and generic endpoint values use explicit placeholders.
Run npm run examples:slack to regenerate the Slack example definitions from the same JSON source.
A template does not execute authentication code, and catalog edits never mutate existing definitions.
Operators can start from a template or configure the same finite protocol schema from scratch.

## Template fields

| Field | Does |
| --- | --- |
| id, name, description | Identify the catalog entry without implying runtime provider identity. |
| definition | Prefill hosts, ownership, acquisition, client authentication and credential placement. |
| response mappings | Extract nested tokens, scopes, expiry and optional account metadata. |
| account lookup and revocation | Describe fixed requests using shared outbound transport. |
| credential import | Map JSON fields into the owner credential and compare an imported token endpoint. |
| webhook | Select finite verification, handshake and event extraction primitives. |

Templates contain no real tenant IDs, deployment URLs, audience sites, credentials or personal setup data.
The runtime connection definition is the source of authority after creation.

## Templates

### Slack bot

- Uses authorization_code with a shared connection by default.
- API hosts are https://slack.com/api and https://files.slack.com.
- Requests bot scopes in scope and reads the top-level bot token.
- Maps token expiry and refresh credentials, and treats an HTTP 200 response with ok:false as a failure.
- Describes account lookup, revocation and timestamped raw-body HMAC verification as data.

### Slack user

- Uses authorization_code with personal ownership by default.
- Requests user_scope and reads the initial token from authed_user, with a distinct refresh-response mapping.
- Keeps the same Slack API/file hosts and verification primitives.
- A Data App can use shared bot and personal user definitions side by side, without an SDK provider branch.

The nested user token and scope distinction follows [Slack OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/), and refresh responses follow [Slack token rotation](https://docs.slack.dev/authentication/using-token-rotation/).
Use a static definition with these hosts when a token is entered directly; a missing client ID never changes the configured grant method.
A failed account lookup is informational, and failed remote revocation does not keep the local credential.

### Google service account

- Uses jwt_bearer with RS256 and an explicit token audience and endpoint.
- Maps client_email, private_key and private_key_id from service-account JSON into the owner-bound credential.
- Compares imported token_uri with the configured endpoint rather than adopting it as a destination.
- Includes the exact global https://aiplatform.googleapis.com host and the constrained https://*-aiplatform.googleapis.com regional pattern.

The service-account assertion exchange follows [Google's OAuth service-account protocol](https://developers.google.com/identity/protocols/oauth2/service-account).
The service does not provision projects, IAM grants, keys, models or provider resources.
Live calls require an authorized project, service-account identity, model and location supplied for that test.

### Generic API key

- Uses static acquisition with explicit bearer, named header, query parameter or HTTP Basic placement.
- Accepts a shared operator credential or a personal owner credential through the same connections owner.

### Generic OAuth 2.0

- Uses authorization_code with configurable endpoints, PKCE, client authentication, scopes and response mappings.
- Describes provider differences as finite data rather than scripts or an arbitrary expression language.

## Native request recipes

A definition can include several exact hosts and constrained wildcard hosts.
Select a concrete host in the native request; never send the wildcard literal as the selection.

```ts
const file = await service.fetch("workspace-chat", "/files/example", {
  headers: { "Tableau-Service-Host": "https://files.slack.com" }
});
const response = await service.fetch("models", "/v1/projects/PROJECT/locations/LOCATION/publishers/google/models/MODEL:streamGenerateContent?alt=sse", {
  method: "POST",
  headers: {
    "Tableau-Service-Host": "https://us-central1-aiplatform.googleapis.com",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Example prompt" }] }] })
});
const reader = response.body?.getReader();
```

PROJECT, LOCATION and MODEL are placeholders for an explicitly authorized provider test.
The Data App owns response parsing and UI; a response stream remains a native stream.
For a global call select the exact global host and the matching provider path.
For a personal definition call service.connect for authorization_code, or service.setCredential with a typed owner credential, before the same native request.
A shared definition is connected by an operator and requires no provider sign-in by each viewer.
The [Slack example](../examples/slack/README.md) demonstrates shared and personal use.

## Failure and extension

Invalid template data fails catalog validation rather than partially populating a definition.
A provider using supported methods requires only another data template.
A genuinely new acquisition or verification protocol adds one shared engine primitive with bounded contracts and behavioral tests.
Capabilities and Job handlers remain code extension points for named business work and use the same credential lease and outbound transport.
They do not grant or restrict native endpoint access.
