# Slack Data App example

This browser app uses the service SDK to call Slack from a Tableau view in two ways at once.
A shared definition in bot mode calls Slack as the workspace's bot, with a token the operator connected once for the site.
A personal definition in user mode calls Slack as the signed-in user, with the token that user connected for themselves.
The app code is the same for both; only the definition ID changes whose credential the service uses.

## What it shows

- Restoring an existing session on load with no prompt, and signing in with Tableau from a click when there is none.
- Listing both definitions with their ownership and this user's connection status.
- Connecting, reconnecting and disconnecting the personal definition through the service's OAuth popup, with a static definition offering write-only token entry instead when configured that way.
- Sending any native Slack request, such as `GET /auth.test` or `POST /chat.postMessage`, and showing Slack's own response with its status and headers.
- Listening for live Slack events for both definitions, and noting when events may have been missed.

## Set up the service

One Slack app can back both definitions, because one Slack install returns a bot token and a user token.
In the Slack app, add `{service origin}/v1/oauth/callback` as a redirect URL, and request the bot and user scopes the two definition files list.
As an operator, fill in the Slack client ID in [definitions/slack-bot.json](definitions/slack-bot.json) and [definitions/slack-user.json](definitions/slack-user.json), and replace the audience placeholder with trusted site record IDs from `tdas sites list`, then create them with the `tdas` CLI.
The `secret` command reads piped stdin, `--from-file PATH`, or a hidden terminal prompt.
File and stdin input preserve trailing newlines, so a single-line token must be supplied without an added newline.
The API seals every value and returns only set/setAt metadata.

```sh
tdas definitions create examples/slack/definitions/slack-bot.json
tdas definitions create examples/slack/definitions/slack-user.json
tdas definitions secret slack-bot clientSecret
tdas definitions secret slack-user clientSecret
tdas definitions connect slack-bot
```

Users connect `slack-user` themselves from the example page.
For live events, point the Slack app's event subscription Request URL at `{service origin}/v1/events/ingest/slack-bot`, and seal the Slack signing secret with `tdas definitions secret slack-bot signingSecret`.
A Slack app has one Request URL, so events arrive on `slack-bot` only; the page also subscribes to `slack-user`, and that stream stays quiet unless a second Slack app delivers to `/v1/events/ingest/slack-user` with its own signing secret.
Events delivered to one definition reach every open stream for it whose user's site is in its audience, for shared and personal definitions alike.
See the [connections](../../docs/connections.md) and [running](../../docs/running.md) docs for every option.

## Run it

Start the service, then run `npm run example` from the repository root.
The page is served on `http://127.0.0.1:3100`.

| Variable          | Default                 | Meaning                                |
| ----------------- | ----------------------- | -------------------------------------- |
| `SERVICE_ORIGIN`  | `http://127.0.0.1:3000` | The service's public origin.           |
| `APP_ID`          | `slack-example`         | The app ID recorded with each session. |
| `BOT_DEFINITION`  | `slack-bot`             | The shared bot definition's ID.        |
| `USER_DEFINITION` | `slack-user`            | The personal user definition's ID.     |
| `EXAMPLE_PORT`    | `3100`                  | The local port for the page.           |

To package it as a Data App, bundle `app.ts` with the same configuration and include `index.html` and `style.css`.

## Notes

- The SDK keeps the service bearer in memory only; the example stores nothing in the browser.
- A pasted token is cleared from the page as soon as it is submitted, and the service never returns it.
- Native errors are Slack's own responses and are shown as they arrived; only the service's own errors are reported as SDK errors.
- Closing the page leaves connections and Jobs in place.
