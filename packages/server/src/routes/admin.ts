import { Hono } from 'hono';
import type { AppStore } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { generateBankKeys } from '../bank/bank-keys.js';
import { createBankingAdminRoute } from './admin-banking.js';
import { calculateIban } from '../banking/iban.js';
import { createPaymentsAdminRoute } from './admin-payments.js';
import { createVeuAdminRoute } from './admin-veu.js';
import { createRealtimeAdminRoute } from './admin-realtime.js';
import { RealtimeHub } from '../realtime/notifications.js';
import { recordSubscriberActivated } from '../banking/order-events.js';
import {
  allowPreActivation,
  describeEnvFlags,
  edsHold,
  hacDownloadEvents,
  hacFormat,
  vopConfirmationRequired,
  vopDefaultStatus,
  wssOneTimeTokens,
} from '../config/feature-flags.js';
import { isStrictValidation } from '../banking/validation.js';

export function createAdminRoute(store: AppStore, hostId?: string, realtime: RealtimeHub = new RealtimeHub(store)) {
  const app = new Hono();

  app.get('/host', (c) => {
    const config = store.getHostConfig();
    if (!config) return c.json({ error: 'Host not configured' }, 404);
    return c.json({
      hostId: config.hostId,
      bankKeys: {
        authenticationVersion: config.bankKeys.authenticationVersion,
        authenticationCertificate: config.bankKeys.authenticationCertificate,
        encryptionVersion: config.bankKeys.encryptionVersion,
        encryptionCertificate: config.bankKeys.encryptionCertificate,
      },
    });
  });

  app.post('/host', async (c) => {
    const body = await c.req.json<{ hostId: string }>();
    const bankKeys = generateBankKeys(body.hostId);
    store.setHostConfig({ hostId: body.hostId, bankKeys });
    store.logActivity({ eventType: 'host_configured', details: { hostId: body.hostId } });
    return c.json({ hostId: body.hostId, status: 'configured' });
  });

  app.get('/stats', (c) => {
    const subscribers = store.listSubscribers();
    const byState = Object.fromEntries(
      Object.values(SubscriberState).map((s) => [s, 0]),
    ) as Record<SubscriberState, number>;
    for (const sub of subscribers) byState[sub.state]++;
    return c.json({
      total: subscribers.length,
      byState,
      hostConfigured: !!store.getHostConfig(),
    });
  });

  app.post('/subscribers', async (c) => {
    const body = await c.req.json<{ partnerId: string; userId: string }>();
    if (!body?.partnerId || !body?.userId) {
      return c.json({ error: 'partnerId and userId are required' }, 400);
    }

    if (store.getSubscriber(body.partnerId, body.userId)) {
      return c.json(
        { error: `Subscriber ${body.partnerId}/${body.userId} already exists` },
        409,
      );
    }

    const subscriber = store.createSubscriber(body.partnerId, body.userId);
    store.logActivity({
      eventType: 'subscriber_created',
      partnerId: body.partnerId,
      userId: body.userId,
    });
    return c.json(subscriber, 201);
  });

  app.get('/subscribers', (c) => {
    return c.json(store.listSubscribers());
  });

  app.get('/subscribers/:partnerId/:userId', (c) => {
    const { partnerId, userId } = c.req.param();
    const subscriber = store.getSubscriber(partnerId, userId);
    if (!subscriber) return c.json({ error: 'Not found' }, 404);
    return c.json(subscriber);
  });

  /** Per-subscriber settings: { protocolDownloadsAllowed: boolean } allows or refuses HAC and PTK (090003) */
  app.patch('/subscribers/:partnerId/:userId', async (c) => {
    const { partnerId, userId } = c.req.param();
    if (!store.getSubscriber(partnerId, userId)) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { protocolDownloadsAllowed?: unknown };
    if (typeof body.protocolDownloadsAllowed !== 'boolean') {
      return c.json({ error: 'protocolDownloadsAllowed (boolean) is required' }, 400);
    }

    store.setSubscriberProtocolDownloads(partnerId, userId, body.protocolDownloadsAllowed);
    store.logActivity({
      eventType: 'subscriber_updated',
      partnerId,
      userId,
      details: { protocolDownloadsAllowed: body.protocolDownloadsAllowed },
    });
    return c.json(store.getSubscriber(partnerId, userId));
  });

  app.post('/subscribers/:partnerId/:userId/activate', (c) => {
    const { partnerId, userId } = c.req.param();
    const subscriber = store.getSubscriber(partnerId, userId);
    if (!subscriber) return c.json({ error: 'Not found' }, 404);

    if (subscriber.state !== SubscriberState.INITIALIZED) {
      return c.json({
        error: 'Subscriber must be in INITIALIZED state (both INI and HIA completed)',
        currentState: subscriber.state,
      }, 400);
    }

    store.updateSubscriberState(partnerId, userId, SubscriberState.READY);
    store.logActivity({
      eventType: 'subscriber_activated',
      partnerId,
      userId,
    });

    ensureBankingEntities(store, partnerId, userId);
    recordSubscriberActivated(store, partnerId, userId);

    return c.json({ ...store.getSubscriber(partnerId, userId) });
  });

  app.post('/subscribers/:partnerId/:userId/suspend', (c) => {
    const { partnerId, userId } = c.req.param();
    const subscriber = store.getSubscriber(partnerId, userId);
    if (!subscriber) return c.json({ error: 'Not found' }, 404);

    if (subscriber.state !== SubscriberState.READY) {
      return c.json({
        error: 'Subscriber must be in READY state to suspend',
        currentState: subscriber.state,
      }, 400);
    }

    store.updateSubscriberState(partnerId, userId, SubscriberState.SUSPENDED);
    store.logActivity({
      eventType: 'subscriber_suspended',
      partnerId,
      userId,
    });

    return c.json({ ...store.getSubscriber(partnerId, userId) });
  });

  app.post('/subscribers/:partnerId/:userId/reactivate', (c) => {
    const { partnerId, userId } = c.req.param();
    const subscriber = store.getSubscriber(partnerId, userId);
    if (!subscriber) return c.json({ error: 'Not found' }, 404);

    if (subscriber.state !== SubscriberState.SUSPENDED) {
      return c.json({
        error: 'Subscriber must be in SUSPENDED state to reactivate',
        currentState: subscriber.state,
      }, 400);
    }

    store.updateSubscriberState(partnerId, userId, SubscriberState.READY);
    store.logActivity({
      eventType: 'subscriber_reactivated',
      partnerId,
      userId,
    });

    return c.json({ ...store.getSubscriber(partnerId, userId) });
  });

  app.delete('/subscribers/:partnerId/:userId', (c) => {
    const { partnerId, userId } = c.req.param();
    store.deleteSubscriber(partnerId, userId);
    store.logActivity({
      eventType: 'subscriber_deleted',
      partnerId,
      userId,
    });
    return c.json({ status: 'deleted' });
  });

  app.get('/activity', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    return c.json(store.getActivityLog(limit, offset));
  });

  app.get('/protocol-log', (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const entries = store.getProtocolLog(limit, offset);
    return c.json(entries.map((e) => ({
      ...e,
      requestXml: undefined,
      responseXml: undefined,
      requestSize: e.requestXml.length,
      responseSize: e.responseXml.length,
    })));
  });

  app.get('/protocol-log/:id', (c) => {
    const entry = store.getProtocolLogEntry(parseInt(c.req.param('id'), 10));
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.json(entry);
  });

  app.get('/protocol-log/:id/request', (c) => {
    const entry = store.getProtocolLogEntry(parseInt(c.req.param('id'), 10));
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.body(entry.requestXml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });

  app.get('/protocol-log/:id/response', (c) => {
    const entry = store.getProtocolLogEntry(parseInt(c.req.param('id'), 10));
    if (!entry) return c.json({ error: 'Not found' }, 404);
    return c.body(entry.responseXml, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });

  app.post('/download-data', async (c) => {
    const body = await c.req.json<{
      serviceName: string;
      serviceOption?: string;
      msgName?: string;
      content: string;
      contentType?: 'text' | 'base64';
    }>();
    if (!body?.serviceName || typeof body.content !== 'string') {
      return c.json({ error: 'serviceName and content are required' }, 400);
    }
    store.upsertDownloadData(body.serviceName, body.msgName || undefined, body.content, body.contentType ?? 'text', body.serviceOption || undefined);
    return c.json({ status: 'ok', serviceName: body.serviceName });
  });

  app.delete('/download-data/:id', (c) => {
    store.deleteDownloadData(parseInt(c.req.param('id'), 10));
    return c.json({ status: 'deleted' });
  });

  app.get('/download-data', (c) => {
    return c.json(store.listDownloadData());
  });

  app.get('/uploaded-orders', (c) => {
    return c.json(store.listUploadedOrders());
  });

  app.get('/uploaded-orders/:id', (c) => {
    const order = store.getUploadedOrder(parseInt(c.req.param('id'), 10));
    if (!order) return c.json({ error: 'Not found' }, 404);
    return c.json(order);
  });

  app.route('/banking', createBankingAdminRoute(store));

  app.get('/config/flags', (c) => {
    return c.json({
      hacFormat: hacFormat(),
      edsHold: edsHold(),
      vopDefault: vopDefaultStatus(),
      strictValidation: isStrictValidation(),
      allowPreActivation: allowPreActivation(),
      hacDownloadEvents: hacDownloadEvents(),
      vopConfirmation: vopConfirmationRequired(),
      wssOneTimeTokens: wssOneTimeTokens(),
    });
  });

  /** Every environment flag with label, description, default, allowed values and current value */
  app.get('/config/env-flags', (c) => c.json(describeEnvFlags()));

  app.route('/', createPaymentsAdminRoute(store));
  app.route('/', createVeuAdminRoute(store));
  app.route('/', createRealtimeAdminRoute(realtime));

  app.post('/reset', (c) => {
    store.reset();
    if (hostId) {
      const bankKeys = generateBankKeys(hostId);
      store.setHostConfig({ hostId, bankKeys });
    }
    return c.json({ status: 'reset' });
  });

  return app;
}

function ensureBankingEntities(store: AppStore, partnerId: string, userId: string): void {
  const existing = store.listAccountsForPartner(partnerId);
  if (existing.length > 0) return;

  let bankConfig = store.getBankConfig();
  if (!bankConfig) {
    store.setBankConfig({ blz: '10020030', name: 'EBICS Test Bank AG', bic: 'ETBADE2AXXX' });
    bankConfig = store.getBankConfig()!;
  }

  let person = store.getPersonByExternalId(`${partnerId}-${userId}`);
  if (!person) {
    person = store.createPerson({
      name: `${partnerId} / ${userId}`,
      externalId: `${partnerId}-${userId}`,
      country: 'DE',
    });
  }

  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const iban = calculateIban(bankConfig.blz, accountNumber);
  const account = store.createAccount({
    personId: person.id,
    iban,
    accountNumber,
    currency: 'EUR',
    name: `Konto ${userId}`,
  });

  store.grantAccountAccess(partnerId, account.id);
}
