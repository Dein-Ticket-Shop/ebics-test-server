import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp, postEbics, HOST_ID, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import {
  buildEbicsKeyMgmtUploadInitRequest,
  buildEbicsUploadTransferRequest,
  buildPain001Document,
  buildUserSignatureData,
  encryptUploadContent,
  esSigner,
  generateTestClientKeys,
  readBusinessReturnCode,
  type EsSignatures,
  type TestClientKeys,
  type UploadOptions,
  type VeuOrderRef,
} from '../helpers/test-client.js';
import { enrolSubscriber, sendVeuSignature, sessionSigner, uploadOrder, type EbicsSession, type PostXml } from '../helpers/ebics-session.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { calculateIban } from '../../src/banking/iban.js';
import { SubscriberState, type Account, type SignatureClass } from '../../src/store/types.js';
import type { SqliteStore } from '../../src/store/sqlite-store.js';

const SECOND_USER = 'USER2';
const THIRD_USER = 'USER3';
const OTHER_PARTNER = 'PARTNER9';
const FLAGS = ['EBICS_VOP_CONFIRMATION', 'EBICS_VOP_DEFAULT', 'EBICS_HAC_FORMAT', 'EBICS_HAC_DOWNLOAD_EVENTS'] as const;
/** SignatureFlag without requestEDS: the EUs of the upload must authorise it */
const SIGNED: UploadOptions = { scope: 'DE', serviceOption: 'VOI', signatureFlag: true };
const REQUEST_EDS: UploadOptions = { scope: 'DE', serviceOption: 'VOI', requestEds: true };

interface Ctx {
  store: SqliteStore;
  post: PostXml;
  activate: (partnerId: string, userId: string) => Promise<unknown>;
  /** USER1: uploads the orders */
  uploader: EbicsSession;
  /** USER2 of the same customer */
  signer: EbicsSession;
  /** USER3 of the same customer */
  third: EbicsSession;
  debtor: Account;
  creditor: Account;
}

async function setup(): Promise<Ctx> {
  const { app, store } = createTestApp();
  const post = async (xml: string) => (await postEbics(app, xml)).text();
  const activate = (partnerId: string, userId: string) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' });
  const enrol = (userId: string) => enrolSubscriber({ post, activate, store, partnerId: PARTNER_ID, userId });
  const uploader = await enrol(USER_ID);
  const signer = await enrol(SECOND_USER);
  const third = await enrol(THIRD_USER);

  const debtor = store.listAccountsForPartner(PARTNER_ID)[0]!;
  store.createBooking({ accountId: debtor.id, amountCents: 1_000_000, currency: 'EUR', valueDate: '2025-01-01', bookingDate: '2025-01-01', transactionCode: 'NTRF' });
  const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
  const accountNumber = store.getNextAccountSequence().toString().padStart(10, '0');
  const creditor = store.createAccount({ personId: bob.id, iban: calculateIban('10020030', accountNumber), accountNumber, currency: 'EUR', name: 'Bob Konto' });

  return { store, post, activate, uploader, signer, third, debtor, creditor };
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

/** SCI upload by the session's subscriber with the given EUs; returns the OrderID and the return code of the last Transfer */
async function upload(session: EbicsSession, content: string, signatures: EsSignatures, options: UploadOptions = SIGNED) {
  const result = await uploadOrder(session, content, { upload: options, signatures });
  expect(readBusinessReturnCode(result.initBody)).toBe('000000');
  return { orderId: result.orderId!, code: readBusinessReturnCode(result.transferBody) };
}

function certBase64(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
}

function pubOrderData(keys: TestClientKeys): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SignaturePubKeyOrderData xmlns="http://www.ebics.org/S002" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <SignaturePubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certBase64(keys.signatureCert)}</ds:X509Certificate></ds:X509Data>
    <SignatureVersion>A006</SignatureVersion>
  </SignaturePubKeyInfo>
  <PartnerID>${PARTNER_ID}</PartnerID>
  <UserID>${USER_ID}</UserID>
</SignaturePubKeyOrderData>`;
}

function hcaOrderData(keys: TestClientKeys): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HCARequestOrderData xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <AuthenticationPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certBase64(keys.authCert)}</ds:X509Certificate></ds:X509Data>
    <AuthenticationVersion>X002</AuthenticationVersion>
  </AuthenticationPubKeyInfo>
  <EncryptionPubKeyInfo>
    <ds:X509Data><ds:X509Certificate>${certBase64(keys.encCert)}</ds:X509Certificate></ds:X509Data>
    <EncryptionVersion>E002</EncryptionVersion>
  </EncryptionPubKeyInfo>
  <PartnerID>${PARTNER_ID}</PartnerID>
  <UserID>${USER_ID}</UserID>
</HCARequestOrderData>`;
}

