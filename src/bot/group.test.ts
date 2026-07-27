import { describe, expect, it, vi } from 'vitest';
import { createBoundChat } from './group';

describe('createBoundChat', () => {
  it('creates a private topic group for a project', async () => {
    const create = vi.fn().mockResolvedValue({ data: { chat_id: 'chat-1' } });
    const channel = { rawClient: { im: { v1: { chat: { create } } } } } as never;
    await expect(createBoundChat({ channel, name: 'Codex · demo', inviteOpenId: 'user-1', threadMode: true })).resolves.toEqual({ chatId: 'chat-1', name: 'Codex · demo' });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'thread',
        user_id_list: ['user-1'],
      }),
      params: { user_id_type: 'open_id' },
    });
  });
});
