import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createSign, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DOMParser } from '@xmldom/xmldom';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  buildEbicsUploadTransferRequest,
  buildPain001Document,
  buildPain008Document,
  encryptUploadContent,
  readBusinessReturnCode,
  readOrderId,
  type EncryptedUpload,
  type VeuOrderRef,
} from '../helpers/test-client.js';
import { downloadOrder, enrolSubscriber, localTexts, sendVeuSignature, type EbicsSession } from '../helpers/ebics-session.js';
import { canonicalizeSubtree } from '../../src/protocol/xml-signature.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { validateXml } from '../../src/protocol/xml-validator.js';
import { orderDataDigest } from '../../src/banking/veu.js';
import { calculateIban } from '../../src/banking/iban.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import type { Account, SignatureClass } from '../../src/store/types.js';

const FLAGS = ['EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS', 'EBICS_VOP_DEFAULT', 'EBICS_VOP_CONFIRMATION', 'EBICS_STRICT_VALIDATION'] as const;
const NOT_AUTHORISING: SignatureClass[] = ['A', 'B', 'T'];
const ALL_CLASSES: SignatureClass[] = ['E', 'A', 'B', 'T'];
/** AdminOrderTypes whose Permission carries the user's signature class (AuthorisationLevel) */
const UPLOAD_ORDER_TYPES = ['BTU', 'HVE', 'HVS', 'PUB', 'HCA', 'HCS', 'SPR'];

interface Service {
  serviceName: string;
  scope?: string;
  serviceOption?: string;
  msgName: string;
}

const SCI: Service = { serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' };
const SDD: Service = { serviceName: 'SDD', scope: 'DE', msgName: 'pain.008' };

/** BTUOrderParams/SignatureFlag: with requestEDS, without the attribute, or no SignatureFlag at all */
type SignatureFlagMode = 'requestEDS' | 'signatureFlag' | 'none';

function saveFlags(): () => void {
  const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
  for (const flag of FLAGS) delete process.env[flag];
  return () => {
    for (const flag of FLAGS) {
      if (saved[flag] === undefined) delete process.env[flag];
      else process.env[flag] = saved[flag];
    }
  };
}

function certDigest(certPem: string): string {
  const der = Buffer.from(certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, ''), 'base64');
  return createHash('sha256').update(der).digest('base64');
}

/** X002 authentication signature: SHA-256 over the C14N of all authenticate="true" subtrees, RSA-SHA256 over SignedInfo */
function signRequest(xml: string, privateKey: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const elements = doc.getElementsByTagName('*');
  let canonical = '';
  for (let i = 0; i < elements.length; i++) {
    const element = elements.item(i)!;
    if (element.getAttribute('authenticate') === 'true') canonical += canonicalizeSubtree(element as never);
  }
  const digest = createHash('sha256').update(canonical).digest('base64');

  const signedInfo = `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#xpointer(//*[@authenticate='true'])"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const withSignedInfo = xml.replace('<AuthSignature/>', `<AuthSignature>${signedInfo}<ds:SignatureValue>__SIGNATURE__</ds:SignatureValue></AuthSignature>`);
  const signedInfoElement = new DOMParser()
    .parseFromString(withSignedInfo, 'text/xml')
    .getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignedInfo')
    .item(0)!;
  const signer = createSign('RSA-SHA256');
  signer.update(canonicalizeSubtree(signedInfoElement as never));
  return withSignedInfo.replace('__SIGNATURE__', signer.sign(privateKey, 'base64'));
}

/** BTU Initialisation with full control over the SignatureFlag */
function buildUploadInitRequest(session: EbicsSession, service: Service, enc: EncryptedUpload, mode: SignatureFlagMode): string {
  const scope = service.scope ? `<Scope>${service.scope}</Scope>` : '';
  const option = service.serviceOption ? `<ServiceOption>${service.serviceOption}</ServiceOption>` : '';
  const signatureFlag = { requestEDS: '<SignatureFlag requestEDS="true"/>', signatureFlag: '<SignatureFlag/>', none: '' }[mode];
  const authDigest = certDigest(session.bankCerts.authCertPem);
  const encDigest = certDigest(session.bankCerts.encCertPem);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${HOST_ID}</HostID><Nonce>${randomBytes(16).toString('hex').toUpperCase()}</Nonce><Timestamp>${new Date().toISOString()}</Timestamp><PartnerID>${session.partnerId}</PartnerID><UserID>${session.userId}</UserID><OrderDetails><AdminOrderType>BTU</AdminOrderType><BTUOrderParams><Service><ServiceName>${service.serviceName}</ServiceName>${scope}${option}<MsgName>${service.msgName}</MsgName></Service>${signatureFlag}</BTUOrderParams></OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0000</SecurityMedium><NumSegments>${enc.numSegments}</NumSegments></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body><DataTransfer><DataEncryptionInfo authenticate="true"><EncryptionPubKeyDigest Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</EncryptionPubKeyDigest><TransactionKey>${enc.wrappedKey}</TransactionKey></DataEncryptionInfo><SignatureData authenticate="true">${enc.signatureDataB64}</SignatureData><DataDigest SignatureVersion="A006">${enc.dataDigest}</DataDigest></DataTransfer></body></ebicsRequest>`;
  return signRequest(xml, session.keys.authKeyPair.privateKey);
}

