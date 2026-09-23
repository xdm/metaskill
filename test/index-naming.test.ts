import { describe, expect, it } from "vitest";
import { installNameOf } from "../src/index/naming.js";

// Mirrors the skills CLI's sanitizeName (skills@1.5.23): the name it matches
// an `@selector` against and the directory it installs into. Every case here
// was checked against that function.
describe("installNameOf", () => {
  it("leaves the common shape alone", () => {
    expect(installNameOf("xlsx")).toBe("xlsx");
    expect(installNameOf("vercel-react-best-practices")).toBe("vercel-react-best-practices");
  });

  it("lowercases and turns runs of anything outside [a-z0-9._] into one dash", () => {
    expect(installNameOf("LinkedIn Automation")).toBe("linkedin-automation");
    expect(installNameOf("Hook  Development")).toBe("hook-development");
    expect(installNameOf("Writing Hookify Rules")).toBe("writing-hookify-rules");
    expect(installNameOf("a/b\\c:d")).toBe("a-b-c-d");
  });

  it("keeps dots and underscores, which the CLI keeps too", () => {
    expect(installNameOf("next.js_helper")).toBe("next.js_helper");
  });

  it("strips leading and trailing dots and dashes", () => {
    expect(installNameOf("--wrapped--")).toBe("wrapped");
    expect(installNameOf(".hidden.")).toBe("hidden");
    expect(installNameOf("Écrire")).toBe("crire");
  });

  it("falls back to the CLI's own placeholder when nothing survives", () => {
    expect(installNameOf("???")).toBe("unnamed-skill");
    expect(installNameOf("")).toBe("unnamed-skill");
  });

  it("caps at 255 characters like the CLI", () => {
    expect(installNameOf("a".repeat(300))).toHaveLength(255);
  });
});
