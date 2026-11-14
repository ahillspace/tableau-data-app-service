import {
  type JobListQuery,
  type JobSubmission,
  jobCollectionSchema,
  jobListQuerySchema,
  jobSubmissionSchema,
  jobViewSchema,
  opaqueId,
} from "../public/schemas.js";
import { ClientHttp, jsonRequest } from "./http.js";

export type JobListOptions = JobListQuery & { signal?: AbortSignal };

export class JobsClient {
  constructor(private readonly http: ClientHttp) {}
  /** New key for a new logical command; explicit recovery reuses the original submission unchanged. */
  submission(command: Omit<JobSubmission, "submissionId">): JobSubmission {
    return jobSubmissionSchema.parse({ ...command, submissionId: crypto.randomUUID() });
  }
  submit(command: JobSubmission, options: { signal?: AbortSignal } = {}) {
    const input = jobSubmissionSchema.parse(command);
    return this.http.json(
      `${this.http.appPath}/jobs`,
      jobViewSchema.parse,
      jsonRequest(input, options.signal),
    );
  }
  list(options: JobListOptions = {}) {
    const { signal, ...input } = options;
    const filters = jobListQuerySchema.parse(input);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, String(value));
    return this.http.json(
      `${this.http.appPath}/jobs${query.size ? `?${query}` : ""}`,
      jobCollectionSchema.parse,
      signal ? { signal } : {},
    );
  }
  get(id: string, options: { signal?: AbortSignal } = {}) {
    opaqueId.parse(id);
    return this.http.json(
      `${this.http.appPath}/jobs/${encodeURIComponent(id)}`,
      jobViewSchema.parse,
      options,
    );
  }
  cancel(id: string, options: { signal?: AbortSignal } = {}) {
    opaqueId.parse(id);
    return this.http.json(
      `${this.http.appPath}/jobs/${encodeURIComponent(id)}/cancel`,
      jobViewSchema.parse,
      jsonRequest({}, options.signal),
    );
  }
  result(id: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
    opaqueId.parse(id);
    return this.http.fetch(`${this.http.appPath}/jobs/${encodeURIComponent(id)}/result`, options);
  }
}
