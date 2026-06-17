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

  const sigVersion = extractText(doc, 'SignatureVersion');
  const authVersion = extractText(doc, 'AuthenticationVersion');
  const encVersion = extractText(doc, 'EncryptionVersion');

  // HCS order: signature cert first, then auth, then enc
  const sigCert = certs.item(0)?.textContent?.trim().replace(/\s/g, '');
  const authCert = certs.item(1)?.textContent?.trim().replace(/\s/g, '');
  const encCert = certs.item(2)?.textContent?.trim().replace(/\s/g, '');

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
