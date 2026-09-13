import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  asTechnicalSubscriberRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsUploadInitRequest,
  buildEbicsUploadTransferRequest,
  buildEbicsVeuSignatureRequest,
  buildHpbRequest,
  buildPain001Document,
  decryptDownloadResponse,
  decryptDownloadResponseBytes,
  encryptUploadContent,
  esSigner,
  readBusinessReturnCode,
  readOrderId,
  type EsSignatures,
  type TestClientKeys,
  type UploadOptions,
  type VeuOrderRef,
} from '../helpers/test-client.js';
import { enrolSubscriber, localTexts, uploadOrder, type EbicsSession, type PostXml } from '../helpers/ebics-session.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { ReturnCode } from '../../src/protocol/return-codes.js';
import { calculateIban } from '../../src/banking/iban.js';
import { SubscriberState, type Account } from '../../src/store/types.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

const TECHNICAL_USER = 'SYSTEM1';
const SECOND_USER = 'USER2';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
const SIGNED: UploadOptions = { scope: 'DE', serviceOption: 'VOI', signatureFlag: true };

interface Ctx {
  store: SqliteStore;
  post: PostXml;
  /** USER1, class A */
  human: EbicsSession;
  /** USER2, class E */
  second: EbicsSession;
  /** SYSTEM1, the technical subscriber of the customer; class E, which must not matter */
  technical: EbicsSession;
  debtor: Account;
  creditor: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const enrol = (userId: string, signatureClass: 'A' | 'E') => enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId, signatureClass });
  const human = await enrol(USER_ID, 'A');
  const second = await enrol(SECOND_USER, 'E');
  const technical = await enrol(TECHNICAL_USER, 'E');

  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });

  return { store, post, human, second, technical, debtor, creditor };
}

function pain001(ctx: Ctx, id: string): string {
  return buildPain001Document({
    msgId: `MSG-${id}`,
    payments: [
      {
        pmtInfId: `PMT-${id}`,
        debtorName: 'Musterfirma GmbH',
        debtorIban: ctx.debtor.iban,
        transactions: [{ endToEndId: `E2E-${id}`, creditorName: 'Bob Mustermann', creditorIban: ctx.creditor.iban, amount: '12.34' }],
      },
    ],
  });
}

const technicalCode = (body: string) => xpathString('//ebics:header/ebics:mutable/ebics:ReturnCode/text()', parseXml(body));

