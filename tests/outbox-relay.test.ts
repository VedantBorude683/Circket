import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../packages/eventbus/src/index.js";
import { InMemoryEventStore } from "../apps/scoring-api/src/store.js";
import { OutboxRelay } from "../apps/outbox-relay/src/relay.js";
import type { MatchConfig } from "@voicescore/schemas";

const config: MatchConfig = {
  matchId: "relay-match",
  battingTeamId: "a",
  bowlingTeamId: "b",
  batters: [
    { id: "b1", name: "One" },
    { id: "b2", name: "Two" }
  ],
  bowlers: [{ id: "w1", name: "Bowler" }],
  rules: {
    overs: 1,
    playersPerSide: 2,
    ballsPerOver: 6,
    wideRuns: 1,
    noballRuns: 1,
    freeHitOnNoBall: true,
    lastManStands: false
  }
};

describe("M3 outbox relay", () => {
  it("publishes each committed outbox event once per relay", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay(store, bus);
    await store.createMatch(config, "owner");
    expect(await relay.publishMatch(config.matchId)).toBe(1);
    expect(await relay.publishMatch(config.matchId)).toBe(0);
    expect(bus.published).toHaveLength(1);
  });
});
