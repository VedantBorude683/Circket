import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../packages/eventbus/src/index.js";
import { Projector } from "../apps/projector/src/projector.js";
import { RealtimeHub } from "../apps/realtime/src/hub.js";
import type { EventEnvelope } from "@voicescore/schemas";

const event = (seq: number): EventEnvelope => ({
  eventId: `event-${seq}`,
  matchId: "m3",
  seq,
  type: "BALL",
  schemaVersion: 1,
  ts: "2026-01-01T00:00:00.000Z",
  actor: { userId: "scorer", role: "scorer" },
  payload: { runsOffBat: seq, source: "button" }
});

describe("M3 realtime pipeline", () => {
  it("projects events idempotently and ignores older delivery", async () => {
    const bus = new InMemoryEventBus();
    const projector = new Projector(bus);
    await projector.start();
    await bus.publish("match.events", "m3", event(2));
    await bus.publish("match.events", "m3", event(1));
    expect(projector.get("m3")?.seq).toBe(2);
  });

  it("replays only the missing events and broadcasts live events", () => {
    const hub = new RealtimeHub();
    const received: number[] = [];
    hub.publish(event(1));
    for (const value of hub.join("m3", 0, (eventValue) =>
      received.push(eventValue.seq)
    )) {
      received.push(value.seq);
    }
    hub.publish(event(2));
    expect(received).toEqual([1, 2]);
    expect(hub.join("m3", 1, () => [])).toHaveLength(1);
  });

  it("bounds reconnect history to 200 events", () => {
    const hub = new RealtimeHub();
    for (let seq = 1; seq <= 201; seq += 1) hub.publish(event(seq));
    expect(hub.join("m3", undefined, () => [])).toHaveLength(200);
  });
});
