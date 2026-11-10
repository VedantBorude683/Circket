import type { EventBus } from "../../../packages/eventbus/src/index.js";
import type { EventStore } from "../../scoring-api/src/store.js";

export class OutboxRelay {
  private readonly published = new Set<string>();

  public constructor(
    private readonly store: EventStore,
    private readonly bus: EventBus
  ) {}

  async publishMatch(matchId: string): Promise<number> {
    let published = 0;
    for (const record of await this.store.getOutbox(matchId)) {
      if (this.published.has(record.eventId)) continue;
      await this.bus.publish(record.topic, record.key, record.payload, {
        schemaVersion: String(record.payload.schemaVersion)
      });
      this.published.add(record.eventId);
      published += 1;
    }
    return published;
  }
}
