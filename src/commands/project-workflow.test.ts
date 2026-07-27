import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../bot/active-runs';
import type { CommandContext } from './index';
import { runCommandHandler, tryHandleCommand } from './index';
import { JsonProjectBindingStore } from '../project/store';
import type { Project } from '../project/types';
import type { SessionSummary } from '../project/types';
import { SessionStore } from '../session/store';
import { WorkspaceStore } from '../workspace/store';

const project: Project = {
  projectKey: 'local::/tmp/demo',
  name: 'demo',
  cwd: '/tmp/demo',
  hostId: 'local',
};

function context(channel: unknown, bindings: JsonProjectBindingStore, content = ''): CommandContext {
  return {
    channel: channel as CommandContext['channel'],
    msg: {
      messageId: 'message-1', chatId: 'chat-dm', chatType: 'p2p', senderId: 'user-1',
      senderName: '用户', content, rawContentType: 'text', resources: [], mentions: [],
      mentionAll: false, mentionedBot: false, createTime: Date.now(),
    },
    scope: 'chat-dm',
    chatMode: 'p2p',
    sessions: new SessionStore(join('/tmp', `feishu-command-test-${Date.now()}.json`)),
    workspaces: new WorkspaceStore(join('/tmp', `feishu-workspace-test-${Date.now()}.json`)),
    agent: { id: 'codex', displayName: 'Codex', isAvailable: async () => true, run: vi.fn() } as never,
    activeRuns: new ActiveRuns(),
    controls: {
      cfg: { accounts: { app: { id: 'app-1', secret: 'secret', tenant: 'feishu' } } },
      configPath: '/tmp/config.json', processId: 'process-1',
      restart: async () => {}, exit: async () => {},
    },
    projectCatalog: { list: async () => [project], get: async (key: string) => key === project.projectKey ? project : undefined },
    projectBindings: bindings,
  };
}

describe('Codex project command workflow', () => {
  it('maps Chinese shortcut words to the project card', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    const ctx = context({ send }, bindings, '项目');
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith('chat-dm', { card: expect.any(Object) }, { replyTo: 'message-1' });
  });

  it('does not create a second project group after a repeated click', async () => {
    const create = vi.fn().mockResolvedValue({ data: { chat_id: 'chat-project' } });
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    bindings.registerProjects([project]);
    const channel = { rawClient: { im: { v1: { chat: { create } } } }, send };
    const ctx = context(channel, bindings);
    await runCommandHandler('project', `open ${project.projectKey}`, ctx);
    await runCommandHandler('project', `open ${project.projectKey}`, ctx);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-dm', expect.objectContaining({ markdown: expect.stringContaining('已经绑定') }), expect.any(Object));
  });

  it('orders projects by their latest non-archived Codex session', async () => {
    const older: Project = { projectKey: 'local::/tmp/older', name: 'older', cwd: '/tmp/older', hostId: 'local' };
    const recent: Project = { projectKey: 'local::/tmp/recent', name: 'recent', cwd: '/tmp/recent', hostId: 'local' };
    const send = vi.fn().mockResolvedValue({ messageId: 'message-2' });
    const bindings = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-command-test-')), 'bindings.json'));
    const ctx = context({ send }, bindings, '项目');
    ctx.projectCatalog = {
      list: async () => [older, recent],
      get: async (key: string) => [older, recent].find((item) => item.projectKey === key),
    };
    ctx.agent = {
      ...ctx.agent,
      listRecentSessions: async (): Promise<SessionSummary[]> => [
        { threadId: 'recent-thread', preview: '最近会话', cwd: recent.cwd, status: 'idle', updatedAt: 200 },
        { threadId: 'archived-thread', preview: '归档会话', cwd: older.cwd, status: 'archived', updatedAt: 300 },
        { threadId: 'old-thread', preview: '旧会话', cwd: older.cwd, status: 'idle', updatedAt: 100 },
      ],
    };

    await runCommandHandler('projects', '', ctx);

    const cardText = JSON.stringify(send.mock.calls[0]?.[1]?.card);
    expect(cardText.indexOf('recent')).toBeGreaterThanOrEqual(0);
    expect(cardText.indexOf('older')).toBeGreaterThanOrEqual(0);
    expect(cardText.indexOf('recent')).toBeLessThan(cardText.indexOf('older'));
  });
});
