import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { ChatModeCache } from './chat-mode-cache';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / regular group**: scope = `chatId`.
 *  - **project group topic**: scope = `${chatId}:${threadId}` — each topic is
 *    an independent conversation with its own session / cwd / pending queue.
 *
 * Feishu's `chat.get` API reports a thread-enabled private group as
 * `chat_mode: "group"`; it does not report the `group_message_type` that was
 * used when the group was created. Therefore project bindings are also an
 * explicit signal that a message carrying `threadId` must be topic-scoped.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
  projectChat = false,
): Promise<string> {
  const mode = await cache.resolve(channel, chatId);
  if (isThreadScoped(mode, threadId, projectChat)) {
    return `${chatId}:${threadId}`;
  }
  return chatId;
}

export function isThreadScoped(
  mode: 'p2p' | 'group' | 'topic',
  threadId: string | undefined,
  projectChat = false,
): boolean {
  return Boolean(threadId && (mode === 'topic' || projectChat));
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
  projectChat = false,
): Promise<string> {
  return scopeFor(channel, msg.chatId, msg.threadId, cache, projectChat);
}
