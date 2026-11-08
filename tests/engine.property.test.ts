import { describe, expect, it } from "vitest";
import {
  apply,
  initialState,
  replay,
  validate
} from "../packages/engine/src/index.js";
import type { EventEnvelope, MatchConfig } from "@voicescore/schemas";

const config: MatchConfig = {
  matchId: "property",
  battingTeamId: "a",
  bowlingTeamId: "b",
  batters: [
    { id: "1", name: "One" },
    { id: "2", name: "Two" },
    { id: "3", name: "Three" }
  ],
  bowlers: [
    { id: "w1", name: "W1" },
    { id: "w2", name: "W2" }
  ],
  rules: {
    overs: 3,
    playersPerSide: 3,
    ballsPerOver: 6,
    wideRuns: 1,
    noballRuns: 1,
    freeHitOnNoBall: true,
    lastManStands: false
  }
};
const meta = {
  matchId: config.matchId,
  eventId: "event",
  ts: "2026-01-01T00:00:00.000Z",
  actor: { userId: "u", role: "scorer" as const }
};

function baseEvents(): EventEnvelope[] {
  let state = initialState(config);
  const commands = [
    {
      ...meta,
      kind: "set_batter" as const,
      playerId: "1",
      role: "striker" as const
    },
    {
      ...meta,
      eventId: "2",
      kind: "set_batter" as const,
      playerId: "2",
      role: "non_striker" as const
    },
    { ...meta, eventId: "3", kind: "set_bowler" as const, playerId: "w1" },
    ...Array.from({ length: 12 }, (_, index) => ({
      ...meta,
      eventId: `ball-${index}`,
      kind: "record_ball" as const,
      ball: { runsOffBat: index % 4, source: "button" as const }
    }))
  ];
  const events: EventEnvelope[] = [];
  for (const command of commands) {
    const result = validate(state, command);
    if (!result.ok) break;
    for (const event of result.value) {
      events.push(event);
      state = apply(state, event);
    }
    if (state.awaiting === "NEW_BOWLER") {
      const bowler = validate(state, {
        ...meta,
        eventId: `bowler-${events.length}`,
        kind: "set_bowler",
        playerId: "w2"
      });
      if (bowler.ok) {
        events.push(...bowler.value);
        state = apply(state, bowler.value[0]);
      }
    }
  }
  return events;
}

describe("engine properties", () => {
  it("replay is deterministic", () => {
    const events = baseEvents();
    expect(replay(events, config)).toEqual(replay(events, config));
  });

  it("apply followed by undo restores the prior score state", () => {
    const events = baseEvents();
    const before = replay(events, config);
    const last = [...events].reverse().find((event) => event.type === "BALL");
    expect(last).toBeDefined();
    if (!last) return;
    const undo: EventEnvelope = {
      ...meta,
      eventId: "undo",
      seq: last.seq + 1,
      type: "UNDO",
      schemaVersion: 1,
      payload: { targetSeq: last.seq }
    };
    const after = replay([...events, undo], config);
    expect(after.innings[0].runs).toBeLessThanOrEqual(before.innings[0].runs);
    expect(after.innings[0].legalBalls).toBe(before.innings[0].legalBalls - 1);
  });

  it("total runs equal the sum of accepted delivery runs", () => {
    const events = baseEvents();
    const expected = events
      .filter((event) => event.type === "BALL")
      .reduce((sum, event) => {
        const payload = event.payload as {
          runsOffBat: number;
          extra?: { runs: number };
        };
        return sum + payload.runsOffBat + (payload.extra?.runs ?? 0);
      }, 0);
    expect(replay(events, config).innings[0].runs).toBe(expected);
  });

  it("valid command sequences never exceed the configured legal balls", () => {
    const state = replay(baseEvents(), config);
    expect(state.innings[0].legalBalls).toBeLessThanOrEqual(
      config.rules.overs * config.rules.ballsPerOver
    );
  });
});
