import { describe, expect, it } from "vitest";
import {
  MemoryVoiceLogSink,
  Parser,
  ParserCircuitOpenError,
  fastParse,
  normalizeTranscript
} from "../apps/parser/src/parser.js";

describe("M5 parser", () => {
  it("normalizes Hinglish and parses fast-path scoring phrases", () => {
    expect(normalizeTranscript("Please  CHAUKA ")).toBe("chauka");
    expect(fastParse("chauka")).toEqual({
      kind: "record_ball",
      ball: { runsOffBat: 4 }
    });
    expect(fastParse("wide")).toEqual({
      kind: "record_ball",
      ball: { runsOffBat: 0, extra: { type: "wide", runs: 1 } }
    });
  });

  it("uses the validated LLM adapter only after fast path misses", async () => {
    const logs = new MemoryVoiceLogSink();
    const parser = new Parser(
      async () => ({ kind: "record_ball", ball: { runsOffBat: 2 } }),
      logs
    );
    await expect(parser.parse("drive to cover", {})).resolves.toEqual({
      kind: "record_ball",
      ball: { runsOffBat: 2 }
    });
    expect(logs.logs[0]?.path).toBe("llm");
  });

  it("opens the circuit after five failed LLM calls", async () => {
    const parser = new Parser(async () => {
      throw new Error("provider down");
    });
    for (let count = 0; count < 5; count += 1) {
      await expect(parser.parse(`unknown-${count}`, {})).rejects.toThrow(
        "provider down"
      );
    }
    await expect(parser.parse("unknown-six", {})).rejects.toBeInstanceOf(
      ParserCircuitOpenError
    );
  });
});
