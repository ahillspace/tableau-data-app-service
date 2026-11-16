# Preset connections and capabilities

A preset is a [provider type](connections.md#provider-types) written for one provider.
It fills in that provider's defaults and adds behavior the generic types cannot describe.
Presets are registered in `src/presets/index.ts`, and a new preset is added there and nowhere else.
Any provider the generic `oauth2`, `static` or `none` types can describe needs no preset.

## What a preset can add

| Hook | Does |
| --- | --- |
| `defaults` | Fills in API hosts, endpoints and credential placement. |
| `validate` | Checks the preset's own `presetOptions`. |
| `authorizationParameters` | Adds provider-specific parameters to the authorization request. |
| `readTokenResponse` | Reads a token response the generic OAuth reader cannot. |
| `describeAccount` | Names the provider account a connection belongs to. |
| `revoke` | Asks the provider to revoke a grant on disconnect. |
| `capabilities` | Named operations called at `/v1/capabilities/{definitionId}/{name}`. |
| `jobHandlers` | Durable work run by the worker; see [Jobs](jobs.md). |
| `eventSource` | Receives and verifies provider deliveries; see [Events](events-sdk.md#event-sources). |

## Installed presets

### Slack

- `type: slack`, with `presetOptions.tokenMode` of `bot` or `user`.
- API host `https://slack.com/api`; OAuth endpoints `https://slack.com/oauth/v2/authorize` and `https://slack.com/api/oauth.v2.access`.
- Bot mode requests `scope` and stores the bot token; user mode requests `user_scope` and stores the installing user's token.
- One Slack app can back a shared bot definition and a personal user definition at the same time, because one install returns both tokens.
- A definition without a client ID takes static tokens only, and static tokens are accepted in either mode.
- The account recorded is the workspace, or the enterprise for an organization-wide Enterprise Grid install that returns no team; `auth.test` names it.
- Token rotation works when the Slack app enables it.
- Disconnecting calls `auth.revoke`.
- No capabilities and no Job handlers.

#### Slack event source

- Verifies `X-Slack-Signature` with the definition's sealed signing secret, and refuses deliveries more than five minutes old.
  A bad signature answers `event-signature-invalid` and an old delivery `event-too-old`, both with status 401.
- Answers Slack's URL verification challenge.
- Acknowledges before fan-out, inside Slack's three-second window.
- The event's account is its team, or its enterprise when no team is present.
- Works the same on bot and user definitions.
  Each definition that receives events needs its own signing secret and its own Request URL in a Slack app.

The [Slack example](../examples/slack/README.md) is a Data App that uses a shared bot definition and a personal user definition side by side.
