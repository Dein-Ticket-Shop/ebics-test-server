import type { HandlerResult } from './handler-types.js';
import type { XmlDocument } from '../protocol/xml-parser.js';
import type { EbicsStore } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { xpathString, parseXml } from '../protocol/xml-parser.js';
import { inflate, base64Decode } from '../protocol/crypto.js';
import { buildKeyManagementResponse } from '../protocol/xml-builder.js';
import { ReturnCode } from '../protocol/return-codes.js';

export function handleHia(
  doc: XmlDocument,
  store: EbicsStore,
  configuredHostId: string,
): HandlerResult {
  const hostId = xpathString('//ebics:HostID/text()', doc);
  if (hostId !== configuredHostId) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_HOST_ID, ReturnCode.EBICS_INVALID_HOST_ID);
  }

  const partnerId = xpathString('//ebics:PartnerID/text()', doc);
  const userId = xpathString('//ebics:UserID/text()', doc);

  if (!partnerId || !userId) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_REQUEST, ReturnCode.EBICS_INVALID_REQUEST);
  }

  const subscriber = store.getSubscriber(partnerId, userId);
  if (!subscriber) {
    return buildKeyManagementResponse(ReturnCode.EBICS_USER_UNKNOWN, ReturnCode.EBICS_USER_UNKNOWN);
  }

  if (subscriber.state !== SubscriberState.NEW &&
      subscriber.state !== SubscriberState.PARTIALLY_INITIALIZED_INI) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_USER_STATE, ReturnCode.EBICS_INVALID_USER_STATE);
  }

  const orderDataB64 = xpathString('//ebics:body/ebics:DataTransfer/ebics:OrderData/text()', doc);
  if (!orderDataB64) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_REQUEST, ReturnCode.EBICS_INVALID_REQUEST);
  }

  let orderDataXml: string;
  try {
    const compressed = base64Decode(orderDataB64);
    orderDataXml = inflate(compressed).toString('utf8');
  } catch {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT, ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT);
  }

  const orderDoc = parseXml(orderDataXml);

  const authVersion = extractText(orderDoc, 'AuthenticationVersion');
  const encVersion = extractText(orderDoc, 'EncryptionVersion');

  const x509Elements = orderDoc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
  const authCert = x509Elements.length > 0 ? x509Elements.item(0)?.textContent?.trim() : undefined;
  const encCert = x509Elements.length > 1 ? x509Elements.item(1)?.textContent?.trim() : undefined;

  if (!authVersion || !encVersion || !authCert || !encCert) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT, ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT);
  }

  store.updateSubscriberKeys(partnerId, userId, {
    authenticationVersion: authVersion,
    authenticationCertificate: authCert,
    encryptionVersion: encVersion,
    encryptionCertificate: encCert,
  });

  const newState = subscriber.state === SubscriberState.PARTIALLY_INITIALIZED_INI
    ? SubscriberState.INITIALIZED
    : SubscriberState.PARTIALLY_INITIALIZED_HIA;

  store.updateSubscriberState(partnerId, userId, newState);

  return buildKeyManagementResponse(ReturnCode.EBICS_OK, ReturnCode.EBICS_OK);
}

function extractText(doc: XmlDocument, localName: string): string | undefined {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0) {
    return elements.item(0)?.textContent?.trim() ?? undefined;
  }
  return undefined;
}
