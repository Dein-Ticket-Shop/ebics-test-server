import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { parseXml } from '../protocol/xml-parser.js';

export function handleHcs(
  rawContent: string,
  subscriber: Subscriber,
  store: AppStore,
): ReturnCode {
  const doc = parseXml(rawContent);

  const certs = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
  if (certs.length < 3) {
    return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
  }

  // HCSRequestOrderData (H005 XSD): AuthenticationPubKeyInfo, EncryptionPubKeyInfo, esig:SignaturePubKeyInfo.
  // Each certificate is read from its own key info element, so any element order works. Documents
  // without these wrappers keep the original positional reading: signature, authentication, encryption.
  const sigInfo = firstByLocalName(doc, 'SignaturePubKeyInfo');
  const authInfo = firstByLocalName(doc, 'AuthenticationPubKeyInfo');
  const encInfo = firstByLocalName(doc, 'EncryptionPubKeyInfo');
  const wrapped = Boolean(sigInfo && authInfo && encInfo);

  const sigVersion = extractText(wrapped ? sigInfo : doc, 'SignatureVersion');
  const authVersion = extractText(wrapped ? authInfo : doc, 'AuthenticationVersion');
  const encVersion = extractText(wrapped ? encInfo : doc, 'EncryptionVersion');

  const certificate = (scope: any, index: number) =>
    (wrapped ? scope : doc)
      .getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')
      .item(wrapped ? 0 : index)
      ?.textContent?.trim()
      .replace(/\s/g, '');
  const sigCert = certificate(sigInfo, 0);
  const authCert = certificate(authInfo, 1);
  const encCert = certificate(encInfo, 2);

  if (!sigCert || !authCert || !encCert) {
    return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
  }

  store.updateSubscriberKeys(subscriber.partnerId, subscriber.userId, {
    signatureVersion: sigVersion,
    signatureCertificate: sigCert,
    authenticationVersion: authVersion,
    authenticationCertificate: authCert,
    encryptionVersion: encVersion,
    encryptionCertificate: encCert,
  });

  store.logActivity({
    eventType: 'key_rotation',
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    orderType: 'HCS',
    resultCode: ReturnCode.EBICS_OK,
  });

  return ReturnCode.EBICS_OK;
}

function extractText(doc: any, localName: string): string | undefined {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0) return elements.item(0)?.textContent?.trim() ?? undefined;
  return undefined;
}

function firstByLocalName(doc: any, localName: string): any {
  const elements = doc.getElementsByTagNameNS('*', localName);
  return elements.length > 0 ? elements.item(0) : undefined;
}
