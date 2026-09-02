import { describe, expect, it } from "vitest";
import { protocolText } from "../src/protocol.js";

describe("protocolText", () => {
  it("names the find command with the running CLI's own path", () => {
    expect(protocolText()).toMatch(/node "[^"]*cli\.js" find "/);
  });

  it("is phrased as a standing instruction, not an optional suggestion", () => {
    const t = protocolText();
    expect(t).not.toMatch(/\bIf a specialized skill could\b/);
    expect(t).toMatch(/before you (start|begin)/i);
  });

  it("tells the model the user's language does not matter", () => {
    expect(protocolText()).toMatch(/any language/i);
  });

  it("stays short enough to inject every session", () => {
    expect(protocolText().length).toBeLessThan(1400);
  });
});
