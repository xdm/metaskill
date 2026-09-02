import { describe, expect, it } from "vitest";
import { addHooks, hookCommand, isMetaskillHookCommand, removeHooks, type Settings } from "../src/settings.js";

describe("settings hooks merge (spec 4.1)", () => {
  it("adds both hooks to empty settings", () => {
    const s = addHooks({});
    const ups = s.hooks!.UserPromptSubmit!;
    expect(ups).toHaveLength(1);
    expect(ups[0]!.hooks![0]!.command).toBe(hookCommand("route"));
    expect(ups[0]!.hooks![0]!.timeout).toBe(10);
    expect(ups[0]!.matcher).toBeUndefined(); // UserPromptSubmit has no matcher support
    const ss = s.hooks!.SessionStart!;
    expect(ss[0]!.matcher).toBe("startup|resume|clear|compact");
    expect(ss[0]!.hooks![0]!.command).toBe(hookCommand("sync"));
    expect(ss[0]!.hooks![0]!.timeout).toBe(120);
  });

  it("repairs a stale matcher and timeout on re-init", () => {
    // upsert used to refresh command and timeout but never the matcher, so an
    // entry written by an older metaskill kept `startup|resume` forever and
    // re-running `init` could not repair it: after a /clear those sessions got
    // no protocol at all, with no self-healing path.
    const stale: Settings = {
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: hookCommand("sync"), timeout: 60 }] },
        ],
      },
    };
    const ss = addHooks(stale).hooks!.SessionStart!;
    expect(ss).toHaveLength(1); // repaired in place, not duplicated
    expect(ss[0]!.matcher).toBe("startup|resume|clear|compact");
    expect(ss[0]!.hooks![0]!.timeout).toBe(120);
  });

  it("leaves a group with NO matcher alone, rather than narrowing it", () => {
    // An absent matcher fires on every source there is — startup, resume,
    // clear, compact and anything added later — so writing our string over it
    // would strictly reduce when the protocol is injected. A repair must never
    // be a downgrade.
    const broad: Settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: hookCommand("sync"), timeout: 60 }] }],
      },
    };
    const ss = addHooks(broad).hooks!.SessionStart!;
    expect(ss).toHaveLength(1);
    expect(ss[0]!.matcher).toBeUndefined();
    expect(ss[0]!.hooks![0]!.timeout).toBe(120); // timeout still repaired
  });

  it("never rewrites the matcher of a group it shares with a foreign hook", () => {
    // That group is the foreign hook's configuration too, and addHooks
    // promises to touch nothing but its own entry.
    const shared: Settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "other-tool sync" },
              { type: "command", command: hookCommand("sync"), timeout: 60 },
            ],
          },
        ],
      },
    };
    const ss = addHooks(shared).hooks!.SessionStart!;
    expect(ss[0]!.matcher).toBe("startup");
    expect(ss[0]!.hooks![1]!.timeout).toBe(120); // ours still refreshed
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
