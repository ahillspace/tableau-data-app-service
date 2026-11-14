import {
  type JobSubmission,
  jobSubmissionSchema,
  jobViewSchema,
  opaqueId,
} from "../public/schemas.js";
import { ClientHttp, jsonRequest } from "./http.js";

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
