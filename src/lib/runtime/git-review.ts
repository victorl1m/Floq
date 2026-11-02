export interface GitChange {
  path: string;
  originalPath?: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitChanges {
  repository: string;
  branch: string | null;
  changes: GitChange[];
  truncated: boolean;
}

export interface GitFileDiff {
  path: string;
  patch: string;
  binary: boolean;
  tooLarge: boolean;
}
