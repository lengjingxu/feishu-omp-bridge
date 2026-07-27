export interface Project {
  projectKey: string;
  name: string;
  cwd: string;
  hostId?: string;
  chatId?: string;
}

export interface SessionSummary {
  threadId: string;
  name?: string;
  preview: string;
  cwd: string;
  status: 'idle' | 'active' | 'archived';
  updatedAt: number;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor?: string;
}

export interface TopicBinding {
  chatId: string;
  topicId: string;
  projectKey: string;
  codexThreadId: string;
  createdBy: string;
  updatedAt: number;
}

export interface ProjectBindingStore {
  registerProjects?(projects: Project[]): void;
  bindProject(projectKey: string, chatId: string): Promise<void>;
  bindTopic(binding: TopicBinding): Promise<void>;
  findProjectByChat(chatId: string): Project | undefined;
  findTopic(chatId: string, topicId: string): TopicBinding | undefined;
  findTopicByThread(threadId: string): TopicBinding | undefined;
  projectFor(projectKey: string): Project | undefined;
  topicsForProject(projectKey: string): TopicBinding[];
  clearTopic(chatId: string, topicId: string): Promise<void>;
  flush(): Promise<void>;
}
