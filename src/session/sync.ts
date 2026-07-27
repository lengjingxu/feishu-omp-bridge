import type { SessionDetail } from '../project/types';

export type SessionSyncReader = () => Promise<SessionDetail>;
export type SessionSyncUpdater = (detail: SessionDetail) => Promise<void>;
export type SessionSyncErrorHandler = (error: unknown) => void;

interface SyncEntry {
  reader: SessionSyncReader;
  updater: SessionSyncUpdater;
  onError?: SessionSyncErrorHandler;
  intervalMs: number;
  timer?: NodeJS.Timeout;
  running: boolean;
  fingerprint?: string;
}

/** Poll persisted Codex state without starting or steering a turn. */
export class SessionSyncManager {
  private readonly entries = new Map<string, SyncEntry>();

  async refresh(
    reader: SessionSyncReader,
    updater: SessionSyncUpdater,
  ): Promise<SessionDetail> {
    const detail = await reader();
    await updater(detail);
    return detail;
  }

  start(
    scope: string,
    reader: SessionSyncReader,
    updater: SessionSyncUpdater,
    options: { intervalMs?: number; onError?: SessionSyncErrorHandler } = {},
  ): void {
    this.stop(scope);
    const entry: SyncEntry = {
      reader,
      updater,
      onError: options.onError,
      intervalMs: Math.max(2_000, options.intervalMs ?? 5_000),
      running: false,
    };
    this.entries.set(scope, entry);
    void this.tick(scope, entry);
  }

  stop(scope: string): boolean {
    const entry = this.entries.get(scope);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(scope);
    return true;
  }

  isRunning(scope: string): boolean {
    return this.entries.has(scope);
  }

  stopAll(): void {
    for (const scope of this.entries.keys()) this.stop(scope);
  }

  private async tick(scope: string, entry: SyncEntry): Promise<void> {
    if (this.entries.get(scope) !== entry) return;
    if (!entry.running) {
      entry.running = true;
      try {
        const detail = await entry.reader();
        const fingerprint = fingerprintDetail(detail);
        if (this.entries.get(scope) === entry && fingerprint !== entry.fingerprint) {
          entry.fingerprint = fingerprint;
          await entry.updater(detail);
        }
      } catch (error) {
        entry.onError?.(error);
      } finally {
        entry.running = false;
      }
    }
    if (this.entries.get(scope) !== entry) return;
    entry.timer = setTimeout(() => void this.tick(scope, entry), entry.intervalMs);
  }
}

function fingerprintDetail(detail: SessionDetail): string {
  const latest = detail.recentActivity.slice(-3).map((item) => `${item.kind}:${item.text}`).join('|');
  return [detail.threadId, detail.updatedAt, detail.status, detail.activeFlags?.join(','), detail.turnCount, latest].join('\u0000');
}
