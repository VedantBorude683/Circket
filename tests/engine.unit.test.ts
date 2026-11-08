import { describe, expect, it } from "vitest";
import {
  apply,
  initialState,
  replay,
  validate
} from "../packages/engine/src/index.js";
import type {
  BallPayload,
  EventEnvelope,
  MatchConfig
} from "@voicescore/schemas";

const config: MatchConfig = {
  matchId: "m1",
  battingTeamId: "a",
  bowlingTeamId: "b",
  batters: [
    { id: "b1", name: "One" },
    { id: "b2", name: "Two" },
    { id: "b3", name: "Three" }
  ],
  bowlers: [
    { id: "w1", name: "Bowler" },
    { id: "w2", name: "Bowler 2" }
  ],
  rules: {
    overs: 2,
    playersPerSide: 3,
    ballsPerOver: 6,
    wideRuns: 1,
    noballRuns: 1,
    freeHitOnNoBall: true,
    lastManStands: false
  }
};
const meta = {
  matchId: "m1",
  eventId: "id",
  ts: "2026-01-01T00:00:00.000Z",
  actor: { userId: "u", role: "scorer" as const }
};
const ball = (
  runsOffBat: number,
  extra?: BallPayload["extra"]
): BallPayload => ({ runsOffBat, extra, source: "button" });

function eventsFor(commands: Parameters<typeof validate>[1][]) {
  let state = initialState(config);
  const events: EventEnvelope[] = [];
  for (const command of commands) {
    const result = validate(state, command);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    events.push(...result.value);
    for (const event of result.value) state = apply(state, event);
  }
  return { state, events };
}

describe("engine cricket rules", () => {
  it("scores legal runs and rotates strike on odd runs", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "id2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "id3", kind: "set_bowler", playerId: "w1" },
      { ...meta, eventId: "id4", kind: "record_ball", ball: ball(1) }
    ]);
    expect(state.innings[0].runs).toBe(1);
    expect(state.innings[0].strikerId).toBe("b2");
  });

  it("does not count wides or no-balls as legal balls and sets free hit", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "id2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "id3", kind: "set_bowler", playerId: "w1" },
      {
        ...meta,
        eventId: "id4",
        kind: "record_ball",
        ball: ball(0, { type: "wide", runs: 1 })
      },
      {
        ...meta,
        eventId: "id5",
        kind: "record_ball",
        ball: ball(0, { type: "noball", runs: 1 })
      }
    ]);
    expect(state.innings[0].runs).toBe(2);
    expect(state.innings[0].legalBalls).toBe(0);
    expect(state.innings[0].freeHit).toBe(true);
  });

  it("rotates after running an additional run on a wide", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "wide-2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "wide-3", kind: "set_bowler", playerId: "w1" },
      {
        ...meta,
        eventId: "wide-4",
        kind: "record_ball",
        ball: ball(0, { type: "wide", runs: 2 })
      }
    ]);
    expect(state.innings[0].strikerId).toBe("b2");
  });

  it("records byes and leg byes without awarding batter runs", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "bye-2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "bye-3", kind: "set_bowler", playerId: "w1" },
      {
        ...meta,
        eventId: "bye-4",
        kind: "record_ball",
        ball: ball(0, { type: "bye", runs: 2 })
      },
      {
        ...meta,
        eventId: "bye-5",
        kind: "record_ball",
        ball: ball(0, { type: "legbye", runs: 1 })
      }
    ]);
    expect(state.innings[0].runs).toBe(3);
    expect(state.innings[0].batters.b1.runs).toBe(0);
    expect(state.innings[0].batters.b1.balls).toBe(2);
  });

  it("requires a different bowler after an over", () => {
    let state = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "over-2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "over-3", kind: "set_bowler", playerId: "w1" },
      ...Array.from({ length: 6 }, (_, index) => ({
        ...meta,
        eventId: `over-${index + 4}`,
        kind: "record_ball" as const,
        ball: ball(0)
      }))
    ]).state;
    expect(state.awaiting).toBe("NEW_BOWLER");
    expect(
      validate(state, {
        ...meta,
        eventId: "same",
        kind: "set_bowler",
        playerId: "w1"
      }).ok
    ).toBe(false);
    const next = validate(state, {
      ...meta,
      eventId: "next",
      kind: "set_bowler",
      playerId: "w2"
    });
    expect(next.ok).toBe(true);
  });

  it("tracks run outs without crediting the bowler and retires a batter", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "out-2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "out-3", kind: "set_bowler", playerId: "w1" },
      {
        ...meta,
        eventId: "out-4",
        kind: "record_ball",
        ball: { ...ball(0), wicket: { kind: "runout", batterOutId: "b2" } }
      }
    ]);
    expect(state.innings[0].wickets).toBe(1);
    expect(state.innings[0].bowlers.w1.wickets).toBe(0);
    expect(state.awaiting).toBe("NEW_BATTER");
  });

  it("requires a new batter after a wicket and rejects balls while awaiting", () => {
    const { state } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "id2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "id3", kind: "set_bowler", playerId: "w1" },
      {
        ...meta,
        eventId: "id4",
        kind: "record_ball",
        ball: { ...ball(0), wicket: { kind: "bowled", batterOutId: "b1" } }
      }
    ]);
    expect(state.awaiting).toBe("NEW_BATTER");
    const result = validate(state, {
      ...meta,
      eventId: "id5",
      kind: "record_ball",
      ball: ball(0)
    });
    expect(result.ok).toBe(false);
  });

  it("undoes the most recent scoring event and recomputes state", () => {
    const { events } = eventsFor([
      { ...meta, kind: "set_batter", playerId: "b1", role: "striker" },
      {
        ...meta,
        eventId: "id2",
        kind: "set_batter",
        playerId: "b2",
        role: "non_striker"
      },
      { ...meta, eventId: "id3", kind: "set_bowler", playerId: "w1" },
      { ...meta, eventId: "id4", kind: "record_ball", ball: ball(4) }
    ]);
    const undo: EventEnvelope = {
      ...meta,
      eventId: "undo",
      seq: 5,
      type: "UNDO",
      payload: { targetSeq: 4 },
      schemaVersion: 1
    };
    const state = replay([...events, undo], config);
    expect(state.innings[0].runs).toBe(0);
    expect(state.innings[0].legalBalls).toBe(0);
  });
});
