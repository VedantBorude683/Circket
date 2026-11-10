import { createServer } from "node:http";
import { matchConfigSchema, commandRequestSchema } from "@voicescore/schemas";
import { InMemoryEventStore } from "./store.js";
import { ScoringService } from "./service.js";

const port = Number(process.env.PORT ?? 4001);
const service = new ScoringService(new InMemoryEventStore());
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "scoring-api" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/matches") {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", async () => {
      try {
        const parsed = matchConfigSchema.parse(JSON.parse(body));
        await service.createMatch(
          parsed,
          request.headers["x-user-id"]?.toString() ?? ""
        );
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ matchId: parsed.matchId }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: error instanceof Error ? error.message : "INVALID_REQUEST"
            }
          })
        );
      }
    });
    return;
  }
  const claimMatch = request.url?.match(
    /^\/api\/matches\/([^/]+)\/scorer\/claim$/
  );
  if (request.method === "POST" && claimMatch) {
    const userId = request.headers["x-user-id"]?.toString() ?? "";
    service
      .claimScorer(claimMatch[1], userId)
      .then((epoch) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ epoch }));
      })
      .catch((error: unknown) => {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: error instanceof Error ? error.message : "FORBIDDEN"
            }
          })
        );
      });
    return;
  }
  const commandMatch = request.url?.match(
    /^\/api\/matches\/([^/]+)\/commands$/
  );
  if (request.method === "POST" && commandMatch) {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", async () => {
      try {
        const parsed = commandRequestSchema.parse(JSON.parse(body));
        const result = await service.submit(
          commandMatch[1],
          parsed,
          request.headers["x-user-id"]?.toString() ?? ""
        );
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        const code =
          error instanceof Error && "code" in error
            ? String(error.code)
            : "INVALID_REQUEST";
        const status =
          code === "STALE_EPOCH" || code === "SEQ_CONFLICT" ? 409 : 400;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code,
              message:
                error instanceof Error ? error.message : "Invalid request"
            }
          })
        );
      }
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port);
