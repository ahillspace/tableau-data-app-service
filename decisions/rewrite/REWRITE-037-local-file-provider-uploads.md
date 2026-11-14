# REWRITE-037: Stream local-file uploads from Data Apps to providers

Status: explicitly accepted by the user.
Recorded: 2026-11-10.

## Decision

Support a file selected from the user's device through a Tableau Data App and uploaded through this service to an authorized registered provider.
Stream supported upload bodies with bounded buffering/backpressure instead of loading the complete file into server memory.
Honor the provider's upload contract and limits, and make any service upload limit configurable.
No numeric upload cap is selected; the earlier proposed 1 MiB limit is not an accepted default.
The response's proposed 5 GB setting does not automatically become the upload setting.

## Boundaries

The Data App owns file selection and application logic; no new service-owned upload screen or user approval workflow is selected.
Browser-authorized file selection does not grant this service arbitrary access to the user's filesystem, and a local path string is not an upload body.
Native raw-file and multipart forms use the registered provider's supported protocol, content types and destination rules.
Provider-specific multipart, resumable or signed-destination mechanisms require explicit engineering and verification; this decision does not claim universal browser/protocol compatibility.
No caller-controlled upload URL may bypass registration, destination validation or credential routing.

Use ordinary request/connection authorization before dispatch, bounded memory and cancellation/cleanup on disconnect or transfer failure.
Do not automatically replay an interrupted upload or claim the provider rolled back bytes/actions already accepted.
Uploads do not become durable managed jobs or require permanent file storage merely because they are large.
Previously accepted optional capabilities and app-directed cross-provider operations remain available.

## Integration and evidence

D04 upload support and streaming direction are settled; configuration sizing, provider-specific wire handling and actual browser/hosting support remain engineering evidence work.
Verify selected local files, native bytes/content types, multipart boundaries, provider/service limit failures, slow receivers, cancellation and bounded server memory on representative large transfers.
No upload implementation, browser filesystem access or runtime compatibility has been tested by recording this decision.
