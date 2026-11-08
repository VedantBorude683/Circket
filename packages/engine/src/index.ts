import type {
  BallPayload,
  Command,
  EventEnvelope,
  MatchConfig,
  MatchRules
} from "@voicescore/schemas";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type Awaiting = null | "NEW_BATTER" | "NEW_BOWLER";
export type RuleViolation = { code: string; reason: string };
export type PlayerState = {
  id: string;
  name: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  out: boolean;
  retired: boolean;
};
export type BowlerState = {
  id: string;
  name: string;
  legalBalls: number;
  runsConceded: number;
  wickets: number;
};
export type InningsState = {
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  strikerId: string | null;
  nonStrikerId: string | null;
  currentBowlerId: string | null;
  batters: Record<string, PlayerState>;
  bowlers: Record<string, BowlerState>;
  freeHit: boolean;
  target: number | null;
  completed: boolean;
};
export type MatchResult =
  | { kind: "runs"; winner: string; margin: number }
  | { kind: "wickets"; winner: string; margin: number }
  | { kind: "tie" };
export type MatchState = {
  matchId: string;
  rules: MatchRules;
  status: "configured" | "live" | "completed";
  innings: InningsState[];
  currentInnings: number;
  awaiting: Awaiting;
  result: MatchResult | null;
  lastSeq: number;
  voidedSeqs: number[];
  history: EventEnvelope[];
};

type ConfigPayload = MatchConfig;
type SetBatterPayload = { playerId: string; role: "striker" | "non_striker" };
type SetBowlerPayload = { playerId: string };

const violation = (
  code: string,
  reason: string
): Result<never, RuleViolation> => ({
  ok: false,
  error: { code, reason }
});

export function initialState(config: MatchConfig): MatchState {
  const batters: Record<string, PlayerState> = {};
  const bowlers: Record<string, BowlerState> = {};
  for (const player of config.batters) {
    batters[player.id] = {
      ...player,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      out: false,
      retired: false
    };
  }
  for (const player of config.bowlers) {
    bowlers[player.id] = {
      ...player,
      legalBalls: 0,
      runsConceded: 0,
      wickets: 0
    };
  }
  return {
    matchId: config.matchId,
    rules: config.rules,
    status: "configured",
    innings: [
      {
        battingTeamId: config.battingTeamId,
        bowlingTeamId: config.bowlingTeamId,
        runs: 0,
        wickets: 0,
        legalBalls: 0,
        strikerId: null,
        nonStrikerId: null,
        currentBowlerId: null,
        batters,
        bowlers,
        freeHit: false,
        target: null,
        completed: false
      }
    ],
    currentInnings: 0,
    awaiting: "NEW_BATTER",
    result: null,
    lastSeq: 0,
    voidedSeqs: [],
    history: []
  };
}

function current(state: MatchState): InningsState {
  return state.innings[state.currentInnings];
}

function event<T>(
  command: Command,
  seq: number,
  type: EventEnvelope["type"],
  payload: T
): EventEnvelope<T> {
  return {
    eventId: command.eventId,
    matchId: command.matchId,
    seq,
    type,
    schemaVersion: 1,
    ts: command.ts,
    clientEventId: command.clientEventId,
    actor: command.actor,
    payload
  };
}

function validateBall(
  state: MatchState,
  command: Extract<Command, { kind: "record_ball" }>
): Result<EventEnvelope[], RuleViolation> {
  const innings = current(state);
  if (state.awaiting !== null)
    return violation(
      "AWAITING",
      `Cannot record a ball while awaiting ${state.awaiting}`
    );
  if (
    innings.strikerId === null ||
    innings.nonStrikerId === null ||
    innings.currentBowlerId === null
  ) {
    return violation(
      "INCOMPLETE_SETUP",
      "Both batters and a bowler must be set"
    );
  }
  if (
    command.ball.extra?.type === "wide" &&
    command.ball.wicket?.kind === "stumped"
  ) {
    return violation(
      "INVALID_WICKET",
      "A stumped wicket cannot be recorded on a wide in this prototype"
    );
  }
  if (
    command.ball.wicket &&
    ![innings.strikerId, innings.nonStrikerId].includes(
      command.ball.wicket.batterOutId
    )
  ) {
    return violation(
      "UNKNOWN_BATTER",
      "The dismissed batter is not currently batting"
    );
  }
  return {
    ok: true,
    value: [
      event(command, state.lastSeq + 1, "BALL", {
        ...command.ball,
        source: command.source ?? "button",
        transcript: command.transcript
      })
    ]
  };
}

