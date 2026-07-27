import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonProjectBindingStore } from './store';
import type { Project } from './types';

const project: Project = {
  projectKey: 'local::/tmp/demo',
  name: 'demo',
  cwd: '/tmp/demo',
  hostId: 'local',
};

describe('JsonProjectBindingStore', () => {
  it('persists project and topic bindings and reloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-project-store-'));
    const path = join(dir, 'bindings.json');
    const store = new JsonProjectBindingStore(path);
    await store.load();
    store.registerProjects?.([project]);
    await store.bindProject(project.projectKey, 'chat-1');
    await store.bindTopic({
      chatId: 'chat-1',
      topicId: 'topic-1',
      projectKey: project.projectKey,
      codexThreadId: 'thread-1',
      createdBy: 'user-1',
      updatedAt: 1,
    });
    await store.flush();

    const reloaded = new JsonProjectBindingStore(path);
    await reloaded.load();
    expect(reloaded.findProjectByChat('chat-1')?.projectKey).toBe(project.projectKey);
    expect(reloaded.findTopic('chat-1', 'topic-1')?.codexThreadId).toBe('thread-1');
    expect(reloaded.findTopicByThread('thread-1')?.topicId).toBe('topic-1');
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  });

  it('rejects binding a session to two topics', async () => {
    const store = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-project-store-')), 'bindings.json'));
    store.registerProjects?.([project]);
    await store.bindProject(project.projectKey, 'chat-1');
    await store.bindTopic({ chatId: 'chat-1', topicId: 'topic-1', projectKey: project.projectKey, codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 1 });
    await expect(store.bindTopic({ chatId: 'chat-1', topicId: 'topic-2', projectKey: project.projectKey, codexThreadId: 'thread-1', createdBy: 'user-1', updatedAt: 2 })).rejects.toThrow('session already belongs');
  });

  it('updates a topic binding when app-server replaces an empty session', async () => {
    const store = new JsonProjectBindingStore(join(await mkdtemp(join(tmpdir(), 'feishu-project-store-')), 'bindings.json'));
    store.registerProjects([project]);
    await store.bindTopic({ chatId: 'chat-1', topicId: 'topic-1', projectKey: project.projectKey, codexThreadId: 'thread-old', createdBy: 'user-1', updatedAt: 1 });
    await store.updateTopicSession('chat-1', 'topic-1', 'thread-new');
    expect(store.findTopic('chat-1', 'topic-1')?.codexThreadId).toBe('thread-new');
  });
});
