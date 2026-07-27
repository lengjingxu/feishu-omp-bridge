interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function welcomeCard(): object {
  return shell('👋 Codex 项目助手', [
    divMd('欢迎使用 Codex 项目助手。你可以选择本地项目、恢复已有会话，并在飞书话题中直接用中文协作。'),
    HR,
    actions([
      { text: '📁 选择项目', value: { cmd: 'projects' }, style: 'primary' },
      { text: '🔗 已绑定项目', value: { cmd: 'projects.bound' } },
      { text: '📡 连接状态', value: { cmd: 'status' } },
      { text: '💡 使用帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface ProjectCardInfo {
  projectKey: string;
  name: string;
  cwd: string;
  hostId?: string;
  chatId?: string;
}

export function projectsCard(projects: ProjectCardInfo[], page = 0, pageSize = 6): object {
  const start = page * pageSize;
  const pageItems = projects.slice(start, start + pageSize);
  const elements: object[] = [divMd(projects.length ? `共 **${projects.length}** 个项目，选择一个开始：` : '暂时没有可用项目。请在 Bridge 配置中添加项目目录。')];
  for (const project of pageItems) {
    elements.push(HR, divMd(`**${escapeMd(project.name)}**${project.chatId ? '  ✅ 已绑定群' : ''}\n\`${escapeCode(project.cwd)}\`\n主机：${escapeMd(project.hostId ?? '本机')}`));
    elements.push(actions([
      { text: project.chatId ? '打开项目群' : '创建项目群', value: { cmd: 'project.open', arg: project.projectKey }, style: 'primary' },
      { text: '查看会话', value: { cmd: 'project.sessions', arg: project.projectKey } },
    ]));
  }
  const nav: ButtonSpec[] = [];
  if (page > 0) nav.push({ text: '上一页', value: { cmd: 'projects.page', arg: String(page - 1) } });
  if (start + pageSize < projects.length) nav.push({ text: '下一页', value: { cmd: 'projects.page', arg: String(page + 1) } });
  if (nav.length) elements.push(HR, actions(nav));
  return shell('📁 本地项目', elements);
}

export interface ProjectWelcomeInfo { name: string; cwd: string; }

export function projectWelcomeCard(info: ProjectWelcomeInfo): object {
  return shell('📁 项目已连接', [
    divMd(`项目：**${escapeMd(info.name)}**\n路径：\`${escapeCode(info.cwd)}\`\n\n请选择要继续的操作：`),
    actions([
      { text: '📚 查看会话', value: { cmd: 'sessions' }, style: 'primary' },
      { text: '🆕 新建会话', value: { cmd: 'session.new' }, style: 'primary' },
      { text: '📊 项目状态', value: { cmd: 'project.status' } },
      { text: '🔁 切换项目', value: { cmd: 'projects' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export interface SessionCardInfo {
  threadId: string;
  name?: string;
  preview: string;
  status: string;
  activeFlags?: string[];
  source?: string;
  forkedFromId?: string;
  gitBranch?: string;
  updatedAt: number;
}

export function sessionsCard(projectName: string, sessions: SessionCardInfo[], nextCursor?: string): object {
  const elements: object[] = [divMd(`项目：**${escapeMd(projectName)}**\n选择一个会话，Bridge 会自动为它创建一个飞书话题。`)];
  if (sessions.length === 0) elements.push(HR, divMd('暂无可恢复的会话。可以直接新建一个。'));
  for (const session of sessions) {
    const title = session.name?.trim() || session.preview.slice(0, 40) || '未命名会话';
    const status = sessionStatusText(session.status, session.activeFlags);
    const metadata = [
      `状态：${status}`,
      formatRelative(session.updatedAt),
      session.source ? `来源：${sourceText(session.source)}` : '',
      session.forkedFromId ? '分支会话' : '',
      session.gitBranch ? `分支：${escapeMd(session.gitBranch)}` : '',
    ].filter(Boolean).join(' · ');
    elements.push(HR, divMd(`**${escapeMd(title)}**\n${escapeMd(session.preview.slice(0, 120))}\n${metadata}`));
    elements.push(actions([
      { text: '继续此会话', value: { cmd: 'session.open', arg: session.threadId }, style: 'primary' },
      { text: '查看详情', value: { cmd: 'session.detail', arg: session.threadId } },
      { text: '归档', value: { cmd: 'session.archive', arg: session.threadId }, style: 'danger' },
    ]));
  }
  const footer: ButtonSpec[] = [
    { text: '🆕 新建会话', value: { cmd: 'session.new' }, style: 'primary' },
    { text: '🔄 刷新列表', value: { cmd: 'sessions' } },
  ];
  if (nextCursor) footer.splice(1, 0, { text: '加载更多', value: { cmd: 'sessions.page', arg: nextCursor } });
  elements.push(HR, actions(footer));
  return shell('📚 Codex 会话', elements);
}

function sessionStatusText(status: string, activeFlags: string[] | undefined): string {
  if (activeFlags?.includes('waitingOnApproval')) return '等待确认';
  if (activeFlags?.includes('waitingOnUserInput')) return '等待输入';
  if (status === 'active') return '执行中';
  if (status === 'archived') return '已归档';
  return '空闲';
}

function sourceText(source: string): string {
  if (source === 'cli') return 'Codex 命令行';
  if (source === 'vscode') return 'VS Code';
  if (source === 'appServer') return 'Codex 应用服务';
  if (source === 'exec') return '自动执行';
  if (source === 'subAgent') return '子代理';
  return source;
}

export function topicWelcomeCard(projectName: string, sessionTitle: string, cwd: string): object {
  return shell('✅ 会话已连接', [
    divMd(`项目：**${escapeMd(projectName)}**\n会话：**${escapeMd(sessionTitle)}**\n工作目录：\`${escapeCode(cwd)}\`\n\n现在可以直接在这个话题中输入中文需求。`),
    actions([
      { text: '📊 查看状态', value: { cmd: 'status' } },
      { text: '⏹ 停止任务', value: { cmd: 'stop' }, style: 'danger' },
      { text: '📚 切换会话', value: { cmd: 'sessions' } },
      { text: '🆕 新建会话', value: { cmd: 'session.new' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

function formatRelative(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置，使用 $HOME)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作空间。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作空间'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  return shell('📂 工作空间', elements);
}

export interface StatusInfo {
  cwd: string;
  sessionId?: string;
  sessionStale: boolean;
  agentName: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
  projectName?: string;
  sessionTitle?: string;
  hideInternalIds?: boolean;
}

export function statusCard(info: StatusInfo): object {
  if (info.hideInternalIds) {
    return shell('📊 当前状态', [
      divMd([
        info.projectName ? `📁 项目：**${escapeMd(info.projectName)}**` : '',
        `📂 工作目录：\`${escapeCode(info.cwd)}\``,
        info.sessionTitle ? `💬 当前会话：**${escapeMd(info.sessionTitle)}**` : '💬 当前会话：尚未绑定',
        `🤖 助手：${escapeMd(info.agentName)}`,
      ].filter(Boolean).join('\n')),
      HR,
      actions([
        { text: '📚 查看会话', value: { cmd: 'sessions' }, style: 'primary' },
        { text: '🆕 新建会话', value: { cmd: 'session.new' } },
        { text: '💡 使用帮助', value: { cmd: 'help' } },
      ]),
    ]);
  }
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : '(无)';
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `📁 **cwd**: \`${escapeCode(info.cwd)}\``,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '📂 工作空间', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
    ]),
  ]);
}

export function helpCard(): object {
  return shell('💡 使用帮助', [
    divMd(
      [
        '**推荐用法**',
        '',
        '在私聊中点击“选择项目”，然后在项目群里点击“查看会话”。',
        '选择或新建会话后，进入自动创建的话题，直接输入中文需求即可。',
        '',
        '运行中的任务可以点击卡片上的“停止任务”；需要授权时，直接点击中文确认按钮。',
        '',
        '**高级入口**',
        '也可以发送 `/projects`、`/sessions`、`/status`、`/stop`、`/new`。',
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '📁 选择项目', value: { cmd: 'projects' } },
      { text: '🆕 新会话', value: { cmd: 'session.new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
