// The name a skill is installed under, and the one an `@selector` has to
// match. This mirrors the skills CLI's own sanitiseName (skills@1.5.23):
// lowercase, every run of characters outside [a-z0-9._] becomes one dash,
// leading and trailing dots and dashes go, 255 chars at most, and a name
// that leaves nothing gets the CLI's own placeholder.
//
// The record's `pkg` (`owner/repo@<this>`) used to end in the raw frontmatter
// name. For the ordinary all-lowercase-hyphens name the two are the same
// string, which is why it took 345 live records with spaces or capitals
// (`anthropics/claude-code@Hook Development`,
// `claude-office-skills/skills@LinkedIn Automation`) to show that every
// command printed for them split in the shell and named a skill the CLI
// would not match. `install`'s locateInstalled() reads this same suffix as
// the installed directory, which is also what the CLI creates.
//
// Kept byte-for-byte with the CLI on purpose: a "nicer" slug (the registry's
// own drops dots and underscores) would name a directory the CLI never
// creates. Change it only against the CLI's source.
export function installNameOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .substring(0, 255) || "unnamed-skill"
  );
}
