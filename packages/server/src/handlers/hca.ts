import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { parseXml } from '../protocol/xml-parser.js';

export function handleHca(
  rawContent: string,
  subscriber: Subscriber,
  store: AppStore,
): ReturnCode {
  const doc = parseXml(rawContent);

  const certs = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
  if (certs.length < 2) {
    return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
  }

  const authCert = certs.item(0)?.textContent?.trim().replace(/\s/g, '');
  const encCert = certs.item(1)?.textContent?.trim().replace(/\s/g, '');
  const authVersion = extractText(doc, 'AuthenticationVersion');
  const encVersion = extractText(doc, 'EncryptionVersion');

  if (!authCert || !encCert) {
    return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
  }

  store.updateSubscriberKeys(subscriber.partnerId, subscriber.userId, {
    authenticationVersion: authVersion,
    authenticationCertificate: authCert,
    encryptionVersion: encVersion,
    encryptionCertificate: encCert,
  });

  store.logActivity({
    eventType: 'key_rotation',
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    orderType: 'HCA',
    resultCode: ReturnCode.EBICS_OK,
  });

  return ReturnCode.EBICS_OK;
}

function extractText(doc: any, localName: string): string | undefined {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0) return elements.item(0)?.textContent?.trim() ?? undefined;
  return undefined;
}
