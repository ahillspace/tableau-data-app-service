# Isolated browser verification

These checks use actual Chromium, HTTP(S), Postgres, core authority/session routes, and SDK code with explicit synthetic identity/provider fixtures.
They do not prove initial-enrollment security, real Tableau package restrictions, live Slack behavior, or a supported Server configuration.
Production composition cannot select the test guard or fixture adapters.

Prepare a temporary directory outside the repository for a one-day self-signed loopback HTTPS certificate, an isolated Chrome profile, downloads, media, and evidence.
Use `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1` with task-local `-keyout` and `-out` paths.
Run `npx tsx test/sdk-media-fixture.ts <new-media-directory>` with installed FFmpeg to generate four seconds of VP8 WebM, ten frames per second and a keyframe each second, using its `webm_chunk` muxer.
The media directory contains `image.png` (64 by 48), `video.webm`, and `index.json` with `{duration:4,ranges:[[initStart,initEnd],[cluster0Start,cluster0End],...]}`.
The video is a concatenation of the initialization header and standard WebM Cluster chunks, with those exact inclusive byte ranges.
No media framework or bearer URL is involved.

Set `SDK_TEST_KEY`, `SDK_TEST_CERT`, and `SDK_TEST_MEDIA` and run `npx tsx test/sdk-browser-fixture.ts`.
The fixture binds random loopback ports, creates isolated temporary Postgres state, and prints its HTTPS origin.
Its synthetic enrollment guard accepts only this test process; the checker later closes it and verifies the production-style unavailable error.
Its upstream enforces the entrusted fixture credential, records only safe request metadata, and exposes zero named Slack capabilities.
Set `SDK_TEST_OAUTH=1` in both fixture and checker processes for the OAuth variant; the default exercises configured static setup.
The OAuth variant uses the actual core authorization routes, a loopback HTTPS provider, one-use fixture codes and validated PKCE token exchanges for both Connect and Reconnect.
Send SIGTERM to this owned fixture process after verification so it tears down its servers and database.

Use a unique `CHROME_DEVTOOLS_AXI_SESSION` and task-local `CHROME_DEVTOOLS_AXI_USER_DATA_DIR` for every run.
Set `CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH` to the installed Chromium binary and `CHROME_DEVTOOLS_AXI_CHROME_ARGS` to `--ignore-certificate-errors --no-sandbox` only for this synthetic local fixture.
Configure that isolated profile's `download.default_directory` and `download.prompt_for_download:false` before starting its browser, and set `SDK_TEST_DOWNLOADS` to the same task-local directory.
Run `chrome-devtools-axi start`, then `npx tsx test/sdk-browser-check.ts <fixture-origin> <evidence-directory>` with all of these environment values retained.
The checker uses only chrome-devtools-axi, saves each browser operation, checks actual controls and opaque runtime behavior, captures desktop/mobile/media screenshots, validates popup rejection cases, saves a small authenticated download, and restarts only its own named browser to test restoration.
Stop that named session with `chrome-devtools-axi stop` afterward.

The checker fails on SDK dispatch errors, native carrier/status/body changes, lost preview/cancellation behavior, missing restoration, spoofed popup completion, failed media decoding/seeking, or an absent/incorrect download.
The inherited opaque popup case must reject when the popup cannot acquire the exact service origin.
MediaSource uses independently authenticated 206 byte ranges and seeks to 2.2 seconds in a rendered 160 by 90 video.
The image must decode to 64 by 48, and the browser-saved text file must contain exactly `authenticated download fixture` followed by one newline.
Direct private navigation with ambient cookies must return 401.
