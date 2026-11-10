import { createServer } from "node:http";
import { Server } from "socket.io";
import { RealtimeHub } from "./hub.js";

const port = Number(process.env.PORT ?? 4003);
const httpServer = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "realtime" }));
    return;
  }
  response.writeHead(404);
  response.end();
});
const io = new Server(httpServer, { cors: { origin: true } });
const hub = new RealtimeHub();
io.on("connection", (socket) => {
  let matchId: string | undefined;
  const send = (event: import("@voicescore/schemas").EventEnvelope): void => {
    socket.emit("event", { envelope: event });
  };
  socket.on("join", (input: { matchId: string; lastSeq?: number }) => {
    matchId = input.matchId;
    for (const event of hub.join(matchId, input.lastSeq, send)) send(event);
  });
  socket.on("leave", () => {
    if (matchId) hub.leave(matchId, send);
  });
  socket.on("disconnect", () => {
    if (matchId) hub.leave(matchId, send);
  });
});
httpServer.listen(port);