/** BTU upload (Initialisation and Transfer); returns the OrderID and the business return code of the last Transfer */
async function upload(session: EbicsSession, content: string, service: Service, mode: SignatureFlagMode): Promise<{ orderId: string; code?: string }> {
  const enc = encryptUploadContent(content, session.bankEncPubKey, session.partnerId, session.userId);
  const initBody = await session.post(buildUploadInitRequest(session, service, enc, mode));
  expect(readBusinessReturnCode(initBody)).toBe('000000');
  const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(initBody))!;
  let transferBody = '';
  for (let i = 0; i < enc.segments.length; i++) {
    transferBody = await session.post(buildEbicsUploadTransferRequest(HOST_ID, session.keys, transactionId, i + 1, i === enc.segments.length - 1, enc.segments[i]!));
  }
  return { orderId: readOrderId(initBody)!, code: readBusinessReturnCode(transferBody) };
}

type App = ReturnType<typeof createTestApp>['app'];

async function api<T = any>(app: App, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: T }> {
  const res = await app.request(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Permission entries per user of an HKD/HTD response: AdminOrderType and the AuthorisationLevel attribute, if any */
function userPermissions(xml: string): Record<string, { adminType: string; level: string | null }[]> {
  const result: Record<string, { adminType: string; level: string | null }[]> = {};
  const users = parseXml(xml).getElementsByTagNameNS('*', 'UserInfo');
  for (let i = 0; i < users.length; i++) {
    const user = users.item(i)!;
    const permissions = user.getElementsByTagNameNS('*', 'Permission');
    const entries: { adminType: string; level: string | null }[] = [];
    for (let j = 0; j < permissions.length; j++) {
      const permission = permissions.item(j)!;
      entries.push({
        adminType: permission.getElementsByTagNameNS('*', 'AdminOrderType').item(0)!.textContent ?? '',
        level: permission.hasAttribute('AuthorisationLevel') ? permission.getAttribute('AuthorisationLevel') : null,
      });
    }
    result[user.getElementsByTagNameNS('*', 'UserID').item(0)!.textContent ?? ''] = entries;
  }
  return result;
}

function expectPermissionsForClass(entries: { adminType: string; level: string | null }[] | undefined, signatureClass: SignatureClass): void {
  expect(entries).toBeDefined();
  for (const { adminType, level } of entries!) {
    expect(level, adminType).toBe(UPLOAD_ORDER_TYPES.includes(adminType) ? signatureClass : null);
  }
  const adminTypes = entries!.map((e) => e.adminType);
  expect(adminTypes).toEqual(expect.arrayContaining(['BTU', 'PUB', 'HCA', 'HCS', 'SPR', 'BTD', 'HKD', 'HTD', 'HAC', 'HVZ', 'HVD', 'HVT']));
  if (signatureClass === 'T') {
    expect(adminTypes).not.toContain('HVE');
    expect(adminTypes).not.toContain('HVS');
  } else {
    expect(adminTypes).toEqual(expect.arrayContaining(['HVE', 'HVS']));
  }
}

describe('Signature classes (EBICS)', () => {
  interface Ctx {
    app: App;
    store: SqliteStore;
    session: EbicsSession;
    /** The partner's own account, created on activation */
    account: Account;
    /** A second customer at this bank */
    bob: Account;
  }

  let ctx: Ctx;
  let restoreFlags: () => void;

  const post = (app: App) => async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (app: App) => (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });

  beforeEach(async () => {
    restoreFlags = saveFlags();
    const { app, store } = createTestApp();
    const session = await enrolSubscriber({ post: post(app), activate: activate(app), store, partnerId: PARTNER_ID, userId: USER_ID });
    const account = store.listAccountsForPartner(PARTNER_ID)[0]!;
    store.createBooking({ accountId: account.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
    const person = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
    const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
    const bob = store.createAccount({ personId: person.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });
    ctx = { app, store, session, account, bob };
  });

  afterEach(() => restoreFlags());

  const setClass = (signatureClass: SignatureClass, userId = USER_ID) => ctx.store.updateSubscriberSettings(PARTNER_ID, userId, { signatureClass });
  const balances = () => [ctx.store.getAccount(ctx.account.id)!.currentBalanceCents, ctx.store.getAccount(ctx.bob.id)!.currentBalanceCents];
  const statuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);
  const actions = (orderId: string) => ctx.store.listHacEvents({ orderId }).map((e) => e.action);
  const signatures = (orderId: string) => ctx.store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind, s.signatureClass]);

  /** pain.001 over 12.34 EUR from the partner's account to Bob */
  const creditTransfer = (id: string) =>
    buildPain001Document({
      msgId: `MSG-${id}`,
      payments: [
        {
          pmtInfId: `PMT-${id}`,
          debtorName: 'Musterfirma GmbH',
          debtorIban: ctx.account.iban,
          transactions: [{ endToEndId: `E2E-${id}`, creditorName: 'Bob Mustermann', creditorIban: ctx.bob.iban, amount: '12.34' }],
        },
      ],
    });

  /** pain.008 collecting 5.00 EUR from Bob into the partner's account */
  const directDebit = (id: string) =>
    buildPain008Document({
      msgId: `MSG-${id}`,
      payments: [
        {
          pmtInfId: `PMT-${id}`,
          creditorName: 'Musterfirma GmbH',
          creditorIban: ctx.account.iban,
          transactions: [{ endToEndId: `E2E-${id}`, debtorName: 'Bob Mustermann', debtorIban: ctx.bob.iban, amount: '5.00', mandateId: 'MNDT-1' }],
        },
      ],
    });

  const EXECUTED_BALANCES = [1_000_000 - 1234, 1234];
  const UNCHANGED_BALANCES = [1_000_000, 0];

  describe('uploads with SignatureFlag and requestEDS', () => {
    it('executes an upload by class E at once', async () => {
      const { orderId, code } = await upload(ctx.session, creditTransfer('E'), SCI, 'requestEDS');
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(balances()).toEqual(EXECUTED_BALANCES);
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_POS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'E']]);
    });

    it.each(NOT_AUTHORISING)('holds an upload by class %s in the VEU with a VEU_FORWARDING note', async (signatureClass) => {
      setClass(signatureClass);
      const { orderId, code } = await upload(ctx.session, creditTransfer(`VEU-${signatureClass}`), SCI, 'requestEDS');
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);
      expect(balances()).toEqual(UNCHANGED_BALANCES);

      const events = ctx.store.listHacEvents({ orderId });
      expect(events.map((e) => e.action)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'VEU_FORWARDING']);
      expect(events[2]).toMatchObject({ reasonCode: 'DS06', additionalInfo: [`Unterschriftsklasse ${signatureClass}: weitere Unterschrift erforderlich`] });
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', signatureClass]]);
    });

    it('does not hold direct debits: a pain.008 by class A is executed', async () => {
      setClass('A');
      const { orderId, code } = await upload(ctx.session, directDebit('SDD-A'), SDD, 'requestEDS');
      expect(code).toBe('000000');
      expect(ctx.store.listPaymentOrders()).toEqual([]);
      expect(balances()).toEqual([1_000_000 + 500, -500]);
      expect(actions(orderId)).not.toContain('VEU_FORWARDING');
      expect(actions(orderId).at(-1)).toBe('ORDER_HAC_FINAL_POS');
    });
  });

  describe('uploads with SignatureFlag but without requestEDS', () => {
    it('executes an upload by class E at once', async () => {
      const { orderId, code } = await upload(ctx.session, creditTransfer('FLAG-E'), SCI, 'signatureFlag');
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(balances()).toEqual(EXECUTED_BALANCES);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'E']]);
    });

    it.each(NOT_AUTHORISING)('rejects an upload by class %s with 091301 and DS19 in the customer protocol', async (signatureClass) => {
      setClass(signatureClass);
      const { orderId, code } = await upload(ctx.session, creditTransfer(`REJECT-${signatureClass}`), SCI, 'signatureFlag');
      expect(code).toBe('091301');
      expect(ctx.store.listPaymentOrders()).toEqual([]);
      expect(balances()).toEqual(UNCHANGED_BALANCES);
      expect(signatures(orderId)).toEqual([]);

      const message = `Unterschriftsklasse ${signatureClass} von ${USER_ID} reicht nicht aus und keine VEU angefordert`;
      const events = ctx.store.listHacEvents({ orderId });
      expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
        ['FILE_UPLOAD', 'TS01'],
        ['ES_VERIFICATION', 'DS19'],
        ['ORDER_HAC_FINAL_NEG', undefined],
      ]);
      expect(events[1]!.additionalInfo).toEqual([message]);
      expect(events[2]!.additionalInfo).toContain(message);
    });

    it('rejects a pain.008 by class B with 091301 as well, without booking', async () => {
      setClass('B');
      const { orderId, code } = await upload(ctx.session, directDebit('SDD-B'), SDD, 'signatureFlag');
      expect(code).toBe('091301');
      expect(balances()).toEqual(UNCHANGED_BALANCES);
      expect(ctx.store.listHacEvents({ orderId }).map((e) => [e.action, e.reasonCode])).toEqual([
        ['FILE_UPLOAD', 'TS01'],
        ['ES_VERIFICATION', 'DS19'],
        ['ORDER_HAC_FINAL_NEG', undefined],
      ]);
    });
  });

  describe('uploads without SignatureFlag', () => {
    it.each(ALL_CLASSES)('executes an upload by class %s; its signature counts as transport signature T', async (signatureClass) => {
      setClass(signatureClass);
      const { orderId, code } = await upload(ctx.session, creditTransfer(`NOFLAG-${signatureClass}`), SCI, 'none');
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(ctx.store.listPaymentOrders({ orderId })[0]!.requestedEds).toBe(false);
      expect(balances()).toEqual(EXECUTED_BALANCES);
      expect(actions(orderId)).toEqual(['FILE_UPLOAD', 'ES_VERIFICATION', 'ORDER_HAC_FINAL_POS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'T']]);
    });
  });

  describe('HKD and HTD', () => {
    it('lists each user of the partner with the signature class on the upload permissions (HKD)', async () => {
      for (const [userId, signatureClass] of [['USER2', 'A'], ['USER3', 'B'], ['USER4', 'T']] as const) {
        expect((await api(ctx.app, '/subscribers', { method: 'POST', body: { partnerId: PARTNER_ID, userId, signatureClass } })).status).toBe(201);
      }

      const hkd = await downloadOrder(ctx.session, 'HKD');
      expect(hkd.code).toBe('000000');
      const xml = hkd.data!.toString('utf8');
      expect(() => validateXml(xml, 'response')).not.toThrow();

      const permissions = userPermissions(xml);
      expect(Object.keys(permissions).sort()).toEqual([USER_ID, 'USER2', 'USER3', 'USER4']);
      expectPermissionsForClass(permissions[USER_ID], 'E');
      expectPermissionsForClass(permissions['USER2'], 'A');
      expectPermissionsForClass(permissions['USER3'], 'B');
      expectPermissionsForClass(permissions['USER4'], 'T');
      // The partner still offers the VEU; only the class T user is not permitted to sign or cancel
      expect(localTexts(xml, 'PartnerInfo/OrderInfo/AdminOrderType')).toEqual(expect.arrayContaining(['HVE', 'HVS']));
    });

    it("reports the requesting user's class in HTD and follows admin changes", async () => {
      for (const signatureClass of ALL_CLASSES) {
        if (signatureClass !== 'E') {
          const patched = await api(ctx.app, `/subscribers/${PARTNER_ID}/${USER_ID}`, { method: 'PATCH', body: { signatureClass } });
          expect(patched.status).toBe(200);
        }
        const htd = await downloadOrder(ctx.session, 'HTD');
        expect(htd.code, signatureClass).toBe('000000');
        const xml = htd.data!.toString('utf8');
        expect(() => validateXml(xml, 'response')).not.toThrow();
        const permissions = userPermissions(xml);
        expect(Object.keys(permissions)).toEqual([USER_ID]);
        expectPermissionsForClass(permissions[USER_ID], signatureClass);
      }
    });

    it('refuses HVE and HVS by a class T user with 090003', async () => {
      setClass('A');
      const content = creditTransfer('HVE-T');
      const { orderId } = await upload(ctx.session, content, SCI, 'requestEDS');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);

      const technical = await enrolSubscriber({ post: post(ctx.app), activate: activate(ctx.app), store: ctx.store, partnerId: PARTNER_ID, userId: 'USER2' });
      setClass('T', 'USER2');
      const ref: VeuOrderRef = { partnerId: PARTNER_ID, orderId, serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' };
      expect((await sendVeuSignature(technical, 'HVE', ref)).code).toBe('090003');
      expect((await sendVeuSignature(technical, 'HVS', ref)).code).toBe('090003');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A']]);

      // With a single signature (E) the same user releases the order
      setClass('E', 'USER2');
      expect((await sendVeuSignature(technical, 'HVE', ref, { dataDigest: orderDataDigest(content) })).code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
    });
  });
});

describe('Signature classes (admin API)', () => {
  let app: App;
  let store: SqliteStore;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  const INVALID_VALUES: unknown[] = ['X', 'e', '', 'EA', 1, true, null, ['E'], { signatureClass: 'E' }];
  const listed = async () => Object.fromEntries(((await api(app, '/subscribers')).json as { userId: string; signatureClass: string }[]).map((s) => [s.userId, s.signatureClass]));

  it('creates subscribers with class E by default or with the given class', async () => {
    const created = await api(app, '/subscribers', { method: 'POST', body: { partnerId: 'P1', userId: 'DEFAULT' } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ partnerId: 'P1', userId: 'DEFAULT', signatureClass: 'E', protocolDownloadsAllowed: true });

    for (const signatureClass of ALL_CLASSES) {
      const res = await api(app, '/subscribers', { method: 'POST', body: { partnerId: 'P1', userId: `CLASS${signatureClass}`, signatureClass } });
      expect(res.status, signatureClass).toBe(201);
      expect(res.json.signatureClass).toBe(signatureClass);
      expect((await api(app, `/subscribers/P1/CLASS${signatureClass}`)).json.signatureClass).toBe(signatureClass);
      expect(store.getSubscriber('P1', `CLASS${signatureClass}`)!.signatureClass).toBe(signatureClass);
    }

    const both = await api(app, '/subscribers', { method: 'POST', body: { partnerId: 'P1', userId: 'BOTH', signatureClass: 'T', protocolDownloadsAllowed: false } });
    expect(both.json).toMatchObject({ signatureClass: 'T', protocolDownloadsAllowed: false });

    expect(await listed()).toEqual({ DEFAULT: 'E', CLASSE: 'E', CLASSA: 'A', CLASSB: 'B', CLASST: 'T', BOTH: 'T' });
  });

  it('rejects an invalid class on creation without creating the subscriber', async () => {
    for (const value of INVALID_VALUES) {
      const res = await api(app, '/subscribers', { method: 'POST', body: { partnerId: 'P1', userId: 'INVALID', signatureClass: value } });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.json.error).toBe('signatureClass must be one of E, A, B, T');
    }
    const invalidProtocol = await api(app, '/subscribers', { method: 'POST', body: { partnerId: 'P1', userId: 'INVALID', signatureClass: 'A', protocolDownloadsAllowed: 'no' } });
    expect(invalidProtocol.status).toBe(400);
    expect((await api(app, '/subscribers/P1/INVALID')).status).toBe(404);
    expect(store.listSubscribers()).toEqual([]);
  });

  it('changes the class with PATCH and keeps the other setting', async () => {
    store.createSubscriber('P1', 'U1');
    for (const signatureClass of ['A', 'B', 'T', 'E'] as const) {
      const res = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { signatureClass } });
      expect(res.status, signatureClass).toBe(200);
      expect(res.json).toMatchObject({ partnerId: 'P1', userId: 'U1', signatureClass, protocolDownloadsAllowed: true });
      expect((await api(app, '/subscribers/P1/U1')).json.signatureClass).toBe(signatureClass);
      expect(await listed()).toEqual({ U1: signatureClass });
    }

    {
      const protocolOnly = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { protocolDownloadsAllowed: false } });
      expect(protocolOnly.json).toMatchObject({ signatureClass: 'E', protocolDownloadsAllowed: false });
      const both = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { signatureClass: 'B', protocolDownloadsAllowed: true } });
      expect(both.json).toMatchObject({ signatureClass: 'B', protocolDownloadsAllowed: true });
      const classOnly = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { signatureClass: 'A' } });
      expect(classOnly.json).toMatchObject({ signatureClass: 'A', protocolDownloadsAllowed: true });
    }
  });

  it('validates PATCH: 400 for invalid values or no setting, 404 for unknown subscribers', async () => {
    store.createSubscriber('P1', 'U1');
    store.updateSubscriberSettings('P1', 'U1', { signatureClass: 'B' });

    for (const value of INVALID_VALUES) {
      const res = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { signatureClass: value } });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(res.json.error).toBe('signatureClass must be one of E, A, B, T');
    }
    // One invalid field refuses the whole update
    expect((await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: { signatureClass: 'E', protocolDownloadsAllowed: 'yes' } })).status).toBe(400);

    const empty = await api(app, '/subscribers/P1/U1', { method: 'PATCH', body: {} });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('protocolDownloadsAllowed or signatureClass is required');
    expect((await api(app, '/subscribers/P1/U1', { method: 'PATCH' })).status).toBe(400);

    expect((await api(app, '/subscribers/NOPE/NOBODY', { method: 'PATCH', body: { signatureClass: 'A' } })).status).toBe(404);
    expect(store.getSubscriber('NOPE', 'NOBODY')).toBeUndefined();
    expect(store.getSubscriber('P1', 'U1')).toMatchObject({ signatureClass: 'B', protocolDownloadsAllowed: true });
  });
});