export function validate(
  state: MatchState,
  command: Command
): Result<EventEnvelope[], RuleViolation> {
  if (command.matchId !== state.matchId)
    return violation("MATCH_MISMATCH", "Command match does not match state");
  if (command.kind === "record_ball") return validateBall(state, command);
  if (command.kind === "undo_last") {
    const voided = new Set(state.voidedSeqs);
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      const candidate = state.history[index];
      if (
        !voided.has(candidate.seq) &&
        ["BALL", "BOWLER_SET", "BATTER_SET"].includes(candidate.type)
      ) {
        return {
          ok: true,
          value: [
            event(command, state.lastSeq + 1, "UNDO", {
              targetSeq: candidate.seq
            })
          ]
        };
      }
    }
    return violation(
      "NOTHING_TO_UNDO",
      "There is no non-voided scoring event to undo"
    );
  }
  const innings = current(state);
  if (command.kind === "set_bowler") {
    if (state.awaiting !== "NEW_BOWLER" && innings.currentBowlerId !== null) {
      return violation(
        "BOWLER_NOT_EXPECTED",
        "A bowler can only be changed at the start of an over"
      );
    }
    if (!innings.bowlers[command.playerId])
      return violation("UNKNOWN_BOWLER", "Bowler is not in the match");
    if (innings.currentBowlerId === command.playerId)
      return violation(
        "CONSECUTIVE_BOWLER",
        "The same bowler cannot bowl consecutive overs"
      );
    const bowler = innings.bowlers[command.playerId];
    if (
      state.rules.maxOversPerBowler !== undefined &&
      bowler.legalBalls >= state.rules.maxOversPerBowler * 6
    ) {
      return violation("BOWLER_LIMIT", "Bowler has reached the over limit");
    }
    return {
      ok: true,
      value: [
        event(command, state.lastSeq + 1, "BOWLER_SET", {
          playerId: command.playerId
        })
      ]
    };
  }
  if (!innings.batters[command.playerId])
    return violation("UNKNOWN_BATTER", "Batter is not in the match");
  const player = innings.batters[command.playerId];
  if (player.out || player.retired)
    return violation(
      "BATTER_UNAVAILABLE",
      "Batter is already dismissed or retired"
    );
  const currentRolePlayer =
    command.role === "striker" ? innings.strikerId : innings.nonStrikerId;
  const replacingDismissed =
    currentRolePlayer !== null &&
    (innings.batters[currentRolePlayer]?.out === true ||
      innings.batters[currentRolePlayer]?.retired === true);
  if (
    command.role === "striker" &&
    innings.strikerId !== null &&
    state.awaiting === null &&
    !replacingDismissed
  ) {
    return violation("BATTER_ALREADY_SET", "The striker is already set");
  }
  if (
    command.role === "non_striker" &&
    innings.nonStrikerId !== null &&
    state.awaiting === null &&
    !replacingDismissed
  ) {
    return violation("BATTER_ALREADY_SET", "The non-striker is already set");
  }
  return {
    ok: true,
    value: [
      event(command, state.lastSeq + 1, "BATTER_SET", {
        playerId: command.playerId,
        role: command.role
      })
    ]
  };
}

function copyState(state: MatchState): MatchState {
  return structuredClone(state) as MatchState;
}

function rotateStrike(innings: InningsState): void {
  const striker = innings.strikerId;
  innings.strikerId = innings.nonStrikerId;
  innings.nonStrikerId = striker;
}

