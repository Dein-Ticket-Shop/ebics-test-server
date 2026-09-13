import { Hono, type Context } from 'hono';
import { realtimeUrl, type BtfNotification, type RealtimeHub } from '../realtime/notifications.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

/** Real-time notifications: open connections, manual tokens and messages */
export function createRealtimeAdminRoute(realtime: RealtimeHub) {
  const app = new Hono();

  app.get('/realtime/connections', (c) => c.json(realtime.listConnections()));

  app.post('/realtime/tokens', async (c) => {
    const input = await body<{ partnerId: string; userId: string }>(c);
    if (!input.partnerId) return c.json({ error: 'partnerId is required' }, 400);
    const parameters = realtime.issueToken(input.partnerId, input.userId || undefined);
    return c.json({ URL: realtimeUrl(c.req.url), ...parameters }, 201);
  });

  app.post('/realtime/notify', async (c) => {
    const input = await body<{ partnerId: string; userId: string; btf: BtfNotification[]; orderTypes: string[] }>(c);
    const btf = Array.isArray(input.btf) ? input.btf.filter((b) => b && b.SERVICE && b.MSGNAME) : [];
    const orderTypes = Array.isArray(input.orderTypes) ? input.orderTypes.filter((t) => typeof t === 'string' && t) : [];
    if (!input.partnerId) return c.json({ error: 'partnerId is required' }, 400);
    if (btf.length === 0 && orderTypes.length === 0) {
      return c.json({ error: 'btf (SERVICE and MSGNAME per entry) or orderTypes is required' }, 400);
    }
    return c.json({ sent: realtime.notify(input.partnerId, { userId: input.userId || undefined, btf, orderTypes }) });
  });

  app.post('/realtime/info', async (c) => {
    const input = await body<{ text: string; lang: string }>(c);
    if (!input.text) return c.json({ error: 'text is required' }, 400);
    return c.json({ sent: realtime.broadcastInfo(input.text, input.lang || 'DE') });
  });

  return app;
}