/** PUB/HCA/HCS upload (Initialisation and Transfer) with the given EUs; returns the return code of the last Transfer */
async function keyManagementUpload(session: EbicsSession, orderType: 'PUB' | 'HCA' | 'HCS', content: string, signatures: EsSignatures) {
  const enc = encryptUploadContent(content, session.bankEncPubKey, signatures);
  const initBody = await session.post(
    buildEbicsKeyMgmtUploadInitRequest(HOST_ID, session.partnerId, session.userId, session.keys, session.bankCerts, orderType, enc),
  );
  expect(readBusinessReturnCode(initBody)).toBe('000000');
  const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(initBody))!;
  let transferBody = '';
  for (let i = 0; i < enc.segments.length; i++) {
    transferBody = await session.post(buildEbicsUploadTransferRequest(HOST_ID, session.keys, transactionId, i + 1, i === enc.segments.length - 1, enc.segments[i]!));
  }
  return readBusinessReturnCode(transferBody);
}

interface RefusedSignature {
  name: string;
  prepare?: (ctx: Ctx) => void;
  signatures: (ctx: Ctx, content: string) => EsSignatures;
  code: string;
  reasonCode: string;
}

/** EUs the bank refuses (EBICS 3.0.2 chapter 5.3 and annex 1), with the return code and the HAC reason code */
const REFUSED: RefusedSignature[] = [
  { name: 'an EU made with another key', signatures: (ctx) => esSigner(PARTNER_ID, USER_ID, ctx.signer.keys), code: '091301', reasonCode: 'DS0B' },
  {
    name: 'an EU over other order data',
    signatures: (ctx, content) => ({ signatureDataXml: buildUserSignatureData(`${content} `, [sessionSigner(ctx.uploader)]) }),
    code: '091301',
    reasonCode: 'DS0B',
  },
  { name: 'an EU of an unknown user', signatures: (ctx) => esSigner(PARTNER_ID, 'NOBODY', ctx.uploader.keys), code: '091304', reasonCode: 'DS14' },
  { name: 'an EU of a user of another customer', signatures: (ctx) => esSigner(OTHER_PARTNER, USER_ID, ctx.uploader.keys), code: '091120', reasonCode: 'DS0G' },
  {
    name: 'an EU of a suspended user',
    prepare: (ctx) => ctx.store.updateSubscriberState(PARTNER_ID, SECOND_USER, SubscriberState.SUSPENDED),
    signatures: (ctx) => sessionSigner(ctx.signer),
    code: '091305',
    reasonCode: 'DS0C',
  },
  {
    name: 'an EU of a user who is not activated',
    prepare: (ctx) => ctx.store.updateSubscriberState(PARTNER_ID, SECOND_USER, SubscriberState.INITIALIZED),
    signatures: (ctx) => sessionSigner(ctx.signer),
    code: '091305',
    reasonCode: 'DS27',
  },
  {
    name: 'an EU of a user without signature key',
    prepare: (ctx) => ctx.store.updateSubscriberKeys(PARTNER_ID, SECOND_USER, { signatureCertificate: '' }),
    signatures: (ctx) => sessionSigner(ctx.signer),
    code: '091301',
    reasonCode: 'DS0E',
  },
  { name: 'an A005 EU of a user with an A006 key', signatures: (ctx) => sessionSigner(ctx.uploader, 'A005'), code: '091301', reasonCode: 'DS16' },
  { name: 'two EUs of the same user', signatures: (ctx) => [sessionSigner(ctx.uploader), sessionSigner(ctx.uploader)], code: '091306', reasonCode: 'DS26' },
  {
    name: 'signature data not conforming to ebics_signature_S002.xsd',
    signatures: () => ({
      signatureDataXml: '<?xml version="1.0" encoding="UTF-8"?><UserSignatureData xmlns="http://www.ebics.org/S002"><OrderSignatureData><SignatureVersion>A006</SignatureVersion></OrderSignatureData></UserSignatureData>',
    }),
    code: '091111',
    reasonCode: 'TD03',
  },
];

