import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { parseXml } from '../protocol/xml-parser.js';

export function handlePub(
  rawContent: string,
  subscriber: Subscriber,
  store: AppStore,
): ReturnCode {
  const doc = parseXml(rawContent);

  const signatureVersion = extractText(doc, 'SignatureVersion');
  const certBase64 = extractText(doc, 'X509Certificate');

  if (!signatureVersion || !certBase64) {
    return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
  }

  store.updateSubscriberKeys(subscriber.partnerId, subscriber.userId, {
    signatureVersion,
    signatureCertificate: certBase64.replace(/\s/g, ''),
  });

  store.logActivity({
    eventType: 'key_rotation',
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    orderType: 'PUB',
    resultCode: ReturnCode.EBICS_OK,
    details: { signatureVersion },
  });

  return ReturnCode.EBICS_OK;
}

function extractText(doc: any, localName: string): string | undefined {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0) return elements.item(0)?.textContent?.trim() ?? undefined;
  return undefined;
}
