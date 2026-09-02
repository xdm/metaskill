import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliEntryPath } from "../src/paths.js";
import { protocolText } from "../src/protocol.js";

const FIND_SRC = fs.readFileSync(path.resolve(__dirname, "..", "src", "commands", "find.ts"), "utf8");

// The protocol is hard-wrapped, so a phrase assertion has to survive a line
// break falling in the middle of it. Only the line-shape test reads the
// unflattened string.
const flat = (): string => protocolText().replace(/\s+/g, " ");

describe("protocolText", () => {
  it("names the find command with this interpreter and the running CLI's path", () => {
    const t = protocolText();
    // Both halves absolute and quoted: bare `node` is absent from the PATH a
    // hook inherits under nvm/Herd, and this machine's interpreter path
    // contains a space, so an unquoted path would be split by the shell.
    expect(t).toContain(`"${process.execPath}" "${cliEntryPath()}" find "`);
    expect(t).toMatch(/"[^"]+" "[^"]*cli\.js" find "/);
    expect(t).not.toMatch(/(^|\s)node "/);
  });

  it("triggers on every task, with nothing for the model to adjudicate", () => {
    const t = protocolText();
    // v1's opt-out line, and the softer conditionals that read the same way:
    // each makes the model rule on whether a skill beats it BEFORE it has any
    // information, and its honest prior on nearly every task is "no".
    expect(t).not.toMatch(/\bIf a specialized skill could\b/);
    expect(t).not.toMatch(/would do better/i);
    expect(t).not.toMatch(/\bif a (specialised|specialized) skill\b/i);
    expect(flat()).toMatch(/at the start of every task, before you begin work/i);
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

  it("warns that find installs, rather than reading as a lookup", () => {
    // Default policy auto-installs an allowlisted publisher, or 5000+ installs
    // with a clean scan, without asking anyone. A model told only "run:" has
    // no basis to warn the user first — and the ask-on-an-explicit-yes rule is
    // true of the `Top matches` branch, not of the command as a whole.
    const t = flat();
    expect(t).toMatch(/not only a lookup/i);
    expect(t).toMatch(/installs that skill for you/i);
    expect(t).toMatch(/tell the user what it installed/i);
  });

  it("says what to query when no capability phrase is obvious", () => {
    // "fix this failing test" names no capability, so without this the dodge
    // simply moves from "I've got this" to "I cannot form a query".
    const t = flat();
    expect(t).toMatch(/name the artefact or domain/i);
    expect(t).toMatch(/not the action/i);
    expect(t).toMatch(/skip only when nothing like that is in play/i);
  });

  it("stays short enough to inject every session", () => {
    // Budget the PROSE, with both absolute paths removed. They vary by
    // install channel and machine — process.execPath alone is 86 chars here —
    // and no amount of rewording buys them back, so measuring the whole string
    // would just make the budget a function of where metaskill happens to be
    // installed. 1400 is the original whole-text budget, kept as-is.
    const prose = protocolText().replace(process.execPath, "").replace(cliEntryPath(), "");
    expect(prose.length).toBeLessThan(1400);
  });
});
