import { describe, expect, it } from 'vitest';
import { isThreadScoped, scopeFor } from './scope';

describe('topic scope resolution', () => {
  it('treats a thread in a project group as topic-scoped even when Feishu reports group', () => {
    expect(isThreadScoped('group', 'root-message-1', true)).toBe(true);
    expect(isThreadScoped('group', undefined, true)).toBe(false);
  });

  it('keeps ordinary group replies on the chat scope', () => {
    expect(isThreadScoped('group', 'root-message-1', false)).toBe(false);
    expect(isThreadScoped('topic', 'root-message-1', false)).toBe(true);
  });

  it('builds a project topic scope without relying on topic chat mode', async () => {
    const channel = { getChatMode: async () => 'group' } as never;
    const cache = { resolve: async () => 'group' } as never;
    await expect(scopeFor(channel, 'chat-1', 'root-1', cache, true)).resolves.toBe('chat-1:root-1');
    await expect(scopeFor(channel, 'chat-1', undefined, cache, true)).resolves.toBe('chat-1');
  });
});
