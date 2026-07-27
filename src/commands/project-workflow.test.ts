import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../bot/active-runs';
import type { CommandContext } from './index';
import { runCommandHandler, tryHandleCommand } from './index';
import { JsonProjectBindingStore } from '../project/store';
import type { Project } from '../project/types';
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
});