describe('Electronic signatures (EUs)', () => {
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

  const setClass = (userId: string, signatureClass: SignatureClass) => ctx.store.updateSubscriberSettings(PARTNER_ID, userId, { signatureClass });
  const statuses = (orderId: string) => ctx.store.listPaymentOrders({ partnerId: PARTNER_ID, orderId }).map((o) => o.status);
  const signatures = (orderId: string) => ctx.store.listOrderSignatures(PARTNER_ID, orderId).map((s) => [s.userId, s.kind, s.signatureClass]);
  const events = (orderId: string) => ctx.store.listHacEvents({ orderId }).map((e) => [e.action, e.reasonCode]);
  const refOf = (orderId: string): VeuOrderRef => ({ partnerId: PARTNER_ID, orderId, serviceName: 'SCI', scope: 'DE', serviceOption: 'VOI', msgName: 'pain.001' });

  describe('uploads (BTU)', () => {
    it('verifies the EU of the uploader and executes the order', async () => {
      const { orderId, code } = await upload(ctx.uploader, pain001(ctx, 'OK'), sessionSigner(ctx.uploader));
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(events(orderId)).toContainEqual(['ES_VERIFICATION', 'DS01']);
    });

    it('does not include CR and LF in the signed data (chapter 14)', async () => {
      const content = pain001(ctx, 'CRLF').replace(/\n/g, '\r\n');
      expect(content).toContain('\r\n');
      const { orderId, code } = await upload(ctx.uploader, content, { signatureDataXml: buildUserSignatureData(content.replace(/[\r\n]/g, ''), [sessionSigner(ctx.uploader)]) });
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
    });

    it.each(REFUSED)('refuses $name with $code and $reasonCode in the customer protocol', async (refused) => {
      refused.prepare?.(ctx);
      const content = pain001(ctx, 'REFUSED');
      const { orderId, code } = await upload(ctx.uploader, content, refused.signatures(ctx, content));
      expect(code).toBe(refused.code);
      expect(ctx.store.listPaymentOrders()).toEqual([]);
      expect(events(orderId)).toEqual([
        ['FILE_UPLOAD', 'TS01'],
        ['ES_VERIFICATION', refused.reasonCode],
        ['ORDER_HAC_FINAL_NEG', undefined],
      ]);
    });

    it('authorises with the EUs of several users in one upload (A + B)', async () => {
      setClass(USER_ID, 'A');
      setClass(SECOND_USER, 'B');
      const { orderId, code } = await upload(ctx.uploader, pain001(ctx, 'AB'), [sessionSigner(ctx.uploader), sessionSigner(ctx.signer)]);
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([
        [USER_ID, 'UPLOAD', 'A'],
        [SECOND_USER, 'UPLOAD', 'B'],
      ]);
    });

    it('lets a technical user (class T) submit the EU of a class E user', async () => {
      setClass(USER_ID, 'T');
      const { orderId, code } = await upload(ctx.uploader, pain001(ctx, 'T-E'), sessionSigner(ctx.signer));
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([[SECOND_USER, 'UPLOAD', 'E']]);
    });
  });

  describe('HVE and HVS', () => {
    /** Upload by USER1 with class A and requestEDS: waits in the VEU */
    async function heldOrder(id: string) {
      setClass(USER_ID, 'A');
      const content = pain001(ctx, id);
      const { orderId, code } = await upload(ctx.uploader, content, sessionSigner(ctx.uploader), REQUEST_EDS);
      expect(code).toBe('000000');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);
      return { content, orderId, ref: refOf(orderId) };
    }

    it('HVE verifies the EU over the order data waiting in the VEU', async () => {
      const { content, orderId, ref } = await heldOrder('HVE');
      expect((await sendVeuSignature(ctx.signer, 'HVE', ref, { orderData: `${content} ` })).code).toBe('091301');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A']]);

      expect((await sendVeuSignature(ctx.signer, 'HVE', ref)).code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
    });

    it('HVE carries the EUs of several users; each one is verified and recorded', async () => {
      const { orderId, ref } = await heldOrder('HVE-MULTI');
      setClass(SECOND_USER, 'B');
      setClass(THIRD_USER, 'B');
      const result = await sendVeuSignature(ctx.signer, 'HVE', ref, { signatures: [sessionSigner(ctx.signer), sessionSigner(ctx.third)] });
      expect(result.code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
      expect(signatures(orderId)).toEqual([
        [USER_ID, 'UPLOAD', 'A'],
        [SECOND_USER, 'HVE', 'B'],
        [THIRD_USER, 'HVE', 'B'],
      ]);
      expect(ctx.store.listHacEvents({ orderId: result.orderId }).map((e) => [e.action, e.userId, e.reasonCode])).toEqual([
        ['ES_UPLOAD', SECOND_USER, 'TS01'],
        ['ES_VERIFICATION', SECOND_USER, 'DS01'],
        ['ES_VERIFICATION', THIRD_USER, 'DS01'],
      ]);
    });

    it('HVE records nothing when one of several EUs is invalid', async () => {
      const { orderId, ref } = await heldOrder('HVE-ONE-BAD');
      const result = await sendVeuSignature(ctx.signer, 'HVE', ref, { signatures: [sessionSigner(ctx.signer), esSigner(PARTNER_ID, THIRD_USER, ctx.signer.keys)] });
      expect(result.code).toBe('091301');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);
      expect(signatures(orderId)).toEqual([[USER_ID, 'UPLOAD', 'A']]);
    });

    it('HVS verifies the EU before cancelling', async () => {
      const { content, orderId, ref } = await heldOrder('HVS');
      expect((await sendVeuSignature(ctx.signer, 'HVS', ref, { orderData: `${content} ` })).code).toBe('091301');
      expect(statuses(orderId)).toEqual(['PENDING_EDS']);

      expect((await sendVeuSignature(ctx.signer, 'HVS', ref)).code).toBe('000000');
      expect(statuses(orderId)).not.toContain('PENDING_EDS');
    });

    it('verifies A005 EUs of a subscriber whose signature key is A005', async () => {
      const { orderId, ref } = await heldOrder('A005');
      const a005 = await enrolSubscriber({ post: ctx.post, activate: ctx.activate, store: ctx.store, partnerId: PARTNER_ID, userId: 'USER4', signatureVersion: 'A005' });
      expect(ctx.store.getSubscriber(PARTNER_ID, 'USER4')!.keys.signatureVersion).toBe('A005');

      expect((await sendVeuSignature(a005, 'HVE', ref, { signatures: sessionSigner(a005, 'A006') })).code).toBe('091301');
      expect((await sendVeuSignature(a005, 'HVE', ref, { signatures: sessionSigner(a005, 'A005') })).code).toBe('000000');
      expect(statuses(orderId)).toEqual(['EXECUTED']);
    });
  });

  describe('PUB, HCA and HCS (chapter 4.6.1: exactly one EU of the subscriber, verified with the registered key)', () => {
    const signatureCertificate = () => ctx.store.getSubscriber(PARTNER_ID, USER_ID)!.keys.signatureCertificate;
    const keyEvents = (orderType: string) =>
      ctx.store.listHacEvents({ partnerId: PARTNER_ID }).filter((e) => e.adminOrderType === orderType).map((e) => [e.action, e.reasonCode]);

    it('PUB with an EU made with the registered key replaces the key', async () => {
      const newKeys = generateTestClientKeys();
      expect(await keyManagementUpload(ctx.uploader, 'PUB', pubOrderData(newKeys), sessionSigner(ctx.uploader))).toBe('000000');
      expect(signatureCertificate()).toBe(certBase64(newKeys.signatureCert));
    });

    it('PUB with an EU made with the new key is refused with 091301 and DS0B', async () => {
      const before = signatureCertificate();
      const newKeys = generateTestClientKeys();
      expect(await keyManagementUpload(ctx.uploader, 'PUB', pubOrderData(newKeys), esSigner(PARTNER_ID, USER_ID, newKeys))).toBe('091301');
      expect(signatureCertificate()).toBe(before);
      expect(keyEvents('PUB')).toContainEqual(['ES_VERIFICATION', 'DS0B']);
    });

    it('HCA with the EU of another user of the customer is refused with 091301 and DS0G', async () => {
      const before = ctx.store.getSubscriber(PARTNER_ID, USER_ID)!.keys.authenticationCertificate;
      expect(await keyManagementUpload(ctx.uploader, 'HCA', hcaOrderData(generateTestClientKeys()), sessionSigner(ctx.signer))).toBe('091301');
      expect(ctx.store.getSubscriber(PARTNER_ID, USER_ID)!.keys.authenticationCertificate).toBe(before);
      expect(keyEvents('HCA')).toContainEqual(['ES_VERIFICATION', 'DS0G']);
    });

    it('HCS with an additional EU of another user is refused with 091301 and DS0G', async () => {
      const before = signatureCertificate();
      const newKeys = generateTestClientKeys();
      const code = await keyManagementUpload(ctx.uploader, 'HCS', pubOrderData(newKeys), [sessionSigner(ctx.uploader), sessionSigner(ctx.signer)]);
      expect(code).toBe('091301');
      expect(signatureCertificate()).toBe(before);
      expect(keyEvents('HCS')).toContainEqual(['ES_VERIFICATION', 'DS0G']);
    });
  });
});
