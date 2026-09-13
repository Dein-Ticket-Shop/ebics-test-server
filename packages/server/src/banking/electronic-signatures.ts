import { createHash, verify, constants } from 'node:crypto';
import type { AppStore, Subscriber } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { parseXml, xpathSelect } from '../protocol/xml-parser.js';
import { validateXml } from '../protocol/xml-validator.js';
import { extractPublicKeyFromCertBase64 } from '../protocol/xml-signature.js';
import { aesDecrypt, base64Decode, inflate, rsaUnwrapKey } from '../protocol/crypto.js';

/**
 * Bank-technical electronic signatures (EUs) sent as UserSignatureData (ebics_signature_S002.xsd), EBICS 3.0.2
 * chapters 3.5.3, 5.3 ("Prüfung der EUs"), 11.2 and 14.1.
 */

/** Signature versions this bank verifies (chapter 14.1.4) */
export const SUPPORTED_SIGNATURE_VERSIONS: readonly string[] = ['A005', 'A006'];

/** Chapter 14: the operating-system dependent characters CR, LF and Ctrl-Z are not part of the signed data */
export function signedContent(data: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return Buffer.from(bytes.filter((byte) => byte !== 0x0d && byte !== 0x0a && byte !== 0x1a));
}

/** Hash value of order data as signed with A005/A006: SHA-256 over the data without CR, LF and Ctrl-Z */
export function orderDataHash(data: Buffer | string): Buffer {
  return createHash('sha256').update(signedContent(data)).digest();
}

/**
 * Verifies one signature value over order data (chapter 14.1.4): A005 is EMSA-PKCS1-v1_5 with SHA-256 over the data,
 * A006 is EMSA-PSS with SHA-256, MGF1 and a 32 byte salt over the SHA-256 hash of the data.
 */
export function verifyElectronicSignature(
  signatureVersion: string,
  signatureValue: string,
  data: Buffer | string,
  certificateBase64: string,
): boolean {
  try {
    const key = extractPublicKeyFromCertBase64(certificateBase64);
    const signature = Buffer.from(signatureValue, 'base64');
    if (signatureVersion === 'A006') {
      return verify('sha256', orderDataHash(data), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    }
    if (signatureVersion === 'A005') {
      return verify('sha256', signedContent(data), { key, padding: constants.RSA_PKCS1_PADDING }, signature);
    }
    return false;
  } catch {
    return false;
  }
}

/** A refused signature check: business return code and the ES_VERIFICATION reason code for the customer protocol */
export class SignatureCheckError extends Error {
  constructor(
    readonly returnCode: ReturnCode,
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignatureCheckError';
  }
}

export interface UserSignature {
  signatureVersion: string;
  signatureValue: string;
  partnerId: string;
  userId: string;
}

/**
 * Decrypts and inflates SignatureData with the transaction key of the request. Failures are
 * EBICS_INVALID_SIGNATURE_FILE_FORMAT with DS09 (decryption) or DS08 (decompression).
 */
export function decryptSignatureData(signatureDataB64: string, wrappedTransactionKey: string, bankEncryptionPrivateKeyPem: string): string {
  let decrypted: Buffer;
  try {
    const transactionKey = rsaUnwrapKey(base64Decode(wrappedTransactionKey), bankEncryptionPrivateKeyPem);
    decrypted = aesDecrypt(base64Decode(signatureDataB64), transactionKey);
  } catch {
    throw new SignatureCheckError(ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'DS09', 'Signaturdaten konnten nicht entschluesselt werden');
  }
  try {
    return inflate(decrypted).toString('utf8');
  } catch {
    throw new SignatureCheckError(ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'DS08', 'Signaturdaten konnten nicht dekomprimiert werden');
  }
}

function childText(element: Element, name: string): string {
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i);
    if (child && child.nodeType === 1 && (child as Element).localName === name) return child.textContent?.trim() ?? '';
  }
  return '';
}

/**
 * Parses UserSignatureData. A document that does not conform to ebics_signature_S002.xsd, or whose root is not
 * UserSignatureData (chapter 14.1.6), is EBICS_INVALID_SIGNATURE_FILE_FORMAT with TD03.
 */
