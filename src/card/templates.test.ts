import { describe, expect, it } from 'vitest';
import { projectWelcomeCard, projectsCard, sessionsCard, topicWelcomeCard, welcomeCard } from './templates';

function text(card: object): string {
  return JSON.stringify(card);
}

describe('project-first Feishu cards', () => {
  it('renders a Chinese welcome card with action buttons', () => {
    const rendered = text(welcomeCard());
    expect(rendered).toContain('选择项目');
    expect(rendered).toContain('使用帮助');
    expect(rendered).not.toContain('chat_id');
  });

  it('renders empty and populated project/session states', () => {
    expect(text(projectsCard([]))).toContain('暂时没有可用项目');
    expect(text(projectsCard([{ projectKey: 'p1', name: '示例项目', cwd: '/tmp/demo', hostId: '本机' }]))).toContain('创建项目群');
    expect(text(sessionsCard('示例项目', []))).toContain('新建会话');
    const sessions = text(sessionsCard('示例项目', [{ threadId: 'thread-1', preview: '修复卡片', status: 'idle', updatedAt: Date.now() }], 'cursor-2'));
    expect(sessions).toContain('继续此会话');
    expect(sessions).toContain('加载更多');
    expect(sessions).toContain('归档');
    const metadata = text(sessionsCard('示例项目', [{ threadId: 'thread-2', preview: '等待输入', status: 'active', activeFlags: ['waitingOnUserInput'], source: 'vscode', forkedFromId: 'thread-0', updatedAt: Date.now() }]));
    expect(metadata).toContain('等待输入');
    expect(metadata).toContain('VS Code');
    expect(metadata).toContain('分支会话');
  });

  it('renders project and topic context without exposing internal ids', () => {
    const project = text(projectWelcomeCard({ name: '示例项目', cwd: '/tmp/demo' }));
    const topic = text(topicWelcomeCard('示例项目', '修复卡片', '/tmp/demo'));
    expect(project).toContain('项目已连接');
    expect(topic).toContain('会话已连接');
    expect(topic).not.toContain('thread_id');
  });
});
