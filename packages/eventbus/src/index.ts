export type Message = {
  topic: string;
  key: string;
  value: unknown;
  headers: Record<string, string>;
};

export interface EventBus {
  publish(
    topic: string,
    key: string,
    value: unknown,
    headers?: Record<string, string>
  ): Promise<void>;
  subscribe(
    topic: string,
    group: string,
    handler: (message: Message) => Promise<void>
  ): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  private readonly messages: Message[] = [];
  private readonly handlers = new Map<
    string,
    Set<(message: Message) => Promise<void>>
  >();

  async publish(
    topic: string,
    key: string,
    value: unknown,
    headers: Record<string, string> = {}
  ): Promise<void> {
    const message = { topic, key, value, headers };
    this.messages.push(message);
    const consumers = this.handlers.get(topic) ?? new Set();
    for (const handler of consumers) await handler(message);
  }

  async subscribe(
    topic: string,
    _group: string,
    handler: (message: Message) => Promise<void>
  ): Promise<void> {
    const consumers = this.handlers.get(topic) ?? new Set();
    consumers.add(handler);
    this.handlers.set(topic, consumers);
  }

  get published(): readonly Message[] {
    return this.messages;
  }
}
