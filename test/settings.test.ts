import { describe, expect, it } from "vitest";
import { addHooks, hookCommand, isMetaskillHookCommand, removeHooks, type Settings } from "../src/settings.js";

describe("settings hooks merge (spec 4.1)", () => {
  it("adds both hooks to empty settings", () => {
    const s = addHooks({});
    const ups = s.hooks!.UserPromptSubmit!;
    expect(ups).toHaveLength(1);
    expect(ups[0]!.hooks![0]!.command).toBe(hookCommand("route"));
    expect(ups[0]!.hooks![0]!.timeout).toBe(30);
    expect(ups[0]!.matcher).toBeUndefined(); // UserPromptSubmit has no matcher support
    const ss = s.hooks!.SessionStart!;
    expect(ss[0]!.matcher).toBe("startup|resume");
    expect(ss[0]!.hooks![0]!.command).toBe(hookCommand("sync"));
  });

  it("preserves existing foreign hooks and unknown settings keys", () => {
    const s: Settings = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool inject" }] }],
      },
    };
    const out = addHooks(structuredClone(s));
    expect(out.model).toBe("opus");
    expect(out.hooks!.PreToolUse).toEqual(s.hooks!.PreToolUse);
    const cmds = out.hooks!.UserPromptSubmit!.flatMap((g) => g.hooks!.map((h) => h.command));
    expect(cmds).toContain("other-tool inject");
    expect(cmds).toContain(hookCommand("route"));
  });

  it("is idempotent: re-running never duplicates", () => {
    const once = addHooks({});
    const twice = addHooks(structuredClone(once));
    expect(twice.hooks!.UserPromptSubmit!.flatMap((g) => g.hooks!)).toHaveLength(1);
    expect(twice.hooks!.SessionStart!.flatMap((g) => g.hooks!)).toHaveLength(1);
  });

  it("recognizes legacy/global-install command forms as ours", () => {
    expect(isMetaskillHookCommand("metaskill route", "route")).toBe(true);
    expect(isMetaskillHookCommand('node "/opt/x/dist/cli.js" route', "route")).toBe(true);
    expect(isMetaskillHookCommand("other-tool route", "route")).toBe(false);
    expect(isMetaskillHookCommand("metaskill route", "sync")).toBe(false);
  });

  it("uninstall removes only ours and cleans empty structures", () => {
    const s: Settings = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    };
    const withOurs = addHooks(structuredClone(s));
    const out = removeHooks(withOurs);
    expect(out.hooks!.UserPromptSubmit).toBeUndefined();
    expect(out.hooks!.SessionStart).toBeUndefined();
    expect(out.hooks!.PreToolUse).toEqual(s.hooks!.PreToolUse);
    // removing from pristine settings leaves them pristine
    expect(removeHooks({})).toEqual({});
  });
});
