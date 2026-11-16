/** Local HTTPS stand-ins for Tableau and providers, signed by the test run's throwaway CA. */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export type StandIn = { origin: string; port: number; server: Server; close: () => Promise<void> };

export function testCa(): string {
  return readFileSync(join(process.env.TDAS_TEST_ROOT as string, "ca.crt"), "utf8");
}

export async function standIn(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host = "localhost",
): Promise<StandIn> {
  const root = process.env.TDAS_TEST_ROOT as string;
  const server = createServer(
    { key: readFileSync(join(root, "server.key")), cert: readFileSync(join(root, "server.crt")) },
    handler,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `https://${host}:${port}`,
    port,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Resolves every name to IPv4 loopback, where stand-ins listen. */
export const loopback = async (): Promise<{ address: string; family: 4 }[]> => [
  { address: "127.0.0.1", family: 4 },
];
