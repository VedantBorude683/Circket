import { Kafka, type Consumer, type Producer } from "kafkajs";

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
    for (const handler of this.handlers.get(topic) ?? new Set()) {
      await handler(message);
    }
  }

  async subscribe(
    topic: string,
    _group: string,
    handler: (message: Message) => Promise<void>
  ): Promise<void> {
    const handlers = this.handlers.get(topic) ?? new Set();
    handlers.add(handler);
    this.handlers.set(topic, handlers);
  }

  get published(): readonly Message[] {
    return this.messages;
  }
}

export class KafkaEventBus implements EventBus {
  private readonly producer: Producer;
  private readonly consumer: Consumer;

  public constructor(brokers: string[], clientId: string, groupId: string) {
    const kafka = new Kafka({ clientId, brokers });
    this.producer = kafka.producer({ idempotent: true });
    this.consumer = kafka.consumer({ groupId });
  }

  async publish(
    topic: string,
    key: string,
    value: unknown,
    headers: Record<string, string> = {}
  ): Promise<void> {
    await this.producer.connect();
    await this.producer.send({
      topic,
      acks: -1,
      messages: [{ key, value: JSON.stringify(value), headers }]
    });
  }

  async subscribe(
    topic: string,
    _group: string,
    handler: (message: Message) => Promise<void>
  ): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (message.value === null) return;
        await handler({
          topic,
          key: message.key?.toString() ?? "",
          value: JSON.parse(message.value.toString()) as unknown,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([key, value]) => [
              key,
              value?.toString() ?? ""
            ])
          )
        });
      }
    });
  }
}
