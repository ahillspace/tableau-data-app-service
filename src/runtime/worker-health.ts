import { createServer } from "node:http";

// Bind on the protected host/network only, like the API health routes.
// This listener deliberately registers no application routes.
export function workerHealth(
  status: () => {
    core: boolean;
    jobs: boolean | "disabled";
    sources: boolean | "disabled";
  },
) {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/health/live") {
      response.end(JSON.stringify({ status: "live" }));
      return;
    }
    if (request.url !== "/health/ready") {
      response.writeHead(404).end();
      return;
    }
    const current = status();
    response.statusCode = Object.values(current).some((value) => value === false) ? 503 : 200;
    response.end(JSON.stringify(current));
  });
}
