import { MongoClient, type Db } from "mongodb";
import type { EventEnvelope, MatchConfig } from "@voicescore/schemas";
import { replay, type MatchState } from "@voicescore/engine";

export type StoredCommand = { events: EventEnvelope[]; state: MatchState };
export type OutboxRecord = {
  eventId: string;
  topic: string;
  key: string;
  payload: EventEnvelope;
  publishedAt?: string;
};
export type MatchRecord = {
  config: MatchConfig;
  scorerEpoch: number;
  ownerId: string;
};
type MatchDocument = MatchRecord & { _id: string };
type IdempotencyDocument = {
  matchId: string;
  clientEventId: string;
  result: StoredCommand;
};

export interface EventStore {
  createMatch(config: MatchConfig, ownerId: string): Promise<void>;
  getMatch(matchId: string): Promise<MatchRecord | undefined>;
  claimScorer(matchId: string, userId: string): Promise<number>;
  getEvents(matchId: string): Promise<EventEnvelope[]>;
  getIdempotentResult(
    matchId: string,
    clientEventId: string
  ): Promise<StoredCommand | undefined>;
  append(
    matchId: string,
    expectedLastSeq: number,
    epoch: number,
    events: EventEnvelope[],
    result: StoredCommand
  ): Promise<void>;
  getOutbox(matchId: string): Promise<OutboxRecord[]>;
}

export class InMemoryEventStore implements EventStore {
  private readonly matches = new Map<string, MatchRecord>();
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly idempotency = new Map<string, StoredCommand>();
  private readonly outbox = new Map<string, OutboxRecord[]>();
  private readonly locks = new Map<string, Promise<void>>();

  async createMatch(config: MatchConfig, ownerId: string): Promise<void> {
    if (this.matches.has(config.matchId)) throw new Error("MATCH_EXISTS");
    const configured: EventEnvelope = {
      eventId: `${config.matchId}-configured`,
      matchId: config.matchId,
      seq: 1,
      type: "MATCH_CONFIGURED",
      schemaVersion: 1,
      ts: new Date().toISOString(),
      actor: { userId: ownerId, role: "scorer" },
      payload: config
    };
    this.matches.set(config.matchId, { config, ownerId, scorerEpoch: 0 });
    this.events.set(config.matchId, [configured]);
    this.outbox.set(config.matchId, [
      {
        eventId: configured.eventId,
        topic: "match.events",
        key: config.matchId,
        payload: configured
      }
    ]);
  }

  async getMatch(matchId: string): Promise<MatchRecord | undefined> {
    const value = this.matches.get(matchId);
    return value ? { ...value } : undefined;
  }

  async claimScorer(matchId: string, userId: string): Promise<number> {
    const match = this.matches.get(matchId);
    if (!match) throw new Error("MATCH_NOT_FOUND");
    if (match.ownerId !== userId) throw new Error("FORBIDDEN");
    return match.scorerEpoch;
  }

  async getEvents(matchId: string): Promise<EventEnvelope[]> {
    return [...(this.events.get(matchId) ?? [])];
  }

  async getIdempotentResult(
    matchId: string,
    clientEventId: string
  ): Promise<StoredCommand | undefined> {
    return this.idempotency.get(`${matchId}:${clientEventId}`);
  }

  async append(
    matchId: string,
    expectedLastSeq: number,
    epoch: number,
    events: EventEnvelope[],
    result: StoredCommand
  ): Promise<void> {
    const prior = this.locks.get(matchId) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      matchId,
      prior.then(() => lock)
    );
    await prior;
    try {
      const match = this.matches.get(matchId);
      const stored = this.events.get(matchId) ?? [];
      if (!match) throw new Error("MATCH_NOT_FOUND");
      if (match.scorerEpoch !== epoch) throw new Error("STALE_EPOCH");
      if ((stored.at(-1)?.seq ?? 0) !== expectedLastSeq)
        throw new Error("SEQ_CONFLICT");
      const nextSeq = expectedLastSeq + 1;
      if (events.some((item, index) => item.seq !== nextSeq + index))
        throw new Error("SEQ_CONFLICT");
      stored.push(...events);
      this.events.set(matchId, stored);
      const clientEventId = events[0]?.clientEventId ?? events[0]?.eventId;
      this.idempotency.set(`${matchId}:${clientEventId}`, result);
      const records = this.outbox.get(matchId) ?? [];
      records.push(
        ...events.map((payload) => ({
          eventId: payload.eventId,
          topic: "match.events",
          key: matchId,
          payload
        }))
      );
      this.outbox.set(matchId, records);
    } finally {
      release();
    }
  }

  async getOutbox(matchId: string): Promise<OutboxRecord[]> {
    return [...(this.outbox.get(matchId) ?? [])];
  }
}

