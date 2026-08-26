import { statePath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";
import type { StateFile } from "./types.js";

export function readState(): StateFile {
  return readJsonFile<StateFile>(statePath(), {});
}

export function writeState(state: StateFile): void {
  writeJsonFile(statePath(), state);
}
