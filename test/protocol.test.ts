import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEVANCE_BANDS } from "../src/index/read.js";
import { cliEntryPath } from "../src/paths.js";
import { protocolText } from "../src/protocol.js";

const FIND_SRC = fs.readFileSync(path.resolve(__dirname, "..", "src", "commands", "find.ts"), "utf8");
const SKILL_MD = fs.readFileSync(path.resolve(__dirname, "..", "skills", "metaskill", "SKILL.md"), "utf8");

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

  it("tells the model the user's language does not matter, and to name the artefact anyway", () => {
    // Both live incidents arrived as Russian prompts, and a model that
    // translates the prompt instead of naming the capability searches for the
    // user's phrasing rather than the artefact. Only /any language/ was
    // pinned, so the half that says what to do with it — derive the query
    // FROM THE TASK, do not translate — could be trimmed for budget without
    // a single test noticing. It nearly was.
    const t = flat();
    expect(t).toMatch(/any language/i);
    expect(t).toMatch(/from the task/i);
    expect(t).toMatch(/not translated/i);
    // ...and SKILL.md says the same thing in its own words.
    expect(SKILL_MD.replace(/\s+/g, " ")).toMatch(/never translate the prompt/i);
  });

  it("quotes only labels that find.ts actually prints", () => {
    const t = protocolText();
    // find.ts prints `Top matches for "<query>"`. The other labels match
    // find's output exactly, so a model has no cue that this one is
    // approximate — and it is the branch where ask-the-user-first is the whole
    // safety property.
    expect(t).not.toContain("Top matches:");
    for (const label of [
      "Already present:",
      "Top matches",
      "live search found",
      "Refused by policy",
      "No skills found",
      // The lines find.ts now prints for the top askable row, one per band.
      // The block tells the model to act on whichever one appears, so the
      // labels have to be the ones that actually reach the screen.
      "Ask the user:",
      "Borderline match",
      // Named in the block as well as in SKILL.md, so renaming it in find.ts
      // fails the block's cross-check too, not only the reference's.
      "Weak matches only",
      // A timed-out live lookup and a registry that answered "nothing" are
      // different facts. One label for both would have the model report a
      // coverage gap it never established.
      "Registry did not answer",
    ]) {
      expect(t, `protocol names "${label}"`).toContain(label);
      expect(FIND_SRC, `find.ts prints "${label}"`).toContain(label);
    }
  });

  it("names no outcome find can no longer reach", () => {
    // `find` installs nothing now, so it can print neither an install
    // confirmation nor an install failure. A protocol still promising
    // `Installed now:` teaches the model to wait for a line that will never
    // come — and, worse, to report an install that never happened.
    const t = protocolText();
    for (const gone of ["Installed now:", "Install timed out", "Install failed"]) {
      expect(t, `protocol must not name "${gone}"`).not.toContain(gone);
      expect(FIND_SRC, `find.ts must not print "${gone}"`).not.toContain(gone);
    }
    expect(FIND_SRC, "find.ts must not install").not.toContain("installSkill");
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

  it("says find never installs, and names the one setting that changes it", () => {
    // The inverse of what this test asserted while `find` installed the
    // top-ranked hit unattended. A model that still believes the command
    // installs will report an install that never happened, and skip the
    // question that is now the only way anything lands on disk.
    const t = flat();
    expect(t).toMatch(/never installs/i);
    expect(t).toMatch(/explicit yes/i);
    expect(t).toMatch(/trust\.auto_install: true/);
    expect(t).not.toMatch(/installs that skill for you/i);
  });

  it("tells the model what a low relevance means and to decline on it", () => {
    // Removing the hard relevance floor made the model's judgement the only
    // filter, and `find` prints a number the block never explained — beside a
    // policy reason ("publisher anthropics is allowlisted, scan clean") that
    // reads as an endorsement. Measured against the real index, `tell me a
    // joke` returns a 0.53-relevance account-research skill wearing exactly
    // that reason. SKILL.md saying it is not enough: it loads on invocation,
    // this block loads at session start.
    const t = flat();
    expect(t).toMatch(/low `relevance`/i);
    expect(t).toMatch(/barely matched/i);
    expect(t).toMatch(/decline it/i);
  });

  it("states when to ask as a rule with numbers, not as a judgement call", () => {
    // The judgement it replaces — "judge which row, if any, fits the task; if
    // none does, solve it yourself" — is a slot the model fills with its own
    // prior, and on first real use it filled it with "none": five ask rows, a
    // 1.16-relevance top row that plainly fitted, and no question asked. A
    // reader who has to decide whether to ask has already been given the
    // option not to. Bands, not discretion: the numbers come from the
    // measured distributions (see src/protocol.ts).
    const t = flat();
    expect(t).toMatch(/`relevance` >= 1\.0/);
    expect(t).toMatch(/0\.5/);
    expect(t).not.toMatch(/judge which row/i);
    expect(t).not.toMatch(/if none does, solve it yourself/i);
  });

  it("makes the >= 1.0 band read the row's description before it relays anything", () => {
    // A 47-query probe of everyday life and work phrases against the live
    // index put 26 of them in the >= 1.0 band, and many of those top rows are
    // homonyms BM25 cannot see: "insomnia help" -> insomnia-collection-
    // generator (a REST client, 1.28), "stress management" -> stress-test
    // (load testing, 1.20), "time management" -> itinerary-optimizer,
    // "language learning" -> vision-sft. A rare query word carries high idf,
    // so the wrong sense of it scores HIGH — and the old rule ("put that
    // question to the user before anything else") mandated asking "Install
    // insomnia-collection-generator?" on a sleep question.
    //
    // The fix is not to hand back the judgement the bands took away: what
    // stopped the first incident was the ready-made sentence, "ask first",
    // and the closed escape hatch. It is ONE specific check the model can
    // actually make and the score cannot — does the printed description
    // describe this task? — with both outcomes named, so neither is a slot
    // for "I've got this".
    const t = flat();
    expect(t).not.toMatch(/before anything else/i);
    expect(t).toMatch(/likely fit/i);
    expect(t).toContain("read the row's description");
    // ...and the band still ends in an ask, not in a free choice.
    expect(t).toMatch(/ask it first/i);
    // The same check, in the two documents the model reads in the decision
    // turn and afterwards. find.ts's copy is the one on screen when it acts —
    // and it says this TWICE, in the header and in the verdict line, so a
    // bare `toContain("read the row's description")` passes with the verdict
    // line mutated to anything at all. The cue's own fuller phrase is what
    // pins the site the model reads under the rows.
    expect(FIND_SRC, "find.ts states the description check").toContain("read the row's description");
    expect(FIND_SRC, "the >= 1.0 CUE states it, not only the header").toContain(
      "— read the row's description first:",
    );
    // The rows this lands on are not always readable: 900 of the shipped
    // snapshot's 4,831 records have a description that is blank or a bare
    // YAML block mark, and 7 of the 44 answerable fixture queries hit one as
    // their top row. "Fits" and "a different thing with the same word" both
    // assume text, so the cue names the third case and resolves it the way
    // silence always resolves here.
    expect(FIND_SRC, "the cue covers a description it cannot read").toContain(
      "if the description is blank or a bare mark",
    );
    // ...and where it cannot be read at all, the cue says so INSTEAD of the
    // question: a stop instruction with a ready-made `Ask the user:` line
    // under it is the shape ruling 44 removed from the weak band. One helper
    // decides both the sentence and the suppression, so they cannot drift.
    expect(FIND_SRC, "the unreadable case prints no question").toContain("so no question is printed");
    expect(FIND_SRC, "one helper decides it").toContain("function descriptionUnreadable(");
    expect(SKILL_MD.replace(/\s+/g, " "), "SKILL.md covers it too").toContain("A blank description");
    expect(SKILL_MD.replace(/\s+/g, " "), "SKILL.md says the question is conditional").toContain(
      "no question is printed for a row you cannot check",
    );
    expect(SKILL_MD.replace(/\s+/g, " "), "SKILL.md states the description check").toContain(
      "read the row's description",
    );
    // The homonym itself is named in the two documents with room for it —
    // find.ts's cue is what the model has on screen in the turn it decides,
    // and SKILL.md is the reference. The injected block carries the rule in
    // its shortest true form ("else say nothing"): it is budgeted per
    // session, and the gloss is the first thing that has to give.
    for (const doc of [FIND_SRC.replace(/\s+/g, " "), SKILL_MD.replace(/\s+/g, " ")]) {
      expect(doc).toContain("a different thing with the same word");
    }
  });

  it("names life and work domains, not only IT, when it says what to query for", () => {
    // The same probe: a block whose only examples are formats, frameworks and
    // "a craft like SEO" tells a model that `find` is for engineering tasks,
    // which is how "meal prep" or "salary negotiation" never gets a query at
    // all. The registry carries skills for both.
    const t = flat();
    for (const kind of ["health", "money", "career", "cooking", "writing", "learning"]) {
      expect(t, `protocol names "${kind}"`).toContain(kind);
    }
  });

  it("puts the ask before any task work, in BOTH asking bands", () => {
    // Second real v2 use: a borderline row at 0.85, judged to fit, and the
    // question arrived as the last line of a paragraph that had already
    // started answering the task — so the user never experienced it as a
    // question. The band text was the reason: only `>= 1.0` said "before
    // anything else"; `Borderline match` said "judge, then ask", which is
    // satisfied by asking at the end of an answer.
    const t = flat();
    expect(t).toMatch(/before (you )?(start|begin|do) (the task|anything)/i);
    expect(t).toMatch(/not inside an answer/i);
    expect(t).toMatch(/`Borderline match` — judge whether it fits, then ask first/);
    expect(t).not.toMatch(/`Borderline match` — judge, then ask;/);
  });

  it("names the AskUserQuestion tool as the way to ask, with a text fallback", () => {
    // The model had a tool that renders a real yes/no choice and used prose
    // instead, because nothing told it to. The instruction has to stay
    // conditional — AskUserQuestion exists in an interactive Claude Code
    // session, not in every harness — and the fallback has to be a message
    // that is nothing but the question, which is the property that failed.
    const t = flat();
    expect(t).toMatch(/AskUserQuestion/);
    expect(t).toMatch(/if you have it/i);
    // The option LABEL is the skill name, and the package — 55 chars for the
    // row in the incident — goes in the description, where it still reaches
    // the user. A label that renders as `Install ailabs-393/ai-labs-clau…`
    // is a choice the user cannot read.
    expect(t).toContain("`Install <skill name>` / `No`");
    expect(t).toMatch(/package\s+in the description/i);
    expect(t).toMatch(/one line of text and nothing else/i);
  });

  it("says 'then ask first' in find.ts's own header too, not only here", () => {
    // The header is the first sentence of the tool result — the copy of this
    // rule the model reads IN the decision turn, above everything the block
    // says. It could be reverted to "then ask" with every test still green:
    // the cross-check pinned find.ts's LABELS and never the clause. Now the
    // two documents share one substring or this fails.
    const clause = "judge whether it fits, then ask first";
    expect(flat(), `protocol says "${clause}"`).toContain(clause);
    expect(FIND_SRC, `find.ts's header says "${clause}"`).toContain(clause);
  });

  it("hands the borderline band a sentence, in the words all three documents use", () => {
    // The band that failed is the one that had no ready-made question: at
    // 0.85 the model judged correctly and then had to compose one. `find`
    // now prints it after the cue — WITHOUT the `Ask the user:` label, which
    // stays bound to >= 1.0 (see the label cross-check above).
    //
    // "and nothing else" was true of the text fallback and false of the tool
    // path, which necessarily splits the sentence into an option label and a
    // description — an instruction the model cannot obey with the tool the
    // protocol tells it to prefer. The cue now names both ways of asking, in
    // the same order the block does.
    const phrase = "ask exactly this, first — via the tool if you have it, else as one line and nothing else";
    expect(FIND_SRC, `find.ts prints "${phrase}"`).toContain(phrase);
    expect(SKILL_MD.replace(/\s+/g, " "), `SKILL.md quotes "${phrase}"`).toContain(phrase);
    expect(FIND_SRC, "the old absolute wording is gone").not.toContain("ask exactly this, first, and nothing else");
    // `Borderline match` appears in the header too, so pin the verdict line
    // itself — the interpolated package is what makes this string unique to
    // the cue printed under the rows.
    expect(FIND_SRC, "the borderline CUE still judges before it asks").toContain(
      "judge whether ${topAsk.r.pkg} fits.",
    );
  });

  it("quotes the same two numbers find.ts bands on", () => {
    // The bands are enforced in code (read.ts's RELEVANCE_BANDS, applied by
    // find.ts) and described here. Two copies of a number drift; this fails
    // the moment they do, so the constant is the single source and the text
    // is checked against it.
    const t = flat();
    expect(t).toContain(`\`relevance\` >= ${RELEVANCE_BANDS.ask.toFixed(1)}`);
    expect(t).toContain(`under ${RELEVANCE_BANDS.judge.toFixed(1)}`);
    expect(RELEVANCE_BANDS.ask).toBeGreaterThan(RELEVANCE_BANDS.judge);
  });

  it("leaves no judgement in find.ts's own header either", () => {
    // The block dropped "judge which row, if any, fits the task" — but the
    // same sentence opened find's output, which the model reads IN the
    // decision turn, above everything this block says. Removing it from one
    // document and leaving it in the other changes nothing.
    expect(FIND_SRC).not.toContain("Judge whether one of these actually fits");
    expect(FIND_SRC).not.toContain("if none does, solve it yourself");
    expect(FIND_SRC).not.toContain("ask the user ONE question");
  });

  it("says what to name when no capability phrase is obvious, without gating on it", () => {
    // "fix this failing test" names no capability, so without this the dodge
    // simply moves from "I've got this" to "I cannot form a query".
    const t = flat();
    expect(t).toMatch(/name the artefact or domain/i);
    expect(t).toMatch(/not the action/i);
    // ...but the guidance must not end in a condition. An earlier draft closed
    // it with "skip only when nothing like that is in play", which handed back
    // the judgement `Run it even when you are sure` exists to forbid — and sat
    // eleven lines under that sentence, where it wins at reading speed.
    expect(t).not.toMatch(/\bskip\b/i);
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

  it("bounds the string actually injected, not only its prose", () => {
    // The prose budget above strips both absolute paths, on the grounds that
    // no rewording buys them back — which is true, and leaves the thing the
    // session actually pays for measured by nothing. Bound it here against a
    // deliberately long install: a 100-char interpreter (nvm under
    // "Application Support" with a long username) and a 120-char plugin-cache
    // CLI path. ~1600 chars is ~400 tokens, once per session start.
    const injected = protocolText()
      .replace(process.execPath, "n".repeat(100))
      .replace(cliEntryPath(), "c".repeat(120));
    expect(injected.length).toBeLessThan(1600);
  });
});

// SKILL.md is the longer reference for the same rules the protocol block
// carries, and it drifted: it had neither the `Registry did not answer`
// branch nor any statement that `find` installs unattended, so a model
// reading the skill instead of the block got a strictly weaker contract than
// the one the code implements. Cross-checked against find.ts the same way the
// protocol is.
describe("skills/metaskill/SKILL.md", () => {
  const flatMd = SKILL_MD.replace(/\s+/g, " ");

  it("quotes only labels that find.ts actually prints", () => {
    for (const label of [
      "Already present:",
      "Top matches for",
      "live search found",
      "Refused by policy",
      "Registry did not answer",
      "No skills found",
      "Ask the user:",
      "Borderline match",
      "Weak matches only",
    ]) {
      expect(SKILL_MD, `SKILL.md names "${label}"`).toContain(label);
      expect(FIND_SRC, `find.ts prints "${label}"`).toContain(label);
    }
  });

  it("states the same ask rule, with the same numbers, as the protocol block", () => {
    // Two documents, one contract — and this is the rule that decides whether
    // the user is ever asked at all. A SKILL.md that still says "decide which
    // row, if any, actually fits" hands the judgement back to a model that
    // reads it instead of the block.
    // `before anything else` used to be in this list. It is gone from both
    // documents deliberately: at >= 1.0 the model now reads the row's
    // description first (see the band test above), because a homonym scores
    // high exactly when its shared word is rare. What replaces it is a
    // check, not a discretion — the band still ends in an ask.
    for (const re of [/`relevance` >= 1\.0/, /likely fit/i, /read the row's description/, /0\.5/]) {
      expect(flatMd, `SKILL.md matches ${re}`).toMatch(re);
      expect(protocolText().replace(/\s+/g, " "), `protocol matches ${re}`).toMatch(re);
    }
    expect(flatMd).toContain(`\`relevance\` >= ${RELEVANCE_BANDS.ask.toFixed(1)}`);
    expect(flatMd).toContain(`under ${RELEVANCE_BANDS.judge.toFixed(1)}`);
    expect(flatMd).not.toMatch(/decide which row/i);
    // The permission the bands replace: "a signal for your judgement, not a
    // verdict" sat three lines above the rule and gave back what it takes.
    expect(flatMd).not.toMatch(/signal for your judgement/i);
  });

  it("names no outcome find can no longer reach", () => {
    for (const gone of ["Installed now:", "Install timed out", "Install failed"]) {
      expect(SKILL_MD, `SKILL.md must not name "${gone}"`).not.toContain(gone);
    }
  });

  it("states the same ask-first rule and the same way of asking as the block", () => {
    // The two documents disagreeing about WHEN and HOW to ask is the same
    // defect as either of them being silent: the model reads whichever it
    // has. Both phrases, in both places.
    for (const re of [
      /before you start the task/i,
      /AskUserQuestion/,
      /not inside an answer/i,
      /`Install <skill name>`/,
      /package in (the|its) description/i,
    ]) {
      expect(flatMd, `SKILL.md matches ${re}`).toMatch(re);
      expect(protocolText().replace(/\s+/g, " "), `protocol matches ${re}`).toMatch(re);
    }
    // The borderline band asks too, and asks first — not "only if it does".
    expect(flatMd).toMatch(/`Borderline match`.{0,220}\bfirst\b/);
  });

  it("covers every branch the protocol block covers", () => {
    // Anything the block tells the model to act on, the reference must too —
    // otherwise the two disagree about what the tool can print.
    for (const label of ["Already present:", "Top matches", "live search found", "Refused by policy",
                         "Registry did not answer", "No skills found"]) {
      expect(protocolText(), `protocol names "${label}"`).toContain(label);
      expect(SKILL_MD, `SKILL.md names "${label}"`).toContain(label);
    }
  });

  it("explains relevance the same way the protocol block does", () => {
    // Two documents, one contract. A reference that omits the scale leaves a
    // model that read only it with no way to weigh the number find prints.
    for (const re of [/low `relevance`/i, /barely matched/i, /decline it/i]) {
      expect(flatMd, `SKILL.md matches ${re}`).toMatch(re);
      expect(protocolText().replace(/\s+/g, " "), `protocol matches ${re}`).toMatch(re);
    }
  });

  it("says that find never installs, and names the opt-in that changes that", () => {
    // The reference and the block have to agree about who installs. A
    // SKILL.md still describing an unattended install is a model reporting one
    // that never happened.
    expect(flatMd).toMatch(/never installs/i);
    expect(flatMd).toMatch(/explicit yes/i);
    expect(flatMd).toMatch(/trust\.auto_install/);
    expect(flatMd).not.toMatch(/installs that skill for you/i);
  });

  it("tells the model that a timed-out lookup is not a coverage gap", () => {
    expect(flatMd).toMatch(/Registry did not answer.{0,160}not evidence/i);
  });
});