function applyBall(state: MatchState, payload: BallPayload): void {
  const innings = current(state);
  const striker =
    innings.strikerId === null ? undefined : innings.batters[innings.strikerId];
  const bowler =
    innings.currentBowlerId === null
      ? undefined
      : innings.bowlers[innings.currentBowlerId];
  if (!striker || !bowler) return;
  const extraRuns = payload.extra?.runs ?? 0;
  const totalRuns = payload.runsOffBat + extraRuns;
  const illegal =
    payload.extra?.type === "wide" || payload.extra?.type === "noball";
  innings.runs += totalRuns;
  if (payload.extra?.type !== "wide" && payload.extra?.type !== "noball") {
    striker.runs += payload.runsOffBat;
    striker.balls += 1;
    if (payload.isBoundary && payload.runsOffBat === 4) striker.fours += 1;
    if (payload.isBoundary && payload.runsOffBat === 6) striker.sixes += 1;
  }
  bowler.runsConceded +=
    totalRuns -
    (payload.extra?.type === "bye" || payload.extra?.type === "legbye"
      ? extraRuns
      : 0);
  if (!illegal) {
    innings.legalBalls += 1;
    bowler.legalBalls += 1;
  }
  if (payload.extra?.type === "noball" && state.rules.freeHitOnNoBall)
    innings.freeHit = true;
  else if (!illegal) innings.freeHit = false;
  const rotationRuns =
    payload.extra?.type === "wide"
      ? Math.max(0, totalRuns - state.rules.wideRuns)
      : payload.extra?.type === "noball"
        ? Math.max(0, totalRuns - state.rules.noballRuns)
        : totalRuns;
  if (rotationRuns % 2 === 1) rotateStrike(innings);
  if (payload.wicket) {
    const dismissed = innings.batters[payload.wicket.batterOutId];
    if (dismissed) {
      dismissed.out = payload.wicket.kind !== "retired";
      dismissed.retired = payload.wicket.kind === "retired";
      if (payload.wicket.kind !== "retired") {
        innings.wickets += 1;
        bowler.wickets += [
          "bowled",
          "caught",
          "lbw",
          "stumped",
          "hitwicket"
        ].includes(payload.wicket.kind)
          ? 1
          : 0;
      }
    }
    if (
      innings.wickets >= state.rules.playersPerSide - 1 &&
      !state.rules.lastManStands
    )
      innings.completed = true;
    else state.awaiting = "NEW_BATTER";
  }
  if (!illegal && innings.legalBalls % state.rules.ballsPerOver === 0) {
    rotateStrike(innings);
    innings.completed =
      innings.legalBalls >= state.rules.overs * state.rules.ballsPerOver;
    if (!innings.completed) state.awaiting = "NEW_BOWLER";
  }
  if (innings.target !== null && innings.runs >= innings.target) {
    innings.completed = true;
    state.status = "completed";
    state.result = {
      kind: "wickets",
      winner: innings.battingTeamId,
      margin: state.rules.playersPerSide - 1 - innings.wickets
    };
  }
  if (innings.completed && state.status !== "completed")
    state.status = "completed";
}

export function apply(state: MatchState, input: EventEnvelope): MatchState {
  const next = copyState(state);
  next.lastSeq = input.seq;
  next.history.push(input);
  if (input.type === "UNDO") {
    next.voidedSeqs.push((input.payload as { targetSeq: number }).targetSeq);
    return next;
  }
  if (input.type === "MATCH_CONFIGURED") {
    const configured = initialState(input.payload as ConfigPayload);
    configured.lastSeq = input.seq;
    configured.history = [input];
    return configured;
  }
  if (input.type === "BATTER_SET") {
    const payload = input.payload as SetBatterPayload;
    const innings = current(next);
    if (payload.role === "striker") innings.strikerId = payload.playerId;
    else innings.nonStrikerId = payload.playerId;
    next.awaiting =
      innings.strikerId === null || innings.nonStrikerId === null
        ? "NEW_BATTER"
        : innings.legalBalls > 0 &&
            innings.legalBalls % next.rules.ballsPerOver === 0
          ? "NEW_BOWLER"
          : null;
    next.status = "live";
  } else if (input.type === "BOWLER_SET") {
    current(next).currentBowlerId = (
      input.payload as SetBowlerPayload
    ).playerId;
    next.awaiting = null;
  } else if (input.type === "BALL") {
    applyBall(next, input.payload as BallPayload);
  }
  return next;
}

export function replay(
  events: EventEnvelope[],
  config?: MatchConfig
): MatchState {
  const configuration =
    (events.find((item) => item.type === "MATCH_CONFIGURED")?.payload as
      MatchConfig | undefined) ?? config;
  if (!configuration)
    throw new Error("Replay requires a MATCH_CONFIGURED event or config");
  const voided = new Set<number>();
  for (const input of events) {
    if (input.type === "UNDO") {
      const target = (input.payload as { targetSeq: number }).targetSeq;
      if (!voided.has(target)) voided.add(target);
    }
  }
  let state = initialState(configuration);
  for (const input of events) {
    if (
      input.type === "MATCH_CONFIGURED" ||
      input.type === "UNDO" ||
      !voided.has(input.seq)
    ) {
      state = apply(state, input);
    }
  }
  state.voidedSeqs = [...voided].sort((a, b) => a - b);
  return state;
}
