import { apply, initialState, validate } from "@voicescore/engine";
import type { Command, EventEnvelope, MatchConfig } from "@voicescore/schemas";

export type ReplayExpectation = {
  runs: number;
  wickets: number;
  legalBalls: number;
};
export type ReplayConversion = {
  events: EventEnvelope[];
  config: MatchConfig;
  expected: ReplayExpectation;
};
export type SkipRecord = { match: string; reason: string };

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

function commandEvent(
  state: ReturnType<typeof initialState>,
  command: Command
): { state: ReturnType<typeof initialState>; events: EventEnvelope[] } {
  const result = validate(state, command);
  if (!result.ok) throw new Error(result.error.reason);
  let next = state;
  for (const event of result.value) next = apply(next, event);
  return { state: next, events: result.value };
}

export function convertCricsheetMatch(
  matchId: string,
  input: unknown
): ReplayConversion | SkipRecord {
  const root = record(input);
  const info = record(root?.info);
  const innings = arrayValue(root?.innings);
  if (!info || innings.length === 0)
    return { match: matchId, reason: "missing info or innings" };
  const firstInnings = record(innings[0]);
  const team = stringValue(firstInnings?.team);
  const teams = arrayValue(info.teams)
    .map(stringValue)
    .filter((value): value is string => value !== undefined);
  if (!team || teams.length < 2)
    return { match: matchId, reason: "missing two teams" };
  const bowlingTeam = teams.find((value) => value !== team);
  const players = record(info.players);
  const battingNames = arrayValue(players?.[team])
    .map(stringValue)
    .filter((value): value is string => value !== undefined);
  const bowlingNames = arrayValue(players?.[bowlingTeam ?? ""])
    .map(stringValue)
    .filter((value): value is string => value !== undefined);
  if (battingNames.length < 2 || bowlingNames.length < 1)
    return { match: matchId, reason: "missing player lists" };
  const config: MatchConfig = {
    matchId,
    battingTeamId: team,
    bowlingTeamId: bowlingTeam ?? "unknown",
    batters: battingNames.map((name) => ({ id: name, name })),
    bowlers: bowlingNames.map((name) => ({ id: name, name })),
    rules: {
      overs: numberValue(info.overs) ?? 20,
      playersPerSide: battingNames.length,
      ballsPerOver: 6,
      wideRuns: 1,
      noballRuns: 1,
      freeHitOnNoBall: true,
      lastManStands: false
    }
  };
  let state = initialState(config);
  const events: EventEnvelope[] = [
    {
      eventId: `${matchId}-config`,
      matchId,
      seq: 1,
      type: "MATCH_CONFIGURED",
      schemaVersion: 1,
      ts: "2026-01-01T00:00:00.000Z",
      actor: { userId: "cricsheet", role: "system" },
      payload: config
    }
  ];
  state = apply(state, events[0]);
  let nextSeq = 2;
  let expectedRuns = 0;
  let expectedWickets = 0;
  let expectedLegalBalls = 0;
  for (const overValue of arrayValue(firstInnings?.overs)) {
    const over = record(overValue);
    let deliveryIndex = 0;
    for (const deliveryValue of arrayValue(over?.deliveries)) {
      const delivery = record(deliveryValue);
      const runs = record(delivery?.runs);
      const batter = stringValue(delivery?.batter);
      const nonStriker = stringValue(delivery?.non_striker);
      const bowler = stringValue(delivery?.bowler);
      if (!runs || !batter || !nonStriker || !bowler)
        return {
          match: matchId,
          reason: "delivery missing batter, non-striker, bowler, or runs"
        };
      const extras = record(delivery?.extras);
      const extraKeys = extras ? Object.keys(extras) : [];
      if (
        extraKeys.some((key) => key === "penalty" || key === "penalty_runs")
      ) {
        return { match: matchId, reason: "unsupported penalty runs" };
      }
      if (extraKeys.length > 1)
        return { match: matchId, reason: "multiple simultaneous extra types" };
      const extraType = extraKeys[0];
      const extra =
        extraType === "wides"
          ? {
              type: "wide" as const,
              runs: numberValue(extras?.[extraType]) ?? 0
            }
          : extraType === "noballs"
            ? {
                type: "noball" as const,
                runs: numberValue(extras?.[extraType]) ?? 0
              }
            : extraType === "byes"
              ? {
                  type: "bye" as const,
                  runs: numberValue(extras?.[extraType]) ?? 0
                }
              : extraType === "legbyes"
                ? {
                    type: "legbye" as const,
                    runs: numberValue(extras?.[extraType]) ?? 0
                  }
                : undefined;
      const wickets = arrayValue(delivery?.wickets);
      if (wickets.length > 1)
        return { match: matchId, reason: "multiple wickets on one delivery" };
      const wicketValue = record(wickets[0]);
      const wicketKind = stringValue(wicketValue?.kind);
      if (
        wicketKind &&
        ![
          "bowled",
          "caught",
          "caught and bowled",
          "lbw",
          "run out",
          "stumped",
          "hit wicket",
          "retired hurt"
        ].includes(wicketKind)
      ) {
        return {
          match: matchId,
          reason: `unsupported wicket kind: ${wicketKind}`
        };
      }
      if (wicketKind === "retired hurt")
        return {
          match: matchId,
          reason: "unsupported wicket kind: retired hurt"
        };
      const wicket = wicketKind
        ? {
            kind: (wicketKind === "run out"
              ? "runout"
              : wicketKind === "hit wicket"
                ? "hitwicket"
                : wicketKind === "caught and bowled"
                  ? "caught"
                  : wicketKind) as
              "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket",
            batterOutId: stringValue(wicketValue?.player_out) ?? batter,
            fielderId: stringValue(arrayValue(wicketValue?.fielders)[0])
          }
        : undefined;
      const setup: Command[] = [];
      const strikerCommand: Command = {
        matchId,
        eventId: `${matchId}-${nextSeq}`,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { userId: "cricsheet", role: "system" },
        kind: "set_batter",
        playerId: batter,
        role: "striker"
      };
      const nonStrikerCommand: Command = {
        matchId,
        eventId: `${matchId}-${nextSeq + 1}`,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { userId: "cricsheet", role: "system" },
        kind: "set_batter",
        playerId: nonStriker,
        role: "non_striker"
      };
      if (
        state.innings[0].nonStrikerId !== nonStriker &&
        state.innings[0].strikerId === nonStriker
      )
        setup.push(strikerCommand);
      if (
        state.innings[0].strikerId !== batter &&
        state.innings[0].nonStrikerId === batter
      )
        setup.push(nonStrikerCommand);
      if (
        state.innings[0].strikerId !== batter &&
        !setup.includes(strikerCommand)
      )
        setup.push(strikerCommand);
      if (
        state.innings[0].nonStrikerId !== nonStriker &&
        !setup.includes(nonStrikerCommand)
      )
        setup.push(nonStrikerCommand);
      if (state.innings[0].currentBowlerId !== bowler)
        setup.push({
          matchId,
          eventId: `${matchId}-${nextSeq + setup.length}`,
          ts: "2026-01-01T00:00:00.000Z",
          actor: { userId: "cricsheet", role: "system" },
          kind: "set_bowler",
          playerId: bowler
        });
      for (const command of setup) {
        let applied: {
          state: ReturnType<typeof initialState>;
          events: EventEnvelope[];
        };
        try {
          applied = commandEvent(state, command);
        } catch (error) {
          return {
            match: matchId,
            reason: `unsupported batter/bowler transition at ${String(over?.over)}.${deliveryIndex}: ${command.kind} ${"playerId" in command ? command.playerId : ""} current=${state.innings[0].strikerId}/${state.innings[0].nonStrikerId} awaiting=${state.awaiting} prior=${JSON.stringify(state.history.at(-1)?.payload)}: ${error instanceof Error ? error.message : "unknown error"}`
          };
        }
        state = applied.state;
        events.push(
          ...applied.events.map((item) => ({ ...item, seq: nextSeq++ }))
        );
      }
      const ball: Command = {
        matchId,
        eventId: `${matchId}-${nextSeq}`,
        ts: "2026-01-01T00:00:00.000Z",
        actor: { userId: "cricsheet", role: "system" },
        kind: "record_ball",
        ball: {
          runsOffBat: numberValue(runs.batter) ?? 0,
          isBoundary:
            !Boolean(runs.non_boundary) &&
            [4, 6].includes(numberValue(runs.batter) ?? 0),
          extra,
          wicket
        }
      };
      let applied: {
        state: ReturnType<typeof initialState>;
        events: EventEnvelope[];
      };
      try {
        applied = commandEvent(state, ball);
      } catch (error) {
        return {
          match: matchId,
          reason: `unsupported delivery: ${error instanceof Error ? error.message : "unknown error"}`
        };
      }
      state = applied.state;
      events.push(
        ...applied.events.map((item) => ({ ...item, seq: nextSeq++ }))
      );
      expectedRuns += numberValue(runs.total) ?? 0;
      expectedWickets += wicket ? 1 : 0;
      expectedLegalBalls +=
        extra?.type === "wide" || extra?.type === "noball" ? 0 : 1;
      deliveryIndex += 1;
    }
  }
  return {
    config,
    events,
    expected: {
      runs: expectedRuns,
      wickets: expectedWickets,
      legalBalls: expectedLegalBalls
    }
  };
}
