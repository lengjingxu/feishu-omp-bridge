import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, AgentUiResponse } from '../types';
import { log } from '../../core/logger';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './app-server';
import type { SessionActivity, SessionDetail, SessionPage, SessionSummary } from '../../project/types';

interface QueueValue<T> { value?: T; done?: boolean }

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingUi {
  requestId: string | number;
  method: string;
  questionId?: string;
}

export interface CodexAdapterOptions {
  binary?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  private readonly client: CodexAppServerClient;
  private defaultModel?: string;
  private defaultModelPromise?: Promise<string | undefined>;

  constructor(opts: CodexAdapterOptions = {}) {
    this.client = new CodexAppServerClient(opts.binary);
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Historical threads retain the model they were created with.  Resolve the
   * current app-server default before resuming one so an old/incompatible
   * model does not keep breaking an otherwise healthy device configuration.
   */
  private async resolveDefaultModel(): Promise<string | undefined> {
    if (this.defaultModel) return this.defaultModel;
    if (!this.defaultModelPromise) {
      this.defaultModelPromise = this.client.request<{
        data?: Array<{ model?: unknown; isDefault?: unknown }>;
      }>('model/list', {}).then((response) => {
        const model = response.data?.find((entry) => entry.isDefault === true && typeof entry.model === 'string')?.model;
        if (typeof model === 'string' && model.trim()) {
          this.defaultModel = model.trim();
          return this.defaultModel;
        }
        return undefined;
      }).catch((err) => {
        log.warn('codex', 'default-model-unavailable', { error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }).finally(() => {
        this.defaultModelPromise = undefined;
      });
    }
    return this.defaultModelPromise;
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    return (await this.listSessionPage(cwd)).sessions;
  }

  /**
   * Fetch the recent session index once for project-level views. Calling
   * thread/list once per project makes a large project picker feel hung.
   */
  async listRecentSessions(): Promise<SessionSummary[]> {
    const sessions: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/list', {
        limit: 100,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'],
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of response.data ?? []) {
        const session = mapThread(thread, '');
        if (session?.cwd) sessions.push(session);
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return sessions;
  }

  async listSessionPage(cwd: string, cursor?: string): Promise<SessionPage> {
    const response = await this.client.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/list', {
      cwd,
      limit: 50,
      archived: false,
      sourceKinds: ['cli', 'vscode', 'appServer'],
      sortKey: 'updated_at',
      sortDirection: 'desc',
      useStateDbOnly: true,
      ...(cursor ? { cursor } : {}),
    });
    const sessions = (response.data ?? []).map((thread) => mapThread(thread, cwd)).filter((session): session is SessionSummary => session !== undefined);
    return { sessions, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) };
  }

  async readSession(threadId: string): Promise<SessionDetail> {
    const response = await this.client.request<{ thread?: Record<string, unknown> }>('thread/read', {
      threadId,
      includeTurns: true,
    });
    const thread = response.thread;
    if (!thread) throw new Error('Codex app-server did not return the session');
    const summary = mapThread(thread, typeof thread.cwd === 'string' ? thread.cwd : '');
    if (!summary) throw new Error('Codex app-server returned an invalid session');
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const recentActivity = turns.flatMap((turn) => {
      const items = turn && typeof turn === 'object' && Array.isArray((turn as { items?: unknown[] }).items)
        ? (turn as { items: unknown[] }).items
        : [];
      return items.map(summarizeActivity).filter((item): item is SessionActivity => item !== undefined);
    }).slice(-8);
    return { ...summary, turnCount: turns.length, recentActivity };
  }

