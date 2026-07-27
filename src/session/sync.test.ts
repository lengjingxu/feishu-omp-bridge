import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSyncManager } from './sync';
import type { SessionDetail } from '../project/types';

const detail = (updatedAt: number): SessionDetail => ({
  threadId: 'thread-1', preview: '最新进度', cwd: '/tmp/project', status: 'active', updatedAt,
  turnCount: 2, recentActivity: [{ kind: '助手', text: `进度 ${updatedAt}` }],
});

describe('SessionSyncManager', () => {
  afterEach(() => vi.useRealTimers());

  it('only updates when persisted content changes', async () => {
    vi.useFakeTimers();
    const manager = new SessionSyncManager();
    const reader = vi.fn().mockResolvedValue(detail(1));
    const updater = vi.fn().mockResolvedValue(undefined);
    manager.start('chat:topic', reader, updater, { intervalMs: 2_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(updater).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(updater).toHaveBeenCalledTimes(1);

    reader.mockResolvedValue(detail(2));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(updater).toHaveBeenCalledTimes(2);
    manager.stopAll();
  });

  it('stops polling and does not schedule another read', async () => {
    vi.useFakeTimers();
    const manager = new SessionSyncManager();
    const reader = vi.fn().mockResolvedValue(detail(1));
    const updater = vi.fn().mockResolvedValue(undefined);
    manager.start('chat:topic', reader, updater, { intervalMs: 2_000 });
    await Promise.resolve();
    await Promise.resolve();
    manager.stop('chat:topic');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(manager.isRunning('chat:topic')).toBe(false);
  });
});
