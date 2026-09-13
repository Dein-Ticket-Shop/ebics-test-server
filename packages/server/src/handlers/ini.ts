import type { HandlerResult } from './handler-types.js';
import type { XmlDocument } from '../protocol/xml-parser.js';
import type { AppStore } from '../store/types.js';
import { recordKeyManagementOrder } from '../banking/order-events.js';
import { SubscriberState } from '../store/types.js';
import { xpathString, parseXml } from '../protocol/xml-parser.js';
import { inflate, base64Decode } from '../protocol/crypto.js';
import { buildKeyManagementResponse } from '../protocol/xml-builder.js';
import { ReturnCode, getReportText } from '../protocol/return-codes.js';
import { EBICS_NS } from '../protocol/constants.js';

export function handleIni(
  doc: XmlDocument,
  store: AppStore,
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
      subscriber.state !== SubscriberState.PARTIALLY_INITIALIZED_HIA) {
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

  const signatureVersion = extractText(orderDoc, 'SignatureVersion');
  const x509Cert = extractText(orderDoc, 'X509Certificate');

  if (!signatureVersion || !x509Cert) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT, ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT);
  }

  store.updateSubscriberKeys(partnerId, userId, {
    signatureVersion,
    signatureCertificate: x509Cert,
  });

  const newState = subscriber.state === SubscriberState.PARTIALLY_INITIALIZED_HIA
    ? SubscriberState.INITIALIZED
    : SubscriberState.PARTIALLY_INITIALIZED_INI;

  store.updateSubscriberState(partnerId, userId, newState);

  const orderId = recordKeyManagementOrder(store, partnerId, userId, 'INI');

  return buildKeyManagementResponse(ReturnCode.EBICS_OK, ReturnCode.EBICS_OK, undefined, orderId);
}

function extractText(doc: XmlDocument, localName: string): string | undefined {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0) {
    return elements.item(0)?.textContent?.trim() ?? undefined;
  }
  return undefined;
}
