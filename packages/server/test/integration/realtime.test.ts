import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { serve } from '@hono/node-server';
import WebSocket from 'ws';
import { createServerApp } from '../../src/server.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { RealtimeHub } from '../../src/realtime/notifications.js';
import { calculateIban } from '../../src/banking/iban.js';
import { HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { buildPain001Document } from '../helpers/test-client.js';
import { enrolSubscriber, uploadOrder, downloadOrder, type EbicsSession } from '../helpers/ebics-session.js';
import type { Account } from '../../src/store/types.js';

const FLAGS = ['EBICS_WSS_ONE_TIME_TOKEN', 'EBICS_EDS_HOLD', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS', 'EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_STRICT_VALIDATION'] as const;

const BTF = {
  camt054: { SERVICE: 'STM', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'camt.054' },
  camt052: { SERVICE: 'STM', SCOPE: 'DE', CONTTYPE: 'ZIP', MSGNAME: 'camt.052' },
  paymentStatus: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' },
  vop: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'VOP', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' },
};
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HAA_MCLASS = [{ NAME: 'EBICS-HAA', VERS: '1.0', TIMESTAMP: expect.stringMatching(TIMESTAMP) }];

interface Ctx {
  server: HttpServer;
  realtime: RealtimeHub;
  store: SqliteStore;
  port: number;
  base: string;
  session: EbicsSession;
  /** The partner's own account, created on activation */
  account: Account;
}

interface Client {
  ws: WebSocket;
  messages: any[];
}

type WssParameters = Record<'URL' | 'TOKEN' | 'OTT' | 'VALIDITY' | 'PARTNERID' | 'USERID', string>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls with the real clock (Date may be faked) */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;
const credentialsOf = (p: { PARTNERID: string; USERID?: string; TOKEN: string }) => `${p.PARTNERID}${p.USERID ? `_${p.USERID}` : ''}:${p.TOKEN}`;

describe('Real-time notifications', () => {
  let ctx: Ctx;
  const sockets: WebSocket[] = [];
  const saved: Record<string, string | undefined> = {};

  async function start(): Promise<Ctx> {
    const store = new SqliteStore(':memory:');
    const { app, realtime } = createServerApp({ hostId: HOST_ID, store, validateRequests: true, validateResponses: true });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as HttpServer;
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    realtime.attach(server);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    // Assign before enrolling so afterEach can close the server even if enrolment fails
    ctx = { server, realtime, store, port, base } as Ctx;

    ctx.session = await enrolSubscriber({
      post: async (xml) => (await fetch(`${base}/ebics`, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: xml })).text(),
      activate: (partnerId, userId) => fetch(`${base}/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' }),
      store,
      partnerId: PARTNER_ID,
      userId: USER_ID,
    });
    ctx.account = store.listAccountsForPartner(PARTNER_ID)[0]!;
    return ctx;
  }

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${ctx.base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }

  async function wssparam(): Promise<WssParameters> {
    const result = await downloadOrder(ctx.session, 'BTD', { serviceName: 'OTH', scope: 'DE', msgName: 'wssparam' });
    expect(result.code).toBe('000000');
    return JSON.parse(result.data!.toString('utf8'));
  }

  /** Opens a WebSocket; resolves with the client or with the HTTP status of a refused upgrade */
  function connect(
    authorization?: string,
    path = '/realtime',
  ): Promise<{ client?: Client; status?: number; wwwAuthenticate?: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${path}`, authorization ? { headers: { Authorization: authorization } } : {});
      sockets.push(ws);
      const messages: any[] = [];
      let settled = false;
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
      ws.on('open', () => {
        settled = true;
        resolve({ client: { ws, messages } });
      });
      ws.on('unexpected-response', (request, response) => {
        settled = true;
        resolve({ status: response.statusCode, wwwAuthenticate: response.headers['www-authenticate'] });
        response.resume();
        request.destroy();
      });
      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async function open(authorization: string): Promise<Client> {
    const result = await connect(authorization);
    if (!result.client) throw new Error(`WebSocket refused with HTTP ${result.status}`);
    return result.client;
  }

  function bobAccount(): Account {
    const bob = ctx.store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
    const accountNumber = ctx.store.getNextAccountSequence().toString().padStart(10, '0');
    return ctx.store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
  }

  beforeEach(async () => {
    for (const flag of FLAGS) {
      saved[flag] = process.env[flag];
      delete process.env[flag];
    }
    await start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const ws of sockets.splice(0)) ws.terminate();
    if (ctx?.server) {
      ctx.realtime.close();
      ctx.server.closeAllConnections();
      await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
    }
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  });

  describe('wssparam (BTD OTH/DE/wssparam)', () => {
    it('returns the connection parameters as JSON strings', async () => {
      const params = await wssparam();
      expect(Object.keys(params).sort()).toEqual(['OTT', 'PARTNERID', 'TOKEN', 'URL', 'USERID', 'VALIDITY']);
      for (const value of Object.values(params)) expect(typeof value).toBe('string');
      expect(params).toMatchObject({ URL: `${ctx.base.replace(/^http/, 'ws')}/realtime`, OTT: 'N', PARTNERID: PARTNER_ID, USERID: USER_ID });
      expect(params.TOKEN).toMatch(UUID);
      expect(params.VALIDITY).toMatch(TIMESTAMP);
      const validForMs = Date.parse(params.VALIDITY) - Date.now();
      expect(validForMs).toBeGreaterThan(59 * 60 * 1000);
      expect(validForMs).toBeLessThanOrEqual(60 * 60 * 1000);

      // Every download issues a new token
      const again = await wssparam();
      expect(again.TOKEN).not.toBe(params.TOKEN);
    });
  });

  describe('connections', () => {
    it('accepts PARTNERID_USERID:TOKEN and lists open connections', async () => {
      expect((await api('GET', '/realtime/connections')).json).toEqual([]);
      const params = await wssparam();
      const client = await open(basic(credentialsOf(params)));

      expect((await api('GET', '/realtime/connections')).json).toEqual([
        { id: expect.stringMatching(UUID), partnerId: PARTNER_ID, userId: USER_ID, connectedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      ]);

      // Tokens without OTT can reconnect until VALIDITY
      await open(basic(credentialsOf(params)));
      expect((await api('GET', '/realtime/connections')).json).toHaveLength(2);

      client.ws.close();
      await waitFor(() => ctx.realtime.listConnections().length === 1);
    });

    it('answers upgrades on other paths with 404 instead of leaving the client hanging', async () => {
      const params = await wssparam();
      expect((await connect(basic(`${PARTNER_ID}_${USER_ID}:${params.TOKEN}`), '/ebics')).status).toBe(404);
      expect(ctx.realtime.listConnections()).toEqual([]);
    });

    it('refuses missing, unknown and foreign credentials with 401', async () => {
      const params = await wssparam();
      const refused = await connect();
      expect(refused.status).toBe(401);
      expect(refused.wwwAuthenticate).toBe('Basic realm="EBICS"');

      expect((await connect(basic(`${PARTNER_ID}_${USER_ID}:00000000-0000-4000-8000-000000000000`))).status).toBe(401);
      expect((await connect(basic(`PARTNER2_${USER_ID}:${params.TOKEN}`))).status).toBe(401);
      expect((await connect(basic(`${PARTNER_ID}_USER2:${params.TOKEN}`))).status).toBe(401);
      expect((await connect(basic(`${PARTNER_ID}:${params.TOKEN}`))).status).toBe(401);
      expect((await connect(basic(params.TOKEN))).status).toBe(401);
      expect((await connect(`Bearer ${params.TOKEN}`)).status).toBe(401);
      expect(ctx.realtime.listConnections()).toEqual([]);

      // Refused attempts do not invalidate the token
      expect((await connect(basic(credentialsOf(params)))).client).toBeDefined();
    });

    it('refuses a token after its VALIDITY', async () => {
      const params = await wssparam();
      const validity = Date.parse(params.VALIDITY);

      vi.useFakeTimers({ toFake: ['Date'], now: validity - 60_000 });
      expect((await connect(basic(credentialsOf(params)))).client).toBeDefined();

      vi.setSystemTime(validity + 1_000);
      expect((await connect(basic(credentialsOf(params)))).status).toBe(401);
    });

    it('hands out one-time tokens with EBICS_WSS_ONE_TIME_TOKEN=true', async () => {
      process.env['EBICS_WSS_ONE_TIME_TOKEN'] = 'true';
      const params = await wssparam();
      expect(params.OTT).toBe('Y');

      // A refused attempt does not use the token up
      expect((await connect(basic(`PARTNER2_${USER_ID}:${params.TOKEN}`))).status).toBe(401);
      expect((await connect(basic(credentialsOf(params)))).client).toBeDefined();
      expect((await connect(basic(credentialsOf(params)))).status).toBe(401);

      const next = await wssparam();
      expect(next.OTT).toBe('Y');
      expect((await connect(basic(credentialsOf(next)))).client).toBeDefined();
      expect(ctx.realtime.listConnections()).toHaveLength(2);
    });
  });

  describe('EBICS-HAA messages', () => {
    it('batch bookings on accessible accounts into one message per partner', async () => {
      const client = await open(basic(credentialsOf(await wssparam())));
      const other = (await api('POST', '/realtime/tokens', { partnerId: 'PARTNER2' })).json;
      const otherClient = await open(basic(`PARTNER2:${other.TOKEN}`));

      const today = new Date().toISOString().slice(0, 10);
      ctx.store.createBooking({ accountId: ctx.account.id, amountCents: 100, currency: 'EUR', valueDate: today, bookingDate: today, transactionCode: 'NTRF' });
      ctx.store.createBooking({ accountId: ctx.account.id, amountCents: -50, currency: 'EUR', valueDate: today, bookingDate: today, transactionCode: 'NTRF' });

      await waitFor(() => client.messages.length > 0);
      await sleep(150);
      expect(client.messages).toEqual([{ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, BTF: [BTF.camt054, BTF.camt052] }]);
      expect(otherClient.messages).toEqual([]);

      // Bookings on accounts the partner cannot access notify nobody
      ctx.store.createBooking({ accountId: bobAccount().id, amountCents: 100, currency: 'EUR', valueDate: today, bookingDate: today, transactionCode: 'NTRF' });
      await sleep(150);
      expect(client.messages).toHaveLength(1);
      expect(otherClient.messages).toEqual([]);
    });

    it('announce payment status, VoP report, statements and HAC for an executed credit transfer upload', async () => {
      ctx.store.createBooking({ accountId: ctx.account.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
      const creditor = bobAccount();
      const client = await open(basic(credentialsOf(await wssparam())));

      await uploadOrder(
        ctx.session,
        buildPain001Document({
          msgId: 'MSG-RT',
          payments: [
            {
              pmtInfId: 'PMT-RT',
              debtorName: 'Musterfirma GmbH',
              debtorIban: ctx.account.iban,
              transactions: [{ endToEndId: 'E2E-RT', creditorName: 'Bob Mustermann', creditorIban: creditor.iban, amount: '12.34' }],
            },
          ],
        }),
      );

      await waitFor(() => client.messages.length > 0);
      await sleep(150);
      expect(client.messages).toHaveLength(1);
      const [message] = client.messages;
      expect(message).toMatchObject({ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, ORDERTYPE: ['HAC'] });
      expect(message.BTF).toHaveLength(4);
      expect(message.BTF).toEqual(expect.arrayContaining([BTF.vop, BTF.paymentStatus, BTF.camt054, BTF.camt052]));
    });

    it('announce REP/VOP and REP/SCI for a held order and the statements once it is released', async () => {
      process.env['EBICS_EDS_HOLD'] = 'true';
      ctx.store.createBooking({ accountId: ctx.account.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
      const creditor = bobAccount();
      const client = await open(basic(credentialsOf(await wssparam())));

      await uploadOrder(
        ctx.session,
        buildPain001Document({
          msgId: 'MSG-HOLD',
          payments: [
            {
              pmtInfId: 'PMT-HOLD',
              debtorName: 'Musterfirma GmbH',
              debtorIban: ctx.account.iban,
              transactions: [{ endToEndId: 'E2E-HOLD', creditorName: 'Bob Mustermann', creditorIban: creditor.iban, amount: '1.00' }],
            },
          ],
        }),
      );
      await waitFor(() => client.messages.length > 0);
      await sleep(150);
      expect(client.messages).toEqual([{ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, BTF: [BTF.vop, BTF.paymentStatus], ORDERTYPE: ['HAC'] }]);

      const [order] = ctx.store.listPaymentOrders();
      expect((await api('POST', `/payments/${order!.id}/release`)).status).toBe(200);
      await waitFor(() => client.messages.length > 1);
      await sleep(150);
      expect(client.messages).toHaveLength(2);
      expect(client.messages[1]).toMatchObject({ PARTNERID: PARTNER_ID, ORDERTYPE: ['HAC'] });
      expect(client.messages[1].BTF).toHaveLength(3);
      expect(client.messages[1].BTF).toEqual(expect.arrayContaining([BTF.paymentStatus, BTF.camt054, BTF.camt052]));
    });

    it('announce new HAC events with ORDERTYPE HAC', async () => {
      const client = await open(basic(credentialsOf(await wssparam())));
      ctx.store.appendHacEvent({ partnerId: PARTNER_ID, orderId: 'A999', action: 'ADDITIONAL', adminOrderType: 'BTU' });
      ctx.store.appendHacEvent({ partnerId: PARTNER_ID, orderId: 'A999', action: 'ORDER_HAC_FINAL_POS', adminOrderType: 'BTU' });
      ctx.store.appendHacEvent({ partnerId: 'PARTNER2', orderId: 'A000', action: 'ADDITIONAL', adminOrderType: 'BTU' });

      await waitFor(() => client.messages.length > 0);
      await sleep(150);
      expect(client.messages).toEqual([{ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, ORDERTYPE: ['HAC'] }]);
    });
  });

  describe('admin API', () => {
    it('issues tokens', async () => {
      expect((await api('POST', '/realtime/tokens', {})).status).toBe(400);

      const created = await api('POST', '/realtime/tokens', { partnerId: PARTNER_ID, userId: USER_ID });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({ URL: `${ctx.base.replace(/^http/, 'ws')}/realtime`, OTT: 'N', PARTNERID: PARTNER_ID, USERID: USER_ID });
      expect(created.json.TOKEN).toMatch(UUID);
      expect((await connect(basic(`${PARTNER_ID}_${USER_ID}:${created.json.TOKEN}`))).client).toBeDefined();

      // Without a user the credentials are PARTNERID:TOKEN
      const partnerOnly = await api('POST', '/realtime/tokens', { partnerId: PARTNER_ID, userId: '' });
      expect(partnerOnly.status).toBe(201);
      expect(partnerOnly.json).not.toHaveProperty('USERID');
      expect((await connect(basic(`${PARTNER_ID}_${USER_ID}:${partnerOnly.json.TOKEN}`))).status).toBe(401);
      expect((await connect(basic(`${PARTNER_ID}:${partnerOnly.json.TOKEN}`))).client).toBeDefined();
      expect(ctx.realtime.listConnections().map((c) => c.userId)).toEqual([USER_ID, undefined]);
    });

    it('sends manual EBICS-HAA and INFO messages', async () => {
      const client = await open(basic(credentialsOf(await wssparam())));
      const other = await open(basic(`PARTNER2:${(await api('POST', '/realtime/tokens', { partnerId: 'PARTNER2' })).json.TOKEN}`));

      expect((await api('POST', '/realtime/notify', { partnerId: PARTNER_ID })).status).toBe(400);
      expect((await api('POST', '/realtime/notify', { partnerId: PARTNER_ID, btf: [{ SERVICE: 'STM' }], orderTypes: [''] })).status).toBe(400);
      expect((await api('POST', '/realtime/notify', { btf: [{ SERVICE: 'EOP', MSGNAME: 'camt.053' }] })).status).toBe(400);

      const statement = { SERVICE: 'EOP', SCOPE: 'DE', CONTTYPE: 'ZIP', MSGNAME: 'camt.053' };
      const notified = await api('POST', '/realtime/notify', { partnerId: PARTNER_ID, userId: USER_ID, btf: [statement, { SERVICE: 'X' }], orderTypes: ['HAC', ''] });
      expect(notified).toEqual({ status: 200, json: { sent: 1 } });
      await waitFor(() => client.messages.length === 1);
      expect(client.messages[0]).toEqual({ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, USERID: USER_ID, BTF: [statement], ORDERTYPE: ['HAC'] });

      expect((await api('POST', '/realtime/notify', { partnerId: PARTNER_ID, orderTypes: ['PTK'] })).json).toEqual({ sent: 1 });
      await waitFor(() => client.messages.length === 2);
      expect(client.messages[1]).toEqual({ MCLASS: HAA_MCLASS, PARTNERID: PARTNER_ID, ORDERTYPE: ['PTK'] });
      expect((await api('POST', '/realtime/notify', { partnerId: 'NOBODY', orderTypes: ['HAC'] })).json).toEqual({ sent: 0 });

      expect((await api('POST', '/realtime/info', {})).status).toBe(400);
      expect((await api('POST', '/realtime/info', { text: 'Wartung heute ab 22 Uhr' })).json).toEqual({ sent: 2 });
      await waitFor(() => client.messages.length === 3 && other.messages.length === 1);
      const info = { MCLASS: [{ NAME: 'INFO', VERS: '1.0', TIMESTAMP: expect.stringMatching(TIMESTAMP) }], INFO: [{ LANG: 'DE', FREE: 'Wartung heute ab 22 Uhr' }] };
      expect(other.messages[0]).toEqual(info);
      expect(client.messages[2]).toEqual(info);

      expect((await api('POST', '/realtime/info', { text: 'Maintenance', lang: 'EN' })).json).toEqual({ sent: 2 });
      await waitFor(() => other.messages.length === 2);
      expect(other.messages[1].INFO).toEqual([{ LANG: 'EN', FREE: 'Maintenance' }]);
    });
  });
});
