import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import type { Project, ProjectBindingStore, TopicBinding } from './types';

interface ProjectBindingData {
  version: 1;
  projects: Record<string, Project>;
  topics: Record<string, TopicBinding>;
}

const emptyData = (): ProjectBindingData => ({ version: 1, projects: {}, topics: {} });

export class JsonProjectBindingStore implements ProjectBindingStore {
  private data = emptyData();
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.projectBindingsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ProjectBindingData>;
      this.data = {
        version: 1,
        projects: parsed.projects ?? {},
        topics: parsed.topics ?? {},
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async bindProject(projectKey: string, chatId: string): Promise<void> {
    const current = this.data.projects[projectKey];
    if (!current) throw new Error(`project not found: ${projectKey}`);
    const existing = Object.values(this.data.projects).find((project) => project.chatId === chatId && project.projectKey !== projectKey);
    if (existing) throw new Error(`chat already belongs to project: ${existing.projectKey}`);
    this.data.projects[projectKey] = { ...current, chatId };
    this.schedulePersist();
  }

  registerProjects(projects: Project[]): void {
    for (const project of projects) {
      const existing = this.data.projects[project.projectKey];
      this.data.projects[project.projectKey] = { ...project, chatId: existing?.chatId };
    }
    this.schedulePersist();
  }

  async bindTopic(binding: TopicBinding): Promise<void> {
    const key = topicKey(binding.chatId, binding.topicId);
    const current = this.data.topics[key];
    if (current && current.codexThreadId !== binding.codexThreadId) {
      throw new Error(`topic already belongs to session: ${current.codexThreadId}`);
    }
    const other = Object.values(this.data.topics).find((topic) => topic.codexThreadId === binding.codexThreadId && topicKey(topic.chatId, topic.topicId) !== key);
    if (other) throw new Error(`session already belongs to topic: ${topicKey(other.chatId, other.topicId)}`);
    this.data.topics[key] = binding;
    this.schedulePersist();
  }

  async updateTopicSession(chatId: string, topicId: string, codexThreadId: string): Promise<void> {
    const key = topicKey(chatId, topicId);
    const current = this.data.topics[key];
    if (!current) throw new Error(`topic not found: ${key}`);
    const other = Object.values(this.data.topics).find((topic) => topic.codexThreadId === codexThreadId && topicKey(topic.chatId, topic.topicId) !== key);
    if (other) throw new Error(`session already belongs to topic: ${topicKey(other.chatId, other.topicId)}`);
    this.data.topics[key] = { ...current, codexThreadId, updatedAt: Date.now() };
    this.schedulePersist();
  }

  findProjectByChat(chatId: string): Project | undefined {
    return Object.values(this.data.projects).find((project) => project.chatId === chatId);
  }

  findTopic(chatId: string, topicId: string): TopicBinding | undefined {
    return this.data.topics[topicKey(chatId, topicId)];
  }

  findTopicByThread(threadId: string): TopicBinding | undefined {
    return Object.values(this.data.topics).find((topic) => topic.codexThreadId === threadId);
  }

  projectFor(projectKey: string): Project | undefined {
    return this.data.projects[projectKey];
  }

  topicsForProject(projectKey: string): TopicBinding[] {
    return Object.values(this.data.topics).filter((topic) => topic.projectKey === projectKey);
  }

  async clearTopic(chatId: string, topicId: string): Promise<void> {
    delete this.data.topics[topicKey(chatId, topicId)];
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      await rename(temp, this.path);
    }).catch((err) => log.fail('project', err, { step: 'persist' }));
  }
}

function topicKey(chatId: string, topicId: string): string {
  return `${chatId}:${topicId}`;
}
