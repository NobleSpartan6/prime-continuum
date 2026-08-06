import { describe, expect, it } from "vitest";
import { nodeRuntimeStatus } from "../../src/hostd/probe";

describe("host runtime probe", () => {
  it.each(["22.8.0", "22.22.3", "24.18.1"])("accepts supported Node.js %s", (version) => {
    expect(nodeRuntimeStatus(version)).toEqual({
      available: true,
      status: "ready",
      version: `Node.js ${version}`,
    });
  });

  it.each(["21.99.0", "22.7.9"])("rejects unsupported Node.js %s", (version) => {
    expect(nodeRuntimeStatus(version)).toMatchObject({
      available: false,
      status: "error",
      version: `Node.js ${version}`,
      diagnostic: "Prime Agent 0.7.0 requires Node.js 22.8 or newer.",
    });
  });

  it("fails closed on an invalid runtime version", () => {
    expect(nodeRuntimeStatus("unknown")).toEqual({
      available: false,
      status: "error",
      diagnostic: "The host Node.js version is invalid.",
    });
  });
});
