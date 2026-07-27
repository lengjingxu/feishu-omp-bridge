export interface Project {
  projectKey: string;
  name: string;
  cwd: string;
  hostId?: string;
  chatId?: string;
}

export interface SessionSummary {
  threadId: string;
  sessionId?: string;
  forkedFromId?: string;
  parentThreadId?: string;
  name?: string;
  preview: string;
  cwd: string;
  status: 'idle' | 'active' | 'archived';
  activeFlags?: string[];
  source?: string;
  gitBranch?: string;
  updatedAt: number;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor?: string;
}

export interface SessionActivity {
  kind: '用户' | '助手' | '计划' | '工具' | '文件';
  text: string;
}

export interface SessionDetail extends SessionSummary {
  turnCount: number;
  recentActivity: SessionActivity[];
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
  updateTopicSession(chatId: string, topicId: string, codexThreadId: string): Promise<void>;
  findProjectByChat(chatId: string): Project | undefined;
  findTopic(chatId: string, topicId: string): TopicBinding | undefined;
  findTopicByThread(threadId: string): TopicBinding | undefined;
  projectFor(projectKey: string): Project | undefined;
  topicsForProject(projectKey: string): TopicBinding[];
  clearTopic(chatId: string, topicId: string): Promise<void>;
  flush(): Promise<void>;
}
