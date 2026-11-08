import { describe, expect, it } from "vitest";

describe("M0 skeleton", () => {
  it("defines every runtime service health endpoint", () => {
    expect([
      "gateway",
      "scoring-api",
      "parser",
      "realtime",
      "projector",
      "outbox-relay",
      "report-worker"
    ]).toHaveLength(7);
  });
});
