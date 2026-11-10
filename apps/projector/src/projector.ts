import type { EventEnvelope } from "@voicescore/schemas";
import type {
  EventBus,
  Message
} from "../../../packages/eventbus/src/index.js";

export type Scoreboard = {
  seq: number;
  state: unknown;
};

export class Projector {
  private readonly scoreboards = new Map<string, Scoreboard>();

  public constructor(private readonly bus: EventBus) {}

  async start(): Promise<void> {
    await this.bus.subscribe("match.events", "projector", async (message) => {
      this.consume(message);
    });
  }

  consume(message: Message): void {
    const event = message.value as EventEnvelope;
    const current = this.scoreboards.get(event.matchId);
    if (current && event.seq <= current.seq) return;
    this.scoreboards.set(event.matchId, {
      seq: event.seq,
      state: event.payload
    });
  }

  get(matchId: string): Scoreboard | undefined {
    return this.scoreboards.get(matchId);
  }
}