describe('Signature classes (database migration)', () => {
  it('gives subscribers of a database without the signature_class column class E', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebics-signature-class-'));
    const path = join(dir, 'old.db');
    try {
      const old = new Database(path);
      old.exec(`
        CREATE TABLE subscribers (
          partner_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'NEW',
          signature_version TEXT, signature_certificate TEXT, authentication_version TEXT, authentication_certificate TEXT,
          encryption_version TEXT, encryption_certificate TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (partner_id, user_id)
        );
        INSERT INTO subscribers (partner_id, user_id) VALUES ('P1', 'OLD1'), ('P1', 'OLD2');
      `);
      old.close();

      const migrated = new SqliteStore(path);
      expect(migrated.getSubscriber('P1', 'OLD1')).toMatchObject({ state: 'NEW', signatureClass: 'E', protocolDownloadsAllowed: true });
      expect(migrated.listSubscribers().map((s) => s.signatureClass)).toEqual(['E', 'E']);

      const check = new Database(path);
      try {
        const columns = check.prepare('PRAGMA table_info(subscribers)').all() as { name: string; dflt_value: string | null; notnull: number }[];
        expect(columns.find((c) => c.name === 'signature_class')).toMatchObject({ dflt_value: "'E'", notnull: 1 });
      } finally {
        check.close();
      }

      migrated.updateSubscriberSettings('P1', 'OLD2', { signatureClass: 'T' });
      migrated.createSubscriber('P1', 'NEW1');

      // Opening again is idempotent and keeps the classes
      const reopened = new SqliteStore(path);
      expect(Object.fromEntries(reopened.listSubscribers().map((s) => [s.userId, s.signatureClass]))).toEqual({ OLD1: 'E', OLD2: 'T', NEW1: 'E' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
