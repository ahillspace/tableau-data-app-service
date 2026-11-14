import { ServiceError } from "../http/errors.js";

export async function protocolJson(response: Response, maxBytes = 65536): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ServiceError(
      502,
      "invalid-provider-response",
      "Provider protocol response is missing",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes)
        throw new ServiceError(
          502,
          "invalid-provider-response",
          "Provider protocol response exceeds supported budget",
        );
      chunks.push(part.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new ServiceError(
        502,
        "invalid-provider-response",
        "Provider protocol response is invalid",
      );
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
