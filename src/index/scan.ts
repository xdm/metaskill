// The indexer scans directories that are already extracted, so it must not
// pull in the tarball downloader. This module is the seam.
export { scanDirectory } from "../scan.js";
export { findSkillDirs } from "./repo.js";
