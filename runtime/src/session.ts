import type { PtyProcess } from "./pty.js";
import { log } from "./logger.js";
import type { ProviderId, ServerFrame, SessionState, SessionSummary } from "./types.js";

export interface OutputChunk {
  seq: number;
  data: string;
  ts: number;
}

export type SessionListener = (frame: ServerFrame) => void;

export interface SessionOptions {
  id: string;
  userId: string;
  provider: ProviderId;
  title: string;
  cwd: string;
  projectCwd?: string | null;
  projectId?: string | null;
  worktreeId?: string | null;
  branch?: string | null;
  gitUrl?: string | null;
  cols: number;
  rows: number;
  outputBufferBytes: number;
  pty: PtyProcess;
  createdAt?: number;
  resumeCount?: number;
  model?: string | null;
}

export class Session {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderId;
  private _title: string;
  readonly cwd: string;
  readonly projectCwd: string | null;
  readonly projectId: string | null;
  readonly worktreeId: string | null;
  readonly branch: string | null;
  readonly gitUrl: string | null;
  readonly createdAt: number;
  readonly resumeCount: number;
  readonly model: string | null;

  private _state: SessionState = "starting";
  private _cols: number;
  private _rows: number;
  private _pid: number | null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _exitCode: number | null = null;
  private _signal: number | null = null;
  private _seq = 0;
  private _lastActivity = Date.now();

  private readonly pty: PtyProcess;
  private readonly outputBufferBytes: number;
  private readonly chunks: OutputChunk[] = [];
  private _bufferedBytes = 0;
  private _droppedBytes = 0;

  private readonly listeners = new Set<SessionListener>();
  private disposed = false;
  private exitedPromise: Promise<void>;
  private resolveExited!: () => void;
  private ptyExited = false;
  /** Login terminals keep one wide size so tokens are never hard-wrapped. */
  fixedSize = false;

  constructor(options: SessionOptions) {
    this.createdAt = options.createdAt ?? Date.now();
    this.resumeCount = options.resumeCount ?? 0;
    this.model = options.model ?? null;
    this.id = options.id;
    this.userId = options.userId;
    this.provider = options.provider;
    this._title = options.title;
    this.cwd = options.cwd;
    this.projectCwd = options.projectCwd ?? null;
    this.projectId = options.projectId ?? null;
    this.worktreeId = options.worktreeId ?? null;
    this.branch = options.branch ?? null;
    this.gitUrl = options.gitUrl ?? null;
    this._cols = options.cols;
    this._rows = options.rows;
    this.outputBufferBytes = options.outputBufferBytes;
    this.pty = options.pty;
    this._pid = options.pty.pid ?? null;
    this.exitedPromise = new Promise((resolve) => { this.resolveExited = resolve; });

    this.pty.onData((data) => this.handleData(data));
    this.pty.onExit(({ exitCode, signal }) => {
      this.ptyExited = true;
      this.handleExit(exitCode, signal ?? null);
      this.resolveExited();
    });

    this._state = "running";
    this._startedAt = Date.now();
    this._lastActivity = this._startedAt;
  }

  get state(): SessionState {
    return this._state;
  }

  get title(): string {
    return this._title;
  }

  /** Update the display title from native CLI metadata without changing session identity. */
  setTitle(title: string): void {
    if (!title || title === this._title) return;
    this._title = title;
    this.emit({ type: "state", session: this.toSummary() });
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  get pid(): number | null {
    return this._pid;
  }

  get lastActivity(): number {
    return this._lastActivity;
  }

  /** Start of the current awake period (ms). */
  get startedAtMs(): number {
    return this._startedAt ?? this.createdAt;
  }

  get startedAt(): number | null {
    return this._startedAt;
  }

  get isAlive(): boolean {
    return this._state === "starting" || this._state === "running";
  }

  get hasExited(): boolean {
    return this.ptyExited;
  }

  whenExited(): Promise<void> {
    return this.exitedPromise;
  }

  private handleData(data: string): void {
    if (this.disposed) return;
    this._lastActivity = Date.now();
    const seq = ++this._seq;
    const bytes = Buffer.byteLength(data, "utf8");

    this.chunks.push({ seq, data, ts: this._lastActivity });
    this._bufferedBytes += bytes;

    while (this._bufferedBytes > this.outputBufferBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      const removedBytes = Buffer.byteLength(removed.data, "utf8");
      this._bufferedBytes -= removedBytes;
      this._droppedBytes += removedBytes;
    }

    this.emit({ type: "output", seq, data, ts: this._lastActivity });
  }

  private handleExit(exitCode: number, signal: number | null): void {
    if (this.disposed) return;
    this._endedAt = Date.now();
    this._exitCode = exitCode;
    this._signal = signal;
    this._state = exitCode === 0 ? "exited" : "failed";
    this._pid = null;
    log.info("session.exit", { sessionId: this.id, exitCode, signal });
    this.emit({ type: "exit", session: this.toSummary() });
  }

  private emit(frame: ServerFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        log.warn("session.listener_failed", {
          sessionId: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Push a frame to current subscribers (used by the manager for sleep notices). */
  broadcast(frame: ServerFrame): void {
    this.emit(frame);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Output retained in memory, oldest first. */
  replaySince(sinceSeq: number): { chunks: OutputChunk[]; truncatedBytes: number } {
    return {
      chunks: this.chunks.filter((chunk) => chunk.seq > sinceSeq),
      truncatedBytes: this._droppedBytes,
    };
  }

  write(data: string): void {
    if (!this.isAlive || this.disposed) return;
    this._lastActivity = Date.now();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.fixedSize) return;
    if (!this.isAlive || this.disposed) return;
    this._cols = cols;
    this._rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch (error) {
      log.debug("session.resize_failed", {
        sessionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  interrupt(): void {
    this.write("\u0003");
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isAlive || this.disposed) return;
    try {
      this.pty.kill(signal);
    } catch (error) {
      log.warn("session.kill_failed", {
        sessionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.kill("SIGTERM");
    this.disposed = true;
    this.listeners.clear();
  }

  /** Stop the PTY and wait for its process to exit before a same-ID session is resumed. */
  async disposeAndWait(graceMs = 5_000, killWaitMs = 2_000): Promise<boolean> {
    if (!this.disposed) this.kill("SIGTERM");
    let exited = await this.waitForExit(graceMs);
    if (!exited && !this.disposed) {
      try { this.pty.kill("SIGKILL"); } catch { /* The process may have exited while escalating. */ }
      exited = await this.waitForExit(killWaitMs);
    }
    this.disposed = true;
    this.listeners.clear();
    return exited;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.ptyExited || this._state === "exited" || this._state === "failed") return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exitedPromise.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  toSummary(): SessionSummary {
    return {
      id: this.id,
      provider: this.provider,
      title: this.title,
      state: this._state,
      cwd: this.cwd,
      projectCwd: this.projectCwd,
      projectId: this.projectId,
      worktreeId: this.worktreeId,
      branch: this.branch,
      gitUrl: this.gitUrl,
      cols: this._cols,
      rows: this._rows,
      createdAt: new Date(this.createdAt).toISOString(),
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : null,
      endedAt: this._endedAt ? new Date(this._endedAt).toISOString() : null,
      exitCode: this._exitCode,
      signal: this._signal,
      pid: this._pid,
      seq: this._seq,
      bufferedBytes: this._bufferedBytes,
      droppedBytes: this._droppedBytes,
      resumeCount: this.resumeCount,
      sleepReason: null,
      model: this.model,
    };
  }
}
