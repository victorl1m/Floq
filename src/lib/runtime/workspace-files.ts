export interface FileEntry {
  name: string;
  /** Path relative to the workspace root, "/"-separated. */
  path: string;
  type: "dir" | "file";
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  truncated: boolean;
}

export interface ArtifactEntry {
  name: string;
  /** Path relative to the project's Artifacts folder. */
  path: string;
  size: number;
  /** Epoch ms. */
  modifiedAt: number;
}

export interface ArtifactListing {
  /** Absolute folder path inside the sandbox, shown to the user and given to agents as FLOQ_ARTIFACTS_DIR. */
  dir: string;
  entries: ArtifactEntry[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string;
}
