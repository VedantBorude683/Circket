import { commandSchema, type CommandRequest } from "@voicescore/schemas";
import { replay, validate } from "@voicescore/engine";
import type { EventStore, StoredCommand } from "./store.js";

export type ServiceError = Error & { code?: string };

export class ScoringService {
  public constructor(private readonly store: EventStore) {}

  async createMatch(
    config: Parameters<EventStore["createMatch"]>[0],
    ownerId: string
  ): Promise<void> {
    await this.store.createMatch(config, ownerId);
  }

  async claimScorer(matchId: string, userId: string): Promise<number> {
    return this.store.claimScorer(matchId, userId);
  }

  async submit(
    matchId: string,
    request: CommandRequest,
    userId: string
  ): Promise<StoredCommand> {
    const match = await this.store.getMatch(matchId);
    if (!match) throw this.error("MATCH_NOT_FOUND", "Match does not exist");
    if (match.ownerId !== userId)
      throw this.error("FORBIDDEN", "User does not own this match");
    if (request.command === undefined)
      throw this.error(
        "COMMAND_REQUIRED",
        "M2 accepts structured commands only"
      );
    const prior = await this.store.getIdempotentResult(
      matchId,
      request.clientEventId
    );
    if (prior) return prior;
    const events = await this.store.getEvents(matchId);
    const state = replay(events);
    if (match.scorerEpoch !== request.epoch)
      throw this.error("STALE_EPOCH", "Scorer epoch is stale");
    const command = {
      ...request.command,
      matchId,
      eventId: request.clientEventId,
      clientEventId: request.clientEventId,
      source: request.source,
      transcript: request.transcript,
      ts: new Date().toISOString(),
      actor: { userId, role: "scorer" as const }
    };
    const parsed = commandSchema.safeParse(request.command);
    if (!parsed.success)
      throw this.error("INVALID_COMMAND", parsed.error.message);
    const result = validate(state, command);
    if (!result.ok) throw this.error(result.error.code, result.error.reason);
    const resultState = replay([...events, ...result.value]);
    const stored: StoredCommand = { events: result.value, state: resultState };
    await this.store.append(
      matchId,
      state.lastSeq,
      request.epoch,
      result.value,
      stored
    );
    return stored;
  }

  private error(code: string, message: string): ServiceError {
    const error = new Error(message) as ServiceError;
    error.code = code;
    return error;
  }
}
