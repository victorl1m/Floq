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

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string;
}
