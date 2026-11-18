# Operational observations and metrics

Operations owns these read-only operator views and bounded Postgres aggregates.
The API/process/worker composition already owns the required storage and maintenance; there is no new monitoring service.

`GET /v1/admin/status` returns the following safe view.

```ts
type Observation<T> = {
  state: "ok" | "disabled" | "unavailable" | "stale" | "unknown";
  observedAt: string | null; value: T | null;
};
type StatusView = {
  observedAt: string; version: string; revision: number;
  readiness: Observation<{ ready: boolean }>;
  database: Observation<{ reachable: boolean }>;
  events: Observation<{ connected: boolean }>;
  processes: { instanceId: string; role: "api" | "worker"; startedAt: string;
    lastHeartbeatAt: string; state: "ok" | "stale"; uptimeSeconds: number }[];
  connections: Observation<Record<"connected"|"needs-authorization"|"disconnected",number>>;
  jobs: Observation<Record<string,number>>;
  activity: Observation<{ windowSeconds: 900; activeSessions: number; activeApps: number }>;
};
```

Status reads are independent observations, not a globally transactional monitoring snapshot.
Events disabled is state disabled with value null, not unavailable or evidence of a Redis outage.
Unknown means no observation; stale means a prior observation aged out; unavailable means an attempted current observation failed.
Readiness follows the existing service health contract; events failure affects event readiness without making telemetry a routing dependency.
API and worker processes write a heartbeat every 15 seconds using a random UUID per process start.
Heartbeats become stale after 45 seconds; retain stale processes for 24 hours, then prune them.
Show every process uptime separately rather than inventing one installation uptime after replica restarts.
Active sessions counts unexpired app/operator session records whose last authenticated request was within 15 minutes, excluding revoked/untrusted sessions.
Active apps counts distinct registered app IDs attached to those active app sessions, not active people, approved applications or workbook instances.
Activity uses the last-seen timestamp returned by each authoritative authentication read to skip UPDATE statements while the observation is fresh.
Once older than one minute, it attempts a conditional update so concurrent stale observations cannot overwrite a newer timestamp.
Observation-only persistence failures retain a valid principal and emit a safe diagnostic; session expiry, revocation and trust checks remain authoritative and fail closed.
No in-memory authorization cache, scheduler or extra service is involved, and a stale observation may be retried on a later authenticated request if persistence failed.

`GET /v1/admin/metrics?from=<ISO>&to=<ISO>&definition=<id>` returns `{from,to,observedAt,flushedThrough,mayBeIncomplete,series,totals}`.
Require minute-aligned bounds, a maximum 24-hour window and a range within retained data; default is the preceding complete hour.
Each series row is `{minute,definitionId,status,requests,errors,upstreamSamples,upstreamHistogram,upstreamP50Ms,upstreamP95Ms,refreshFailures,exchangeFailures}`.
Status is an integer HTTP code or the finite values `transport-error`, `cancelled`, `service-error` for requests with no final response status.
Definition labels are known stable definition IDs or `_unknown`; native paths, methods, query values, URLs, bodies, accounts and user IDs are not labels.
Counts cover native requests admitted to a known definition, counted once at completion or cancellation, not capabilities, polling, token requests or console traffic.
An error is native HTTP status >=400, a transport/service failure or cancellation, and the breakdown keeps these distinguishable.
Upstream latency measures monotonic elapsed time from starting the native outbound attempt to upstream response headers; it excludes credential checkout and body streaming.
Only attempts receiving response headers enter the upstream histogram; headers from an upstream error still count as a sample.
Use disjoint millisecond buckets with upper bounds `[10,25,50,100,250,500,1000,2500,5000,10000,30000,120000,Infinity]`.
Serialize the unbounded bucket boundary as null and return null percentiles when no samples exist or the percentile falls in that overflow bucket.
Merge bucket counts from all instances first, then return the upper bound of the bucket reaching ceil(q * samples); never average replica percentiles.
Refresh/exchange failures count completed failed credential operations, including uncertain outcomes, separately from the resulting native error count.

In-memory aggregation flushes every 10 seconds and on orderly shutdown without a synchronous metric write on the native request path.
Persist cumulative snapshots keyed by `(instanceId,minute,definitionId,status)` with monotonically increasing snapshot sequence; an upsert replaces only an older sequence.
Retries resend the same snapshot/sequence, so repeated or out-of-order delivery cannot double-count or subtract counts.
Keep at most 2 minutes of unflushed data and 4096 series keys per instance, with excess dimensions folded into `_other` and recorded as degraded coverage.
Drop expired unflushed data rather than delaying native traffic; report gaps/degraded telemetry and keep mayBeIncomplete true when completeness cannot be established.
With a healthy database, abrupt process loss can lose up to the current 10-second unflushed interval; during an outage all unflushed buffered data can be lost on crash.
Persisted data is retained for 7 days and pruned by existing worker maintenance.
`flushedThrough` is the oldest acknowledged complete-minute boundary across fresh reporting API instances; it is null when reporting membership/coverage is unknown.
These are operational estimates, not billing or exactly-once business records.
`GET /v1/admin/audit` retains its entries wrapper and cursor, adding validated action/definition filters and a maximum limit of 200.
Never introduce a raw URL/body/secret/user-ID metric dimension.

## Metrics response types

```ts
type Histogram = { upperBoundsMs: (number | null)[]; counts: number[] };
type MetricTotals = {
  requests: number; errors: number; upstreamSamples: number;
  upstreamHistogram: Histogram; upstreamP50Ms: number | null; upstreamP95Ms: number | null;
  refreshFailures: number; exchangeFailures: number;
};
type MetricSeries = MetricTotals & { minute: string; definitionId: string; status: number | "transport-error" | "cancelled" | "service-error" };
type MetricsView = {
  from: string; to: string; observedAt: string; flushedThrough: string | null;
  mayBeIncomplete: boolean; series: MetricSeries[]; totals: MetricTotals;
};
```

Totals and series use the same half-open [from,to) interval and optional exact definition filter.
Without a filter they include every known definition and the bounded unknown/other aggregates.
Histogram counts are disjoint and every row has identical bounds.
A token failure can create a service-error row with zero native requests and nonzero credential failure counters; it never invents a native request.
Audit uses the existing entries wrapper and before cursor, with action and definition filters and no implicit total count.

## Recovery and extension

Retry the same cumulative snapshot and sequence after a failed flush.
Reject out-of-order snapshots and retain process restart identity so replicas cannot overwrite one another.
A crash loses unflushed data; outages and bounded-buffer drops must remain visible as incomplete coverage.
Extend telemetry only with a defined count/latency meaning and bounded labels, through the existing asynchronous collector.
A new measurement cannot become a native-routing dependency.
