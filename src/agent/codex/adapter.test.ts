import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAdapter } from './adapter';
import type { AgentEvent } from '../types';

async function fakeCodex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const path = join(dir, 'codex-fake.mjs');
  await writeFile(path, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => console.log(JSON.stringify(value));
let activeThreadId = 'thread-new';
for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/list') send({ id: msg.id, result: { data: [{ id: 'thread-existing', name: '旧会话', preview: '修复卡片', cwd: '/tmp/project', updatedAt: 10, status: { type: 'idle' } }], nextCursor: msg.params.cursor ? null : 'cursor-2', backwardsCursor: null } });
  if (msg.method === 'model/list') send({ id: msg.id, result: { data: [{ model: 'gpt-5.6-sol', isDefault: true }] } });
  if (msg.method === 'thread/start') { activeThreadId = 'thread-new'; send({ id: msg.id, result: { thread: { id: 'thread-new', name: null, preview: '', cwd: '/tmp/project' } } }); }
  if (msg.method === 'thread/resume') {
    if (msg.params.threadId === 'missing-rollout') send({ id: msg.id, error: { code: -32000, message: 'no rollout found for thread id missing-rollout' } });
    else { activeThreadId = msg.params.threadId; send({ id: msg.id, result: { thread: { id: msg.params.threadId, cwd: '/tmp/project' } } }); }
  }
  if (msg.method === 'thread/read') send({ id: msg.id, result: { thread: { id: msg.params.threadId, sessionId: 'session-1', name: '详情会话', preview: '查看详情', cwd: '/tmp/project', updatedAt: 20, status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, source: 'vscode', turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: '请查看', text_elements: [] }] }, { type: 'agentMessage', text: '正在查看' }, { type: 'commandExecution', command: 'pnpm test' }] }] } } });
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
    if (activeThreadId === 'legacy-compact') {
      send({ method: 'error', params: { threadId: activeThreadId, error: { message: 'Error running remote compact task: model requires a newer version of Codex' } } });
      continue;
    }
    send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId: 'turn-1', itemId: 'item-1', delta: '完成' } });
    send({ method: 'turn/completed', params: { threadId: activeThreadId, turn: { id: 'turn-1', status: 'completed' } } });
  }
  if (msg.method === 'turn/interrupt') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/archive') send({ id: msg.id, result: {} });
}
`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('CodexAdapter', () => {
  it('lists sessions by project cwd', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    await expect(adapter.isAvailable()).resolves.toBe(true);
    await expect(adapter.listSessions('/tmp/project')).resolves.toEqual([{
      threadId: 'thread-existing',
      name: '旧会话',
      preview: '修复卡片',
      cwd: '/tmp/project',
      status: 'idle',
      updatedAt: 10_000,
    }]);
    await expect(adapter.listSessionPage?.('/tmp/project')).resolves.toMatchObject({ nextCursor: 'cursor-2' });
    await expect(adapter.listProjectRoots?.()).resolves.toEqual(['/tmp/project']);
    await expect(adapter.readSession?.('thread-existing')).resolves.toMatchObject({
      sessionId: 'session-1',
      source: 'vscode',
      turnCount: 1,
      recentActivity: [
        { kind: '用户', text: '请查看' },
        { kind: '助手', text: '正在查看' },
        { kind: '工具', text: 'pnpm test' },
      ],
    });
    await expect(adapter.archiveSession?.('thread-existing')).resolves.toBeUndefined();
    await adapter.close();
  });

  it('starts a thread and translates app-server events', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '请测试', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project', model: undefined },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('starts a replacement thread when an empty thread has no rollout to resume', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'missing-rollout', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'ui_notice', message: '原 Codex 会话没有可恢复的执行记录，已自动新建会话。', level: 'warning' },
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project', model: 'gpt-5.6-sol' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });

  it('resumes historical threads with the current app-server default model', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'thread-existing', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'thread-existing', cwd: '/tmp/project', model: 'gpt-5.6-sol' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-existing' },
    ]);
    await adapter.close();
  });

  it('replaces a historical thread when its model cannot compact', async () => {
    const adapter = new CodexAdapter({ binary: await fakeCodex() });
    const run = adapter.run({ prompt: '继续处理', sessionId: 'legacy-compact', cwd: '/tmp/project' });
    await expect(collect(run.events)).resolves.toEqual([
      { type: 'system', sessionId: 'legacy-compact', cwd: '/tmp/project', model: 'gpt-5.6-sol' },
      { type: 'ui_notice', message: '原 Codex 会话使用了当前设备不兼容的配置，已自动新建会话并重试。', level: 'warning' },
      { type: 'system', sessionId: 'thread-new', cwd: '/tmp/project' },
      { type: 'text', delta: '完成' },
      { type: 'done', sessionId: 'thread-new' },
    ]);
    await adapter.close();
  });
});
