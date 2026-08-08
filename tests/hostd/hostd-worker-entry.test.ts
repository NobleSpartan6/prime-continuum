import { describe, expect, it } from "vitest";
import { isDirectHostdInvocation } from "../../src/hostd";

describe("hostd direct invocation fence", () => {
  it("runs the CLI only for a direct main-thread hostd invocation", () => {
    expect(isDirectHostdInvocation("C:\\app\\resources\\hostd\\hostd.cjs", true)).toBe(true);
    expect(isDirectHostdInvocation("/opt/prime-agent-hostd", true)).toBe(true);
    expect(isDirectHostdInvocation("C:\\app\\resources\\hostd\\hostd.cjs", false)).toBe(false);
    expect(isDirectHostdInvocation(undefined, true)).toBe(false);
  });
});
