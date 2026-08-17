import type { WorkspaceIndex } from "./types";

/**
 * A cheap, token-efficient picture of the connected workspace: the root label,
 * every directory that appears in the index, and the full list of indexed file
 * paths. Built from the index (never from the filesystem directly), so it stays
 * in sync with what chat retrieval can actually see.
 */
export interface WorkspaceManifest {
  root: string;
  directories: string[];
  files: string[];
}

export function buildManifest(index: WorkspaceIndex | null): WorkspaceManifest {
  if (!index) {
    return { root: "", directories: [], files: [] };
  }
  const directories = new Set<string>();
  const files: string[] = [];
  for (const file of index.files) {
    files.push(file.path);
    let dir = file.dir;
    while (dir) {
      directories.add(dir);
      const idx = dir.lastIndexOf("/");
      dir = idx === -1 ? "" : dir.slice(0, idx);
    }
  }
  return {
    root: index.root,
    directories: [...directories].sort(),
    files: files.sort()
  };
}