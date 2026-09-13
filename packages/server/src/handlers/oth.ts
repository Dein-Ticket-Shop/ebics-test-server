import type { DownloadOrderData, HandlerContext } from './handler-types.js';
import type { AppStore, Subscriber } from '../store/types.js';
import { realtimeHubFor, realtimeUrl } from '../realtime/notifications.js';

/** BTD OTH/DE/wssparam: connection parameters for the real-time notification WebSocket (JSON, all strings) */
export function websocketParameters(store: AppStore, subscriber: Subscriber, ctx: HandlerContext): DownloadOrderData {
  const parameters = realtimeHubFor(store).issueToken(subscriber.partnerId, subscriber.userId);
  const base = ctx.requestUrl ?? `http://localhost:${process.env['PORT'] ?? '4150'}`;
  return JSON.stringify({ URL: realtimeUrl(base), ...parameters });
}