export class MongoEventStore implements EventStore {
  public constructor(
    private readonly client: MongoClient,
    private readonly database: Db
  ) {}

  async initialize(): Promise<void> {
    await this.database
      .collection<MatchDocument>("matches")
      .createIndex({ slug: 1 }, { unique: true, sparse: true });
    await this.database
      .collection<EventEnvelope>("events")
      .createIndex({ matchId: 1, seq: 1 }, { unique: true });
    await this.database
      .collection<EventEnvelope>("events")
      .createIndex(
        { matchId: 1, clientEventId: 1 },
        { unique: true, sparse: true }
      );
    await this.database
      .collection<IdempotencyDocument>("idempotency")
      .createIndex({ matchId: 1, clientEventId: 1 }, { unique: true });
    await this.database
      .collection<OutboxRecord>("outbox")
      .createIndex({ eventId: 1 }, { unique: true });
  }

  async createMatch(config: MatchConfig, ownerId: string): Promise<void> {
    const session = this.client.startSession();
    const configured: EventEnvelope = {
      eventId: `${config.matchId}-configured`,
      matchId: config.matchId,
      seq: 1,
      type: "MATCH_CONFIGURED",
      schemaVersion: 1,
      ts: new Date().toISOString(),
      actor: { userId: ownerId, role: "scorer" },
      payload: config
    };
    try {
      await session.withTransaction(async () => {
        await this.database
          .collection<MatchDocument>("matches")
          .insertOne(
            { _id: config.matchId, config, ownerId, scorerEpoch: 0 },
            { session }
          );
        await this.database
          .collection<EventEnvelope>("events")
          .insertOne(configured, { session });
        await this.database.collection<OutboxRecord>("outbox").insertOne(
          {
            eventId: configured.eventId,
            topic: "match.events",
            key: config.matchId,
            payload: configured
          },
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async getMatch(matchId: string): Promise<MatchRecord | undefined> {
    const value = await this.database
      .collection<MatchDocument>("matches")
      .findOne({ _id: matchId });
    return value as unknown as MatchRecord | undefined;
  }

  async claimScorer(matchId: string, userId: string): Promise<number> {
    const value = await this.database
      .collection<MatchDocument>("matches")
      .findOne({ _id: matchId, ownerId: userId });
    if (!value) throw new Error("FORBIDDEN");
    return Number(value.scorerEpoch);
  }

  async getEvents(matchId: string): Promise<EventEnvelope[]> {
    return (await this.database
      .collection<EventEnvelope>("events")
      .find({ matchId })
      .sort({ seq: 1 })
      .toArray()) as unknown as EventEnvelope[];
  }

  async getIdempotentResult(
    matchId: string,
    clientEventId: string
  ): Promise<StoredCommand | undefined> {
    const value = await this.database
      .collection<IdempotencyDocument>("idempotency")
      .findOne({ matchId, clientEventId });
    return value?.result as StoredCommand | undefined;
  }

  async append(
    matchId: string,
    expectedLastSeq: number,
    epoch: number,
    events: EventEnvelope[],
    result: StoredCommand
  ): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const match = await this.database
          .collection<MatchDocument>("matches")
          .findOne({ _id: matchId, scorerEpoch: epoch }, { session });
        const last = await this.database
          .collection<EventEnvelope>("events")
          .find({ matchId }, { session })
          .sort({ seq: -1 })
          .limit(1)
          .next();
        if (!match || Number(last?.seq ?? 0) !== expectedLastSeq)
          throw new Error("SEQ_CONFLICT");
        const clientEventId = events[0]?.clientEventId;
        if (!clientEventId) throw new Error("IDEMPOTENCY_REQUIRED");
        await this.database
          .collection<EventEnvelope>("events")
          .insertMany(events, { session });
        await this.database
          .collection<IdempotencyDocument>("idempotency")
          .insertOne({ matchId, clientEventId, result }, { session });
        await this.database.collection<OutboxRecord>("outbox").insertMany(
          events.map((payload) => ({
            eventId: payload.eventId,
            topic: "match.events",
            key: matchId,
            payload
          })),
          { session }
        );
      });
    } finally {
      await session.endSession();
    }
  }

  async getOutbox(matchId: string): Promise<OutboxRecord[]> {
    return (await this.database
      .collection<OutboxRecord>("outbox")
      .find({ key: matchId })
      .sort({ _id: 1 })
      .toArray()) as unknown as OutboxRecord[];
  }
}

export function stateFromEvents(events: EventEnvelope[]): MatchState {
  return replay(events);
}
