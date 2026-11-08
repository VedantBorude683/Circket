import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4000);
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "gateway" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port);
