import { describe, it, expect } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { buildUserSignatureData, esSigner, generateTestClientKeys, signOrderData, type TestClientKeys } from '../helpers/test-client.js';
import {
  SignatureCheckError,
  decryptSignatureData,
  orderDataHash,
  parseUserSignatureData,
  signedContent,
  verifyElectronicSignature,
  verifyUserSignatureData,
} from '../../src/banking/electronic-signatures.js';
import { aesEncrypt, deflate, generateTransactionKey, rsaWrapKey } from '../../src/protocol/crypto.js';
import { ReturnCode } from '../../src/protocol/return-codes.js';
import { SubscriberState, type AppStore, type Subscriber } from '../../src/store/types.js';

function certBase64(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
}

function checkError(fn: () => unknown): SignatureCheckError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SignatureCheckError);
    return err as SignatureCheckError;
  }
  throw new Error('expected a SignatureCheckError');
}

describe('electronic signatures', () => {
  // Generated while collecting: the it.each tables below sign with these keys
  const keys = generateTestClientKeys();
  const otherKeys = generateTestClientKeys();

  describe('signedContent and orderDataHash (chapter 14)', () => {
    it('leave CR, LF and Ctrl-Z out and keep every other byte', () => {
      expect(signedContent('a\r\nb\x1ac\td ').toString('utf8')).toBe('abc\td ');
      expect(signedContent(Buffer.from([0x0d, 0x41, 0x0a, 0x1a, 0xc3, 0xa4]))).toEqual(Buffer.from([0x41, 0xc3, 0xa4]));
      expect(orderDataHash('<a>\r\n<b/>\x1a</a>')).toEqual(createHash('sha256').update('<a><b/></a>').digest());
    });
  });

  describe('verifyElectronicSignature', () => {
    const data = '<Document>\n  <X>ä</X>\n</Document>';

    it('verifies A006 (PSS over the hash) and A005 (PKCS#1 v1.5) signatures', () => {
      const cert = certBase64(keys.signatureCert);
      expect(verifyElectronicSignature('A006', signOrderData(data, keys.signatureKeyPair.privateKey, 'A006'), data, cert)).toBe(true);
      expect(verifyElectronicSignature('A005', signOrderData(data, keys.signatureKeyPair.privateKey, 'A005'), data, cert)).toBe(true);
    });

    it('verifies a signature over the data with other line breaks', () => {
      const signature = signOrderData(data, keys.signatureKeyPair.privateKey);
      expect(verifyElectronicSignature('A006', signature, data.replace(/\n/g, '\r\n'), certBase64(keys.signatureCert))).toBe(true);
    });

    it('rejects other data, another key, the other version, unknown versions and broken certificates', () => {
      const cert = certBase64(keys.signatureCert);
      const a006 = signOrderData(data, keys.signatureKeyPair.privateKey, 'A006');
      const a005 = signOrderData(data, keys.signatureKeyPair.privateKey, 'A005');
      expect(verifyElectronicSignature('A006', a006, `${data} `, cert)).toBe(false);
      expect(verifyElectronicSignature('A006', a006, data, certBase64(otherKeys.signatureCert))).toBe(false);
      expect(verifyElectronicSignature('A006', a005, data, cert)).toBe(false);
      expect(verifyElectronicSignature('A005', a006, data, cert)).toBe(false);
      expect(verifyElectronicSignature('A004', a005, data, cert)).toBe(false);
      expect(verifyElectronicSignature('A006', a006, data, 'bm8gY2VydGlmaWNhdGU=')).toBe(false);
    });
  });

  describe('decryptSignatureData', () => {
    const bank = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const xml = '<UserSignatureData xmlns="http://www.ebics.org/S002"/>';

    function encrypt(plain: Buffer) {
      const key = generateTransactionKey();
      return { data: aesEncrypt(plain, key).toString('base64'), wrappedKey: rsaWrapKey(key, bank.publicKey).toString('base64') };
    }

    it('decrypts and inflates the signature data', () => {
      const { data, wrappedKey } = encrypt(deflate(Buffer.from(xml)));
      expect(decryptSignatureData(data, wrappedKey, bank.privateKey)).toBe(xml);
    });

    it('fails with 091111 and DS09 when the data cannot be decrypted', () => {
      const { data } = encrypt(deflate(Buffer.from(xml)));
      const error = checkError(() => decryptSignatureData(data, Buffer.from('not a key').toString('base64'), bank.privateKey));
      expect([error.returnCode, error.reasonCode]).toEqual([ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'DS09']);

      const { wrappedKey } = encrypt(Buffer.alloc(0));
      const truncated = checkError(() => decryptSignatureData(Buffer.alloc(15).toString('base64'), wrappedKey, bank.privateKey));
      expect([truncated.returnCode, truncated.reasonCode]).toEqual([ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'DS09']);
    });

    it('fails with 091111 and DS08 when the decrypted data cannot be inflated', () => {
      const { data, wrappedKey } = encrypt(Buffer.from(xml));
      const error = checkError(() => decryptSignatureData(data, wrappedKey, bank.privateKey));
      expect([error.returnCode, error.reasonCode]).toEqual([ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'DS08']);
    });
  });

  describe('parseUserSignatureData', () => {
    it('returns every OrderSignatureData', () => {
      const xml = buildUserSignatureData('data', [esSigner('P1', 'U1', keys), esSigner('P1', 'U2', otherKeys, 'A005')]);
      expect(parseUserSignatureData(xml).map((s) => [s.signatureVersion, s.partnerId, s.userId, s.signatureValue.length > 0])).toEqual([
        ['A006', 'P1', 'U1', true],
        ['A005', 'P1', 'U2', true],
      ]);
    });

    it.each([
      ['not XML', 'no xml'],
      ['a document violating the schema', '<UserSignatureData xmlns="http://www.ebics.org/S002"><OrderSignatureData/></UserSignatureData>'],
      ['a document in another namespace', '<UserSignatureData xmlns="urn:example"/>'],
    ])('fails with 091111 and TD03 for %s', (_name, xml) => {
      const error = checkError(() => parseUserSignatureData(xml));
      expect([error.returnCode, error.reasonCode]).toEqual([ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'TD03']);
    });
  });

  describe('verifyUserSignatureData', () => {
    const data = '<Document/>';

    function storeWith(subscribers: Partial<Subscriber>[]): AppStore {
      return {
        getSubscriber: (partnerId: string, userId: string) => subscribers.find((s) => s.partnerId === partnerId && s.userId === userId),
      } as unknown as AppStore;
    }

    function subscriber(userId: string, subscriberKeys: TestClientKeys, overrides: Partial<Subscriber> = {}): Partial<Subscriber> {
      return {
        partnerId: 'P1',
        userId,
        state: SubscriberState.READY,
        signatureClass: 'E',
        keys: { signatureVersion: 'A006', signatureCertificate: certBase64(subscriberKeys.signatureCert) } as Subscriber['keys'],
        ...overrides,
      };
    }

    it('returns the verified signers in document order', () => {
      const store = storeWith([subscriber('U1', keys), subscriber('U2', otherKeys)]);
      const signatureDataXml = buildUserSignatureData(data, [esSigner('P1', 'U2', otherKeys), esSigner('P1', 'U1', keys)]);
      expect(verifyUserSignatureData(store, { partnerId: 'P1', signatureDataXml, data }).map((s) => s.userId)).toEqual(['U2', 'U1']);
    });

    it.each([
      ['another customer', [esSigner('P2', 'U1', keys)], [], ReturnCode.EBICS_PARTNER_ID_MISMATCH, 'DS0G'],
      ['an unknown user', [esSigner('P1', 'U9', keys)], [], ReturnCode.EBICS_SIGNER_UNKNOWN, 'DS14'],
      ['a suspended user', [esSigner('P1', 'U1', keys)], [{ state: SubscriberState.SUSPENDED }], ReturnCode.EBICS_INVALID_SIGNER_STATE, 'DS0C'],
      ['a user who is not activated', [esSigner('P1', 'U1', keys)], [{ state: SubscriberState.INITIALIZED }], ReturnCode.EBICS_INVALID_SIGNER_STATE, 'DS27'],
      ['a user without signature key', [esSigner('P1', 'U1', keys)], [{ keys: { signatureVersion: 'A006' } }], ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS0E'],
      ['a version other than the registered one', [esSigner('P1', 'U1', keys, 'A005')], [], ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS16'],
      ['an unsupported registered version', [esSigner('P1', 'U1', keys)], [{ keys: { signatureVersion: 'A004', signatureCertificate: 'x' } }], ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS16'],
      ['a second EU of the same user', [esSigner('P1', 'U1', keys), esSigner('P1', 'U1', keys)], [], ReturnCode.EBICS_DUPLICATE_SIGNATURE, 'DS26'],
      ['an EU made with another key', [esSigner('P1', 'U1', otherKeys)], [], ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS0B'],
    ] as const)('refuses %s', (_name, signers, overrides, returnCode, reasonCode) => {
      const store = storeWith([subscriber('U1', keys, (overrides[0] ?? {}) as Partial<Subscriber>)]);
      const signatureDataXml = buildUserSignatureData(data, [...signers]);
      const error = checkError(() => verifyUserSignatureData(store, { partnerId: 'P1', signatureDataXml, data }));
      expect([error.returnCode, error.reasonCode]).toEqual([returnCode, reasonCode]);
    });
  });
});
