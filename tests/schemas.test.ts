import { describe, expect, it } from "vitest";
import {
  ballPayloadSchema,
  commandSchema,
  matchRulesSchema
} from "../packages/schemas/src/index.js";

describe("M1 boundary schemas", () => {
  it("accepts house rules and rejects non-six-ball overs", () => {
    expect(
      matchRulesSchema.safeParse({
        overs: 20,
        playersPerSide: 11,
        ballsPerOver: 6,
        wideRuns: 1,
        noballRuns: 1,
        freeHitOnNoBall: true,
        lastManStands: false
      }).success
    ).toBe(true);
    expect(
      matchRulesSchema.safeParse({
        overs: 20,
        playersPerSide: 11,
        ballsPerOver: 8,
        wideRuns: 1,
        noballRuns: 1,
        freeHitOnNoBall: true,
        lastManStands: false
      }).success
    ).toBe(false);
  });

  it("validates command and ball payload discriminators", () => {
    expect(commandSchema.safeParse({ kind: "undo_last" }).success).toBe(true);
    expect(
      commandSchema.safeParse({ kind: "record_ball", ball: { runsOffBat: 7 } })
        .success
    ).toBe(false);
    expect(
      ballPayloadSchema.safeParse({
        runsOffBat: 0,
        source: "button",
        extra: { type: "legbye", runs: 1 }
      }).success
    ).toBe(true);
  });
});
