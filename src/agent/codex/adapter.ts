import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions, AgentUiResponse } from '../types';
import { log } from '../../core/logger';
import { CodexAppServerClient, type JsonRpcNotification, type JsonRpcServerRequest } from './app-server';
import type { SessionPage, SessionSummary } from '../../project/types';

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

  constructor(opts: CodexAdapterOptions = {}) {
    this.client = new CodexAppServerClient(opts.binary);
  }

  async isAvailable(): Promise<boolean> {
    return this.client.isAvailable();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    return (await this.listSessionPage(cwd)).sessions;
  }

  async listSessionPage(cwd: string, cursor?: string): Promise<SessionPage> {
    const response = await this.client.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/list', {
      cwd,
      limit: 50,
      archived: false,
      ...(cursor ? { cursor } : {}),
    });
    const sessions = (response.data ?? []).map((thread) => ({
      threadId: String(thread.id ?? ''),
      name: typeof thread.name === 'string' ? thread.name : undefined,
      preview: typeof thread.preview === 'string' ? thread.preview : '暂无摘要',
      cwd: typeof thread.cwd === 'string' ? thread.cwd : cwd,
      status: mapThreadStatus(thread.status),
      updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : Date.now(),
    })).filter((session) => session.threadId !== '');
    return { sessions, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) };
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

    const handleNotification = (message: JsonRpcNotification): void => {
      const params = message.params ?? {};
      if (message.method === 'turn/started') {
        const turn = params.turn as { id?: string } | undefined;
        if (params.threadId === threadId && turn?.id) turnId = turn.id;
        return;
      }
      if (params.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'text', delta });
      } else if (message.method === 'item/reasoning/summaryTextDelta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) queue.push({ type: 'thinking', delta });
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
      } else if (message.method === 'item/completed') {
        const item = params.item as { id?: string; type?: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string } | undefined;
        if (!item?.id) return;
        if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
          const output = item.aggregatedOutput ?? item.status ?? '';
          queue.push({ type: 'tool_result', id: item.id, output, isError: item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 });
        }
      } else if (message.method === 'turn/completed') {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
        if (turn?.status === 'failed') queue.push({ type: 'error', message: turn.error?.message ?? 'Codex 执行失败' });
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
        const thread = opts.sessionId
          ? await client.request<{ id?: string; thread?: { id?: string } }>('thread/resume', { threadId: opts.sessionId, ...(opts.cwd ? { cwd: opts.cwd } : {}) })
          : await client.request<{ id?: string; thread?: { id?: string } }>('thread/start', { ...(opts.cwd ? { cwd: opts.cwd } : {}) });
        threadId = thread.thread?.id ?? thread.id ?? opts.sessionId;
        if (!threadId) throw new Error('Codex app-server did not return a thread id');
        queue.push({ type: 'system', sessionId: threadId, cwd: opts.cwd, model: opts.model });
        const turn = await this.client.request<{ id?: string; turn?: { id?: string } }>('turn/start', {
          threadId,
          input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.model ? { model: opts.model } : {}),
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

function mapThreadStatus(value: unknown): SessionSummary['status'] {
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'active') return 'active';
  return 'idle';
}
