import { createServer } from "node:http";
import { parserContextSchema } from "@voicescore/schemas";
import { Parser, ParserCircuitOpenError, ParserBusyError } from "./parser.js";

const port = Number(process.env.PORT ?? 4002);
const parser = new Parser(async () => ({
  kind: "ask_clarification",
  question: "The configured LLM adapter is unavailable"
}));
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "parser" }));
    return;
  }
  if (request.method === "POST" && request.url === "/parse") {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", async () => {
      try {
        const input = JSON.parse(body) as {
          transcript?: unknown;
          context?: unknown;
        };
        if (typeof input.transcript !== "string")
          throw new Error("TRANSCRIPT_REQUIRED");
        const context = parserContextSchema.parse(input.context ?? {});
        const parsed = await parser.parse(input.transcript, context);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ parsed }));
      } catch (error) {
        const status =
          error instanceof ParserBusyError ||
          error instanceof ParserCircuitOpenError
            ? 503
            : 422;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: error instanceof Error ? error.message : "PARSE_FAILED"
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
