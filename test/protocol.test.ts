import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliEntryPath } from "../src/paths.js";
import { protocolText } from "../src/protocol.js";

const FIND_SRC = fs.readFileSync(path.resolve(__dirname, "..", "src", "commands", "find.ts"), "utf8");

describe("protocolText", () => {
  it("names the find command with the running CLI's own path", () => {
    expect(protocolText()).toMatch(/node "[^"]*cli\.js" find "/);
  });

  it("triggers on every task, with nothing for the model to adjudicate", () => {
    const t = protocolText();
    // v1's opt-out line, and the softer conditionals that read the same way:
    // each makes the model rule on whether a skill beats it BEFORE it has any
    // information, and its honest prior on nearly every task is "no".
    expect(t).not.toMatch(/\bIf a specialized skill could\b/);
    expect(t).not.toMatch(/would do better/i);
    expect(t).not.toMatch(/\bif a (specialised|specialized) skill\b/i);
    expect(t).toMatch(/at the start of every task/i);
    expect(t).toMatch(/before you (start|begin)/i);
  });

  it("tells the model to run it even when it is sure it need not", () => {
    // The 3% follow-through v1 measured is a confident model skipping a step
    // it was never told applied to it anyway.
    expect(protocolText()).toMatch(/even when you are (sure|confident)/i);
  });

  it("says the protocol fires per task, so a long session cannot read it as done", () => {
    expect(protocolText()).toMatch(/once per task/i);
  });

  it("puts the timing instruction on a line of its own", () => {
    // Buried as the fourth sentence of a paragraph about language and cost,
    // this is the sentence a skimming model loses first.
    expect(protocolText().split("\n")).toContain("Run it before answering, not after.");
  });

  it("tells the model the user's language does not matter", () => {
    expect(protocolText()).toMatch(/any language/i);
  });

  it("quotes only labels that find.ts actually prints", () => {
    const t = protocolText();
    // find.ts prints `Top matches for "<query>"`. The other three labels match
    // find's output exactly, so a model has no cue that this one is
    // approximate — and it is the branch where ask-the-user-first is the whole
    // safety property.
    expect(t).not.toContain("Top matches:");
    for (const label of [
      "Installed now:",
      "Already present:",
      "Top matches",
      "live search found",
      "timed out",
      "No skills found",
    ]) {
      expect(t, `protocol names "${label}"`).toContain(label);
      expect(FIND_SRC, `find.ts prints "${label}"`).toContain(label);
    }
  });

  it("makes no cost or privacy claim the tool cannot keep", () => {
    // find is ~0.4s on a local index hit, but on a miss it calls
    // discoverByQuery over the network (20s measured, ending in an install
    // timeout). A reassurance the model disconfirms on its first run costs the
    // whole block its credibility.
    const t = protocolText();
    expect(t).not.toMatch(/milliseconds/i);
    expect(t).not.toMatch(/offline/i);
    expect(t).not.toMatch(/never sends/i);
  });

  it("stays short enough to inject every session", () => {
    expect(protocolText().length).toBeLessThan(1400);
  });

  it("stays under budget for a long install path, not just this checkout's", () => {
    // cliEntryPath() is interpolated once and runs longer for a plugin-cache,
    // npx-cache or global install than for this repo. Measuring only the
    // checkout's own path would let the text creep past the budget exactly
    // where it ships.
    expect(protocolText().length - cliEntryPath().length + 120).toBeLessThan(1400);
  });
});
