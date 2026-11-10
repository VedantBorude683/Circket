import type { EventEnvelope } from "@voicescore/schemas";

type Room = {
  events: EventEnvelope[];
  clients: Set<(event: EventEnvelope) => void>;
};

export class RealtimeHub {
  private readonly rooms = new Map<string, Room>();

  join(
    matchId: string,
    lastSeq: number | undefined,
    send: (event: EventEnvelope) => void
  ): EventEnvelope[] {
    const room = this.rooms.get(matchId) ?? { events: [], clients: new Set() };
    this.rooms.set(matchId, room);
    room.clients.add(send);
    return room.events.filter(
      (event) => lastSeq === undefined || event.seq > lastSeq
    );
  }

  leave(matchId: string, send: (event: EventEnvelope) => void): void {
    this.rooms.get(matchId)?.clients.delete(send);
  }

  publish(event: EventEnvelope): void {
    const room = this.rooms.get(event.matchId) ?? {
      events: [],
      clients: new Set()
    };
    room.events.push(event);
    if (room.events.length > 200) room.events.shift();
    this.rooms.set(event.matchId, room);
    for (const send of room.clients) send(event);
  }
}
