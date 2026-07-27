import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Feishu topic groups have two different identifiers:
 * - the root message id (`om_...`)
 * - the topic/thread id (`omt_...`)
 *
 * Codex bindings must use the latter because inbound messages and card
 * actions carry `thread_id`, not the root message id.
 */
export async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const response = (await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
    })) as { data?: { items?: { thread_id?: string }[] } };
    return response.data?.items?.[0]?.thread_id;
  } catch (err) {
    log.warn('thread', 'id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
