import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { log } from '../../core/logger';

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: string | number;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

type NotificationHandler = (message: JsonRpcNotification) => void;
type ServerRequestHandler = (message: JsonRpcServerRequest) => void;

export class CodexAppServerClient {
  private readonly binary: string;
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private initialized = false;
  private starting?: Promise<void>;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notifications = new Set<NotificationHandler>();
  private readonly serverRequests = new Set<ServerRequestHandler>();

  constructor(binary = 'codex') {
    this.binary = binary;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    });
  }

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ method, id, params });
    });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequests.add(handler);
    return () => this.serverRequests.delete(handler);
  }

  async close(): Promise<void> {
    this.initialized = false;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Codex app-server connection closed'));
      this.pending.delete(id);
    }
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 1_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private async start(): Promise<void> {
    const child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Do not leak the parent Codex/Desktop turn context into app-server.
      // Those variables can select a model for the calling desktop task and
      // make the bridge ignore the user's normal device configuration.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !new Set([
          'CODEX_CI',
          'CODEX_SHELL',
          'CODEX_THREAD_ID',
          'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
        ]).has(key)),
      ),
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    void (async () => {
      for await (const line of rl) this.handleLine(line);
    })().catch((err) => log.fail('codex', err, { step: 'read' }));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) log.warn('codex', 'stderr', { text: text.slice(0, 500) });
    });
    child.once('exit', (code, signal) => {
      this.initialized = false;
      log.info('codex', 'app-server-exit', { code, signal });
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`));
        this.pending.delete(id);
      }
    });
    await this.requestBeforeInitialized('initialize', {
      clientInfo: { name: 'feishu_codex_bridge', title: 'Feishu Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    this.initialized = true;
  }

  private requestBeforeInitialized<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server initialization timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ method, id, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex app-server is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn('codex', 'non-json-stdout', { line: line.slice(0, 300) });
      return;
    }
    if ('id' in message && ('result' in message || 'error' in message)) {
      const id = message.id;
      if (typeof id !== 'number' && typeof id !== 'string') return;
      const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
      if (!entry) return;
      this.pending.delete(id as number);
      clearTimeout(entry.timer);
      const error = message.error as { message?: string } | undefined;
      if (error) entry.reject(new Error(error.message ?? 'Codex app-server request failed'));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    const notification: JsonRpcNotification = {
      method: message.method,
      params: (message.params as Record<string, unknown> | undefined) ?? {},
    };
    if ('id' in message && (typeof message.id === 'number' || typeof message.id === 'string')) {
      const request = { ...notification, id: message.id };
      for (const handler of this.serverRequests) handler(request);
      return;
    }
    for (const handler of this.notifications) handler(notification);
  }
}
