import { describe, expect, it } from "vitest";
import { ScoringService } from "../apps/scoring-api/src/service.js";
import { InMemoryEventStore } from "../apps/scoring-api/src/store.js";
import type { MatchConfig } from "@voicescore/schemas";

const config: MatchConfig = {
  matchId: "api-match",
  battingTeamId: "a",
  bowlingTeamId: "b",
  batters: [
    { id: "b1", name: "One" },
    { id: "b2", name: "Two" }
  ],
  bowlers: [
    { id: "w1", name: "Bowler" },
    { id: "w2", name: "Second" }
  ],
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

const command = (clientEventId: string) => ({
  clientEventId,
  epoch: 0,
  source: "button" as const,
  command: {
    kind: "set_batter" as const,
    playerId: "b1",
    role: "striker" as const
  }
});

describe("M2 scoring service", () => {
  it("writes events and returns the same result for a retry", async () => {
    const store = new InMemoryEventStore();
    const service = new ScoringService(store);
    await service.createMatch(config, "owner");
    const first = await service.submit(
      config.matchId,
      command("client-1"),
      "owner"
    );
    const second = await service.submit(
      config.matchId,
      command("client-1"),
      "owner"
    );
    expect(second).toEqual(first);
    expect((await store.getEvents(config.matchId)).length).toBe(2);
  });

  it("rejects a stale scorer epoch", async () => {
    const service = new ScoringService(new InMemoryEventStore());
    await service.createMatch(config, "owner");
    await expect(
      service.submit(
        config.matchId,
        { ...command("client-2"), epoch: 1 },
        "owner"
      )
    ).rejects.toMatchObject({ code: "STALE_EPOCH" });
  });

  it("serializes concurrent writes so sequence numbers do not collide", async () => {
    const store = new InMemoryEventStore();
    const service = new ScoringService(store);
    await service.createMatch(config, "owner");
    const requests = ["a", "b"].map((id) =>
      service.submit(config.matchId, command(id), "owner")
    );
    const results = await Promise.allSettled(requests);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(
      (await store.getEvents(config.matchId)).map((event) => event.seq)
    ).toEqual([1, 2]);
  });
});