describe('Technical subscribers (SystemID, EBICS 3.0.2 chapter 3.7)', () => {
  let ctx: Ctx;
  let restoreFlags: () => void;

  beforeEach(async () => {
    const saved = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
    for (const flag of FLAGS) delete process.env[flag];
    restoreFlags = () => {
      for (const flag of FLAGS) {
        if (saved[flag] === undefined) delete process.env[flag];
        else process.env[flag] = saved[flag];
      }
    };
    ctx = await setup();
  });

  afterEach(() => restoreFlags());

  /** Sends the request with SystemID, signed by the technical subscriber (or by the given keys) */
  const viaTechnical = (xml: string, systemId = TECHNICAL_USER, keys: TestClientKeys = ctx.technical.keys) =>
    ctx.post(asTechnicalSubscriberRequest(xml, systemId, keys));
  const htd = (userId = USER_ID) => buildEbicsDownloadInitRequest(HOST_ID, PARTNER_ID, userId, ctx.human.keys, ctx.human.bankCerts, 'HTD');
  const statuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);
  const signatures = (orderId: string) => ctx.store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind, s.signatureClass]);

  describe('authentication and encryption', () => {
    it('authenticates a download with the key of the technical subscriber and encrypts the response for it', async () => {
      const body = await viaTechnical(htd());
      expect(technicalCode(body)).toBe(ReturnCode.EBICS_OK);
      const xml = decryptDownloadResponseBytes(body, ctx.technical.keys.encKeyPair.privateKey).data.toString('utf8');
      // Order data and permissions follow PartnerID and UserID, not SystemID
      expect(localTexts(xml, 'UserInfo/UserID')).toEqual([USER_ID]);
      expect(() => decryptDownloadResponseBytes(body, ctx.human.keys.encKeyPair.privateKey)).toThrow();
    });

    it('HPB: authenticated with the technical subscriber and encrypted for it (chapter 4.4.2.1)', async () => {
      const body = await viaTechnical(buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, ctx.human.keys));
      expect(technicalCode(body)).toBe(ReturnCode.EBICS_OK);
      expect(decryptDownloadResponse(body, ctx.technical.keys.encKeyPair.privateKey).orderData).toContain('HPBResponseOrderData');
    });

    it('answers EBICS_AUTHENTICATION_FAILED unless the technical subscriber is known, ready and signed the request (chapter 5.5.1.2.1)', async () => {
      // Signed by the subscriber of UserID instead of the technical subscriber
      expect(technicalCode(await viaTechnical(htd(), TECHNICAL_USER, ctx.human.keys))).toBe(ReturnCode.EBICS_AUTHENTICATION_FAILED);
      expect(technicalCode(await viaTechnical(htd(), 'NOBODY'))).toBe(ReturnCode.EBICS_AUTHENTICATION_FAILED);

      ctx.store.updateSubscriberState(PARTNER_ID, TECHNICAL_USER, SubscriberState.SUSPENDED);
      expect(technicalCode(await viaTechnical(htd()))).toBe(ReturnCode.EBICS_AUTHENTICATION_FAILED);
      expect(technicalCode(await viaTechnical(buildHpbRequest(HOST_ID, PARTNER_ID, USER_ID, ctx.human.keys)))).toBe(ReturnCode.EBICS_AUTHENTICATION_FAILED);
    });

    it('reports an unknown or not ready subscriber of UserID only after the technical subscriber was authenticated', async () => {
      expect(technicalCode(await viaTechnical(htd('NOBODY')))).toBe(ReturnCode.EBICS_USER_UNKNOWN);
      expect(technicalCode(await viaTechnical(buildHpbRequest(HOST_ID, PARTNER_ID, 'NOBODY', ctx.human.keys)))).toBe(ReturnCode.EBICS_USER_UNKNOWN);

      ctx.store.updateSubscriberState(PARTNER_ID, USER_ID, SubscriberState.SUSPENDED);
      expect(technicalCode(await viaTechnical(htd()))).toBe(ReturnCode.EBICS_INVALID_USER_STATE);
    });
  });

  describe('signatures', () => {
    async function technicalUpload(content: string, esSignatures: EsSignatures) {
      const enc = encryptUploadContent(content, ctx.human.bankEncPubKey, esSignatures);
      const initBody = await viaTechnical(
        buildEbicsUploadInitRequest(HOST_ID, PARTNER_ID, USER_ID, ctx.human.keys, ctx.human.bankCerts, 'SCI', 'pain.001', enc, SIGNED),
      );
      expect(readBusinessReturnCode(initBody)).toBe('000000');
      const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(initBody))!;
      const transferBody = await ctx.post(buildEbicsUploadTransferRequest(HOST_ID, ctx.technical.keys, transactionId, 1, true, enc.segments[0]!));
      return { orderId: readOrderId(initBody)!, code: readBusinessReturnCode(transferBody) };
    }

    it('submits the EUs of other subscribers, which authorise the order', async () => {
      const { orderId, code } = await technicalUpload(pain001(ctx, 'TECH-E'), esSigner(PARTNER_ID, SECOND_USER, ctx.second.keys));
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[SECOND_USER, 'UPLOAD', 'E']]);
    });

    it('counts its own EU as transport signature, whatever its signature class', async () => {
      expect(ctx.store.getSubscriber(PARTNER_ID, TECHNICAL_USER)!.signatureClass).toBe('E');
      const { orderId, code } = await technicalUpload(pain001(ctx, 'TECH-T'), esSigner(PARTNER_ID, TECHNICAL_USER, ctx.technical.keys));
      expect(code).toBe('090003');
      expect(ctx.store.listPaymentOrders()).toEqual([]);
      expect(ctx.store.listHacEvents({ orderId }).map((e) => [e.action, e.reasonCode])).toContainEqual(['ES_VERIFICATION', 'DS19']);
    });

    it('HVE/HVS: its own EU neither signs nor cancels (090003); the EU of another subscriber sent by it signs', async () => {
      const content = pain001(ctx, 'TECH-HVE');
      const upload = await uploadOrder(ctx.human, content, { upload: { scope: 'DE', serviceOption: 'VOI', requestEds: true } });
      expect(readBusinessReturnCode(upload.transferBody)).toBe('000000');
      const orderId = upload.orderId!;
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);

      const ref: VeuOrderRef = { partnerId: PARTNER_ID, orderId, serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' };
      const veuRequest = (orderType: 'HVE' | 'HVS', esSignatures: EsSignatures) =>
        viaTechnical(
          buildEbicsVeuSignatureRequest(HOST_ID, PARTNER_ID, SECOND_USER, ctx.second.keys, ctx.second.bankCerts, orderType, ref, ctx.second.bankEncPubKey, {
            orderData: content,
            signatures: esSignatures,
          }),
        );
      for (const orderType of ['HVE', 'HVS'] as const) {
        expect(readBusinessReturnCode(await veuRequest(orderType, esSigner(PARTNER_ID, TECHNICAL_USER, ctx.technical.keys))), orderType).toBe('090003');
      }
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);

      expect(readBusinessReturnCode(await veuRequest('HVE', esSigner(PARTNER_ID, SECOND_USER, ctx.second.keys)))).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
    });
  });
});
