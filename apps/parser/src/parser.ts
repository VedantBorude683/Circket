import {
  parsedCommandSchema,
  type ParsedCommand,
  type ParserContext
} from "@voicescore/schemas";

export type LlmParser = (
  transcript: string,
  context: ParserContext
) => Promise<unknown>;
export type VoiceLog = {
  transcript: string;
  context: ParserContext;
  parsed: ParsedCommand | null;
  accepted: boolean;
  path: "fast" | "llm";
};
export interface VoiceLogSink {
  write(log: VoiceLog): Promise<void>;
}

export class MemoryVoiceLogSink implements VoiceLogSink {
  public readonly logs: VoiceLog[] = [];

  async write(log: VoiceLog): Promise<void> {
    this.logs.push(log);
  }
}

type QueueItem = {
  transcript: string;
  context: ParserContext;
  resolve: (value: ParsedCommand) => void;
  reject: (reason: Error) => void;
};

export class ParserBusyError extends Error {
  public constructor() {
    super("PARSE_BUSY");
    this.name = "ParserBusyError";
  }
}

export class ParserCircuitOpenError extends Error {
  public constructor() {
    super("PARSE_BUSY");
    this.name = "ParserCircuitOpenError";
  }
}

export class Parser {
  private readonly queue: QueueItem[] = [];
  private active = 0;
  private failures: number[] = [];
  private openedAt: number | undefined;

  public constructor(
    private readonly llm: LlmParser,
    private readonly logs: VoiceLogSink = new MemoryVoiceLogSink(),
    private readonly concurrency = 8,
    private readonly maxQueue = 50
  ) {}

  async parse(
    transcript: string,
    context: ParserContext
  ): Promise<ParsedCommand> {
    const fast = fastParse(transcript);
    if (fast) {
      await this.logs.write({
        transcript,
        context,
        parsed: fast,
        accepted: true,
        path: "fast"
      });
      return fast;
    }
    if (this.openedAt !== undefined && Date.now() - this.openedAt < 15_000) {
      await this.logs.write({
        transcript,
        context,
        parsed: null,
        accepted: false,
        path: "llm"
      });
      throw new ParserCircuitOpenError();
    }
    if (this.queue.length >= this.maxQueue) throw new ParserBusyError();
    return new Promise<ParsedCommand>((resolve, reject) => {
      this.queue.push({ transcript, context, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) return;
      this.active += 1;
      void this.run(item).finally(() => {
        this.active -= 1;
        void this.drain();
      });
    }
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const raw = await withTimeout(
        this.llm(item.transcript, item.context),
        2_500
      );
      const parsed = parsedCommandSchema.parse(raw);
      this.failures = [];
      this.openedAt = undefined;
      await this.logs.write({
        transcript: item.transcript,
        context: item.context,
        parsed,
        accepted: true,
        path: "llm"
      });
      item.resolve(parsed);
    } catch (error) {
      this.recordFailure();
      await this.logs.write({
        transcript: item.transcript,
        context: item.context,
        parsed: null,
        accepted: false,
        path: "llm"
      });
      item.reject(error instanceof Error ? error : new Error("PARSE_FAILED"));
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.failures = this.failures.filter(
      (timestamp) => now - timestamp < 30_000
    );
    this.failures.push(now);
    if (this.failures.length >= 5) this.openedAt = now;
  }
}

export function normalizeTranscript(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(please|can you|runs?|run)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fastParse(transcript: string): ParsedCommand | undefined {
  const value = normalizeTranscript(transcript);
  const numbers: Record<string, number> = {
    "0": 0,
    zero: 0,
    dot: 0,
    ek: 1,
    one: 1,
    do: 2,
    two: 2,
    teen: 3,
    three: 3,
    four: 4,
    chauka: 4,
    five: 5,
    six: 6,
    chakka: 6
  };
  if (value === "undo") return { kind: "undo_last" };
  if (value === "wide")
    return {
      kind: "record_ball",
      ball: { runsOffBat: 0, extra: { type: "wide", runs: 1 } }
    };
  if (value === "no ball" || value === "noball")
    return {
      kind: "record_ball",
      ball: { runsOffBat: 0, extra: { type: "noball", runs: 1 } }
    };
  if (value === "bye")
    return {
      kind: "record_ball",
      ball: { runsOffBat: 0, extra: { type: "bye", runs: 1 } }
    };
  if (value === "leg bye")
    return {
      kind: "record_ball",
      ball: { runsOffBat: 0, extra: { type: "legbye", runs: 1 } }
    };
  if (value === "wicket" || value === "out" || value === "bowled") {
    return {
      kind: "ask_clarification",
      question: "Which batter was dismissed and what was the wicket kind?"
    };
  }
  if (value in numbers) {
    return { kind: "record_ball", ball: { runsOffBat: numbers[value] } };
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PARSE_TIMEOUT")),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("PARSE_FAILED"));
      }
    );
  });
}