export function parseUserSignatureData(xml: string): UserSignature[] {
  try {
    validateXml(xml, 'signature');
  } catch (err) {
    throw new SignatureCheckError(
      ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT,
      'TD03',
      `Signaturdaten entsprechen nicht ebics_signature_S002.xsd: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const doc = parseXml(xml);
  if (doc.documentElement?.localName !== 'UserSignatureData') {
    throw new SignatureCheckError(ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT, 'TD03', 'Signaturdaten ohne Wurzelelement UserSignatureData');
  }
  return (xpathSelect("/*[local-name()='UserSignatureData']/*[local-name()='OrderSignatureData']", doc) as Element[]).map(
    (element) => ({
      signatureVersion: childText(element, 'SignatureVersion'),
      signatureValue: childText(element, 'SignatureValue'),
      partnerId: childText(element, 'PartnerID'),
      userId: childText(element, 'UserID'),
    }),
  );
}

export interface VerifiedSigner {
  partnerId: string;
  userId: string;
  subscriber: Subscriber;
}

/**
 * Checks every OrderSignatureData of a UserSignatureData document against the signed data: the signer belongs to the
 * customer of the request (091120), is a known subscriber (091304) in state READY (091305), signs with the version of
 * the registered signature key (091301), signs only once (091306) and the signature value is valid (091301).
 */
export function verifyUserSignatureData(
  store: AppStore,
  request: { partnerId: string; signatureDataXml: string; data: Buffer | string },
): VerifiedSigner[] {
  const signers: VerifiedSigner[] = [];
  for (const signature of parseUserSignatureData(request.signatureDataXml)) {
    const signer = `${signature.partnerId}/${signature.userId}`;
    if (signature.partnerId !== request.partnerId) {
      throw new SignatureCheckError(ReturnCode.EBICS_PARTNER_ID_MISMATCH, 'DS0G', `Unterzeichner ${signer} gehoert nicht zum Kunden ${request.partnerId}`);
    }
    const subscriber = store.getSubscriber(signature.partnerId, signature.userId);
    if (!subscriber) {
      throw new SignatureCheckError(ReturnCode.EBICS_SIGNER_UNKNOWN, 'DS14', `Unterzeichner ${signer} ist unbekannt`);
    }
    if (subscriber.state === SubscriberState.SUSPENDED) {
      throw new SignatureCheckError(ReturnCode.EBICS_INVALID_SIGNER_STATE, 'DS0C', `Unterzeichner ${signer} ist gesperrt`);
    }
    if (subscriber.state !== SubscriberState.READY) {
      throw new SignatureCheckError(ReturnCode.EBICS_INVALID_SIGNER_STATE, 'DS27', `Unterzeichner ${signer} ist noch nicht aktiviert`);
    }
    if (!subscriber.keys.signatureCertificate) {
      throw new SignatureCheckError(ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS0E', `Kein oeffentlicher Schluessel fuer ${signer}`);
    }
    if (!SUPPORTED_SIGNATURE_VERSIONS.includes(signature.signatureVersion) || signature.signatureVersion !== subscriber.keys.signatureVersion) {
      throw new SignatureCheckError(
        ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED,
        'DS16',
        `Unterschriftsversion ${signature.signatureVersion} passt nicht zum Schluessel ${subscriber.keys.signatureVersion ?? '-'} von ${signer}`,
      );
    }
    if (signers.some((existing) => existing.userId === signature.userId)) {
      throw new SignatureCheckError(ReturnCode.EBICS_DUPLICATE_SIGNATURE, 'DS26', `${signer} hat mehrfach unterschrieben`);
    }
    if (!verifyElectronicSignature(signature.signatureVersion, signature.signatureValue, request.data, subscriber.keys.signatureCertificate)) {
      throw new SignatureCheckError(ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED, 'DS0B', `EU von ${signer} ist nicht korrekt`);
    }
    signers.push({ partnerId: signature.partnerId, userId: signature.userId, subscriber });
  }
  return signers;
}
