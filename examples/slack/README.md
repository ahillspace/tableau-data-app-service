# Slack Data App example

This small browser app uses the public SDK to restore an existing service session, deliberately sign in, connect or reconnect Slack, and send native requests.
Slack has no named capabilities.
The example has no feature grants, approval, tenant, or quota screens.

Run `npm run example` after starting the local service and configuring its app, deployment, and Slack registration.
Set `SERVICE_ORIGIN`, `APP_ID`, `TABLEAU_DEPLOYMENT_ID`, and optionally `EXAMPLE_PORT` for the example process.
The defaults are `http://127.0.0.1:3000`, `example`, `tableau`, and `3100`.
Allow the example origin in the service's operator-controlled CORS configuration.
For a packaged Data App, bundle `app.ts` with its nonsecret `EXAMPLE_CONFIGURATION` and include `index.html` and `style.css`.
The browser needs a supported popup that escapes an inherited opaque sandbox for the correlated service window.

Functional first login is enabled; the user explicitly deferred the initial cross-client silent-enrollment binding fix recorded in the run guide.
The example uses no browser storage, unpartitioned cookie or alternative login fallback.
Existing-session restoration uses the credentialed service endpoint; ordinary requests use only the per-client memory bearer.
Local browser fixtures exercise the production Cloud identity adapter against a synthetic HTTPS issuer and provider and do not establish live Tableau Cloud, Server, or Slack acceptance.

Connect Slack uses the configured OAuth setup when available, or exposes the explicitly configured static token setup.
Token input is cleared immediately after submission and is never saved by the example.
Reconnect selected account sends its expected authority generation rather than silently selecting or replacing a different connection.

The native request control defaults to `/auth.test` and displays status, useful response headers, and incremental text.
Native errors remain native responses.
The example stops its text preview at 40,000 characters; this is a UI preview bound, not a service response-size cap.
Stop reading cancels local stream consumption and does not claim to roll back a provider operation.
Closing the page disposes local resources without disconnecting accounts or cancelling durable Jobs.

The SDK's `request` and `invoke` resolve at headers and leave body consumption to the caller.
For media, the browser checks demonstrate a decoded small authenticated image, app-owned authenticated byte ranges into standard MediaSource with a real video seek, and a small app-owned download.
There is no reusable query bearer, media token URL, or whole-video Blob workaround.
Direct image/video/download navigation cannot attach the service bearer and is not supported by this example.
An arbitrary-size direct-to-disk download remains outside the demonstrated browser path; do not substitute an unbounded Blob accumulation.

Run `npm run typecheck:example` for the example's strict TypeScript check.
The isolated browser harness is documented in [synthetic browser verification](../../docs/running.md#synthetic-browser-verification).
