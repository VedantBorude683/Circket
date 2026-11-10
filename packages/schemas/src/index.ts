import { z } from "zod";

export const eventTypeSchema = z.enum([
  "MATCH_CONFIGURED",
  "TOSS",
  "INNINGS_STARTED",
  "BATTER_SET",
  "BOWLER_SET",
  "BALL",
  "UNDO",
  "INNINGS_ENDED",
  "MATCH_COMPLETED"
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const matchRulesSchema = z.object({
  overs: z.number().int().positive(),
  playersPerSide: z.number().int().min(2),
  ballsPerOver: z.literal(6),
  wideRuns: z.number().int().nonnegative(),
  noballRuns: z.number().int().nonnegative(),
  freeHitOnNoBall: z.boolean(),
  lastManStands: z.boolean(),
  maxOversPerBowler: z.number().int().positive().optional()
});
export type MatchRules = z.infer<typeof matchRulesSchema>;

export const matchConfigSchema = z.object({
  matchId: z.string().min(1),
  battingTeamId: z.string().min(1),
  bowlingTeamId: z.string().min(1),
  batters: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .min(2),
  bowlers: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .min(1),
  rules: matchRulesSchema
});
export type MatchConfig = z.infer<typeof matchConfigSchema>;

const wicketSchema = z.object({
  kind: z.enum([
    "bowled",
    "caught",
    "lbw",
    "runout",
    "stumped",
    "hitwicket",
    "retired"
  ]),
  batterOutId: z.string().min(1),
  fielderId: z.string().min(1).optional()
});
export type Wicket = z.infer<typeof wicketSchema>;

export const ballPayloadSchema = z.object({
  runsOffBat: z.number().int().min(0).max(6),
  isBoundary: z.boolean().optional(),
  extra: z
    .object({
      type: z.enum(["wide", "noball", "bye", "legbye"]),
      runs: z.number().int().nonnegative()
    })
    .optional(),
  wicket: wicketSchema.optional(),
  shot: z.string().optional(),
  source: z.enum(["voice", "button"]),
  transcript: z.string().optional()
});
export type BallPayload = z.infer<typeof ballPayloadSchema>;

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  matchId: z.string().min(1),
  seq: z.number().int().positive(),
  type: eventTypeSchema,
  schemaVersion: z.literal(1),
  ts: z.string().datetime({ offset: true }),
  clientEventId: z.string().min(1).optional(),
  actor: z.object({
    userId: z.string().min(1),
    role: z.enum(["scorer", "system"])
  }),
  payload: z.unknown()
});
export type EventEnvelope<T = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  "payload"
> & { payload: T };

export const commandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("record_ball"),
    ball: ballPayloadSchema.omit({ source: true, transcript: true })
  }),
  z.object({ kind: z.literal("undo_last") }),
  z.object({ kind: z.literal("set_bowler"), playerId: z.string().min(1) }),
  z.object({
    kind: z.literal("set_batter"),
    playerId: z.string().min(1),
    role: z.enum(["striker", "non_striker"])
  })
]);

export const eventPayloadSchemas = {
  MATCH_CONFIGURED: matchConfigSchema,
  BATTER_SET: z.object({
    playerId: z.string().min(1),
    role: z.enum(["striker", "non_striker"])
  }),
  BOWLER_SET: z.object({ playerId: z.string().min(1) }),
  BALL: ballPayloadSchema,
  UNDO: z.object({ targetSeq: z.number().int().positive() })
};

export type Command = (
  | { kind: "record_ball"; ball: Omit<BallPayload, "source" | "transcript"> }
  | { kind: "undo_last" }
  | { kind: "set_bowler"; playerId: string }
  | { kind: "set_batter"; playerId: string; role: "striker" | "non_striker" }
) & {
  matchId: string;
  eventId: string;
  ts: string;
  actor: { userId: string; role: "scorer" | "system" };
  source?: "voice" | "button";
  transcript?: string;
  clientEventId?: string;
};

export const commandRequestSchema = z.object({
  clientEventId: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  source: z.enum(["voice", "button"]),
  transcript: z.string().max(16_384).optional(),
  command: commandSchema.optional()
});
export type CommandRequest = z.infer<typeof commandRequestSchema>;