  async listProjectRoots(): Promise<string[]> {
    const roots = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.client.request<{
        data?: Array<Record<string, unknown>>;
        nextCursor?: string | null;
      }>('thread/list', {
        limit: 100,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'appServer'],
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      for (const thread of response.data ?? []) {
        if (typeof thread.cwd === 'string' && thread.cwd.trim()) roots.add(thread.cwd);
      }
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return [...roots];
  }

  async createSession(cwd: string): Promise<SessionSummary> {
    const response = await this.client.request<{ thread?: Record<string, unknown> }>('thread/start', { cwd });
    const thread = response.thread;
    const threadId = String(thread?.id ?? '');
    if (!threadId) throw new Error('Codex app-server did not return a new session id');
    return {
      threadId,
      name: typeof thread?.name === 'string' ? thread.name : undefined,
      preview: typeof thread?.preview === 'string' ? thread.preview : '新建会话',
      cwd,
      status: 'idle',
      updatedAt: Date.now(),
    };
  }

  async archiveSession(threadId: string): Promise<void> {
    await this.client.request('thread/archive', { threadId });
  }

  run(opts: AgentRunOptions): AgentRun {
    const client = this.client;
    const queue = new AsyncQueue<AgentEvent>();
    const pendingUi = new Map<string, PendingUi>();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let effectiveModel: string | undefined;
    let replacementStarted = false;
    let stopped = false;
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeRequests: (() => void) | undefined;
    let exitResolve!: () => void;
    const exited = new Promise<void>((resolve) => { exitResolve = resolve; });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      unsubscribeRequests?.();
      queue.close();
      exitResolve();
    };

    const isHistoricalCompatibilityFailure = (message: string): boolean => {
      if (!opts.sessionId || replacementStarted) return false;
      return /requires a newer version of Codex|unsupported service_tier|unknown variant|remote compact task|pre-sampling compact/i.test(message);
    };

    const replaceHistoricalSession = (reason: string): boolean => {
      if (!isHistoricalCompatibilityFailure(reason)) return false;
      replacementStarted = true;
      queue.push({ type: 'ui_notice', message: '原 Codex 会话使用了当前设备不兼容的配置，已自动新建会话并重试。', level: 'warning' });
      void (async () => {
        try {
          const replacement = await client.request<{ id?: string; thread?: { id?: string } }>('thread/start', {
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
          });
          threadId = replacement.thread?.id ?? replacement.id;
          if (!threadId) throw new Error('Codex app-server did not return a replacement thread id');
          turnId = undefined;
          queue.push({ type: 'system', sessionId: threadId, cwd: opts.cwd });
          const turn = await client.request<{ id?: string; turn?: { id?: string } }>('turn/start', {
            threadId,
            input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
            ...(opts.cwd ? { cwd: opts.cwd } : {}),
          });
          turnId = turn.turn?.id ?? turn.id;
        } catch (err) {
          if (!stopped) queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          finish();
        }
      })();
      return true;
    };

    const handleNotification = (message: JsonRpcNotification): void => {
      const params = message.params ?? {};
      if (message.method === 'error') {
        const error = params.error as { message?: string } | undefined;
        const errorMessage = error?.message ?? 'Codex app-server 返回错误';
        if (!replaceHistoricalSession(errorMessage) && (!params.threadId || params.threadId === threadId)) {
          queue.push({ type: 'error', message: errorMessage });
        }
        return;
      }
      if (message.method === 'turn/started') {
        const turn = params.turn as { id?: string } | undefined;
        if (params.threadId === threadId && turn?.id) turnId = turn.id;
        return;
      }
      if (message.method === 'thread/name/updated' && params.threadId === threadId) {
        if (typeof params.threadName === 'string') queue.push({ type: 'ui_title', title: params.threadName });
        return;
      }
      if (params.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'text', delta });
      } else if (message.method === 'item/reasoning/summaryTextDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta });
      } else if (message.method === 'item/reasoning/textDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta });
      } else if (message.method === 'item/plan/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta: `\n${delta}` });
      } else if (message.method === 'turn/plan/updated') {
        const plan = Array.isArray(params.plan) ? params.plan : [];
        const lines = plan.map((step) => {
          const value = step as { step?: unknown; status?: unknown };
          const status = value.status === 'completed' ? '✅' : value.status === 'inProgress' ? '🔄' : '⬜';
          return `${status} ${String(value.step ?? '')}`.trim();
        }).filter((line) => line.length > 2);
        queue.push({ type: 'ui_widget', widget: { key: '执行计划', lines, placement: 'aboveEditor' } });
      } else if (message.method === 'thread/status/changed') {
        const status = params.status as { type?: unknown; activeFlags?: unknown } | undefined;
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.join('、') : '';
        const text = status?.type === 'active'
          ? flags || '执行中'
          : status?.type === 'idle' ? '空闲' : String(status?.type ?? '未知');
        queue.push({ type: 'ui_status', status: { key: '会话状态', text } });
      } else if (message.method === 'turn/diff/updated') {
        const diff = typeof params.diff === 'string' ? params.diff : '';
        queue.push({ type: 'ui_status', status: { key: '代码改动', text: diff ? `已生成改动（${diff.split('\n').length} 行）` : '暂无改动' } });
      } else if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage as { last?: { inputTokens?: number; outputTokens?: number } } | undefined;
        queue.push({ type: 'usage', inputTokens: usage?.last?.inputTokens, outputTokens: usage?.last?.outputTokens });
      } else if (message.method === 'model/rerouted') {
        const from = typeof params.fromModel === 'string' ? params.fromModel : '';
        const to = typeof params.toModel === 'string' ? params.toModel : '';
        queue.push({ type: 'ui_notice', message: `模型已切换：${from} → ${to}`, level: 'info' });
      } else if (message.method === 'thread/compacted') {
        queue.push({ type: 'ui_notice', message: 'Codex 已压缩上下文，继续保持当前会话。', level: 'info' });
      } else if (message.method === 'item/started') {
        const item = params.item as { id?: string; type?: string; command?: string; cwd?: string } | undefined;
        if (!item?.id) return;
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          queue.push({
            type: 'tool_use',
            id: item.id,
            name: item.type === 'commandExecution' ? '运行命令' : item.type === 'fileChange' ? '修改文件' : '调用工具',
            input: { command: item.command, cwd: item.cwd },
          });
        }
      } else if (message.method === 'item/commandExecution/outputDelta' || message.method === 'item/fileChange/outputDelta' || message.method === 'item/mcpToolCall/progress') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : '';
        const delta = typeof params.delta === 'string' ? params.delta : typeof params.message === 'string' ? params.message : '';
        if (itemId && delta) queue.push({ type: 'tool_update', id: itemId, output: delta });
      } else if (message.method === 'item/completed') {
        const item = params.item as { id?: string; type?: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string } | undefined;
        if (!item?.id) return;
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          const output = item.aggregatedOutput ?? item.status ?? '';
          queue.push({ type: 'tool_result', id: item.id, output, isError: item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 });
        }
      } else if (message.method === 'turn/completed') {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        if (turn?.status === 'failed') {
          const errorMessage = turn.error?.message ?? 'Codex 执行失败';
          if (!replaceHistoricalSession(errorMessage)) queue.push({ type: 'error', message: errorMessage });
          if (replacementStarted) return;
        }
        else if (!stopped) queue.push({ type: 'done', sessionId: threadId });
        finish();
      }
    };

    const handleServerRequest = (message: JsonRpcServerRequest): void => {
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput']);
      if (!supported.has(message.method)) {
        queue.push({ type: 'error', message: `Codex 发出了暂不支持的交互请求：${message.method}` });
        return;
      }
      const requestId = String(message.id);
      const firstQuestion = Array.isArray(params.questions) ? params.questions[0] as { id?: string; header?: string; question?: string; options?: Array<{ label?: string }> | null } | undefined : undefined;
      pendingUi.set(requestId, { requestId: message.id, method: message.method, ...(firstQuestion?.id ? { questionId: firstQuestion.id } : {}) });
      if (message.method === 'item/tool/requestUserInput' && !firstQuestion) {
        queue.push({ type: 'error', message: 'Codex 的输入请求没有可用问题。' });
        return;
      }
      const command = typeof params.command === 'string' ? `\n\n即将执行：\n\`${params.command}\`` : '';
      const reason = typeof params.reason === 'string' && params.reason ? `\n\n原因：${params.reason}` : '';
      if (message.method === 'item/tool/requestUserInput' && firstQuestion) {
        const options = Array.isArray(firstQuestion.options) ? firstQuestion.options.map((option) => String(option.label ?? '')).filter(Boolean) : [];
        queue.push({ type: 'ui_request', request: options.length > 0
          ? { id: requestId, method: 'select', title: firstQuestion.header ?? '请选择', options }
          : { id: requestId, method: 'input', title: firstQuestion.header ?? '请输入', placeholder: firstQuestion.question }, });
        return;
      }
      queue.push({
        type: 'ui_request',
        request: {
          id: requestId,
          method: 'confirm',
          title: 'Codex 需要你的确认',
          message: `${command}${reason}`.trim() || 'Codex 请求继续执行。',
        },
      });
    };

    const start = async (): Promise<void> => {
      try {
        await this.client.ensureStarted();
        unsubscribe = this.client.onNotification(handleNotification);
        unsubscribeRequests = this.client.onServerRequest(handleServerRequest);
        effectiveModel = opts.model ?? (opts.sessionId ? await this.resolveDefaultModel() : undefined);
        if (opts.sessionId) log.info('codex', 'resolved-model', { sessionId: opts.sessionId, model: effectiveModel ?? null });
        let thread: { id?: string; thread?: { id?: string } };
        if (opts.sessionId) {
          try {
            thread = await client.request('thread/resume', {
              threadId: opts.sessionId,
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
          });
          } catch (err) {
            if (!isMissingRolloutError(err)) throw err;
            queue.push({ type: 'ui_notice', message: '原 Codex 会话没有可恢复的执行记录，已自动新建会话。', level: 'warning' });
            thread = await client.request('thread/start', { ...(opts.cwd ? { cwd: opts.cwd } : {}) });
          }
        } else {
          thread = await client.request('thread/start', { ...(opts.cwd ? { cwd: opts.cwd } : {}) });
        }
        threadId = thread.thread?.id ?? thread.id ?? opts.sessionId;
        if (!threadId) throw new Error('Codex app-server did not return a thread id');
        queue.push({ type: 'system', sessionId: threadId, cwd: opts.cwd, model: effectiveModel });
        const turn = await this.client.request<{ id?: string; turn?: { id?: string } }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.sessionId && effectiveModel && !replacementStarted ? { model: effectiveModel } : {}),
        });
        turnId = turn.turn?.id ?? turn.id;
      } catch (err) {
        if (!stopped) queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        finish();
      }
    };
    void start();

    return {
      events: queue,
      async stop() {
        stopped = true;
        if (threadId && turnId && !settled) {
          await client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        }
        finish();
      },
      respondToUi(requestId: string, response: AgentUiResponse): boolean {
        const pending = pendingUi.get(requestId);
        if (!pending) return false;
        pendingUi.delete(requestId);
        if (pending.method === 'item/tool/requestUserInput' && pending.questionId) {
          const value = response && 'value' in response ? response.value : '';
          client.respond(pending.requestId, { answers: { [pending.questionId]: { answers: [value] } } });
        } else {
          client.respond(pending.requestId, { decision: response && 'confirmed' in response && response.confirmed ? 'accept' : 'decline' });
        }
        return true;
      },
      async submitPrompt(kind: 'steer' | 'follow_up', message: string): Promise<boolean> {
        if (!threadId || !turnId || settled) return false;
        if (kind === 'steer') {
          await client.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: message, text_elements: [] }] });
        } else {
          const response = await client.request<{ turn?: { id?: string } }>('turn/start', { threadId, input: [{ type: 'text', text: message, text_elements: [] }] });
          if (response.turn?.id) turnId = response.turn.id;
        }
        return true;
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      },
    };
  }
}

function isMissingRolloutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no rollout found|rollout not found|rollout.*missing/i.test(message);
}

function mapThreadStatus(value: unknown): SessionSummary['status'] {
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'active') return 'active';
  return 'idle';
}

function mapThread(thread: Record<string, unknown>, fallbackCwd: string): SessionSummary | undefined {
  const threadId = typeof thread.id === 'string' ? thread.id : '';
  if (!threadId) return undefined;
  const status = thread.status && typeof thread.status === 'object' ? thread.status as { type?: unknown; activeFlags?: unknown } : undefined;
  const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.filter((flag): flag is string => typeof flag === 'string') : undefined;
  const gitInfo = thread.gitInfo && typeof thread.gitInfo === 'object' ? thread.gitInfo as { branch?: unknown } : undefined;
  return {
    threadId,
    ...(typeof thread.sessionId === 'string' ? { sessionId: thread.sessionId } : {}),
    ...(typeof thread.forkedFromId === 'string' ? { forkedFromId: thread.forkedFromId } : {}),
    ...(typeof thread.parentThreadId === 'string' ? { parentThreadId: thread.parentThreadId } : {}),
    ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
    preview: typeof thread.preview === 'string' ? thread.preview : '暂无摘要',
    cwd: typeof thread.cwd === 'string' ? thread.cwd : fallbackCwd,
    status: mapThreadStatus(thread.status),
    ...(activeFlags && activeFlags.length > 0 ? { activeFlags } : {}),
    ...(typeof thread.source === 'string' ? { source: thread.source } : {}),
    ...(typeof gitInfo?.branch === 'string' ? { gitBranch: gitInfo.branch } : {}),
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : Date.now(),
  };
}

function summarizeActivity(item: unknown): SessionActivity | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const value = item as Record<string, unknown>;
  switch (value.type) {
    case 'userMessage': {
      const content = Array.isArray(value.content) ? value.content : [];
      const text = content.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text')
        .map((entry) => typeof entry.text === 'string' ? entry.text : '').filter(Boolean).join('\n');
      return text ? { kind: '用户', text } : undefined;
    }
    case 'agentMessage':
      return typeof value.text === 'string' && value.text ? { kind: '助手', text: value.text } : undefined;
    case 'plan':
      return typeof value.text === 'string' && value.text ? { kind: '计划', text: value.text } : undefined;
    case 'commandExecution':
      return typeof value.command === 'string' && value.command ? { kind: '工具', text: value.command } : undefined;
    case 'fileChange':
      return { kind: '文件', text: '发生文件修改' };
    default:
      return undefined;
  }
}
