import { createServer } from "node:http";
import { InMemoryEventBus } from "@voicescore/eventbus";
import { Projector } from "./projector.js";

const port = Number(process.env.PORT ?? 4100);
const projector = new Projector(new InMemoryEventBus());
void projector.start();
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "projector" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port);
