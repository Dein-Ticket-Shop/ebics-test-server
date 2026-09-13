import { HOST_ID } from './test-server.js';
import {
  generateTestClientKeys,
  buildIniRequest,
  buildHiaRequest,
  buildHpbRequest,
  buildEbicsDownloadInitRequest,
  buildEbicsOrderParamsDownloadInitRequest,
  buildEbicsReceiptRequest,
  buildEbicsUploadInitRequest,
  buildEbicsUploadTransferRequest,
  buildEbicsVeuSignatureRequest,
  decryptDownloadResponseBytes,
  encryptUploadContent,
  readBusinessReturnCode,
  readOrderId,
  type BankCerts,
  type DateRange,
  type DownloadParams,
  type TestClientKeys,
  type UploadOptions,
  type VeuOrderRef,
  type VeuSignatureOptions,
} from './test-client.js';
import { parseXml, xpathSelect, xpathString } from '../../src/protocol/xml-parser.js';
import { extractPublicKeyFromCertBase64 } from '../../src/protocol/xml-signature.js';
import type { AppStore, SignatureClass } from '../../src/store/types.js';

/** Posts an EBICS request and returns the response body */
export type PostXml = (xml: string) => Promise<string>;

/** An activated subscriber with its keys and the bank keys, bound to one server */
export interface EbicsSession {
  post: PostXml;
  store: AppStore;
  partnerId: string;
  userId: string;
  keys: TestClientKeys;
  bankCerts: BankCerts;
  bankEncPubKey: string;
  iniBody: string;
  hiaBody: string;
}

/**
 * Creates the subscriber if needed, sends INI and HIA, activates it and fetches the bank keys (HPB).
 * `signatureClass` sets the subscriber's signature class; otherwise the stored class (default E) is kept.
 */
export async function enrolSubscriber(options: {
  post: PostXml;
  activate: (partnerId: string, userId: string) => Promise<unknown>;
  store: AppStore;
  partnerId: string;
  userId: string;
  signatureClass?: SignatureClass;
}): Promise<EbicsSession> {
  const { post, store, partnerId, userId } = options;
  const keys = generateTestClientKeys();
  if (!store.getSubscriber(partnerId, userId)) store.createSubscriber(partnerId, userId);
  if (options.signatureClass) store.updateSubscriberSettings(partnerId, userId, { signatureClass: options.signatureClass });
  const iniBody = await post(buildIniRequest(HOST_ID, partnerId, userId, keys));
  const hiaBody = await post(buildHiaRequest(HOST_ID, partnerId, userId, keys));
  await options.activate(partnerId, userId);
  await post(buildHpbRequest(HOST_ID, partnerId, userId, keys));

  const host = store.getHostConfig()!;
  const bankCerts = { authCertPem: host.bankKeys.authenticationCertificate, encCertPem: host.bankKeys.encryptionCertificate };
  const bankEncPubKey = extractPublicKeyFromCertBase64(
    host.bankKeys.encryptionCertificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, ''),
  );
  return { post, store, partnerId, userId, keys, bankCerts, bankEncPubKey, iniBody, hiaBody };
}

export const SCI_UPLOAD: UploadOptions = { scope: 'DE', serviceOption: 'VOI', requestEds: true };

/** BTU upload (Initialisation plus all Transfer segments) */
export async function uploadOrder(
  session: EbicsSession,
  content: string,
  options: { serviceName?: string; msgName?: string; upload?: UploadOptions } = {},
): Promise<{ initBody: string; transferBody: string; transactionId: string; orderId?: string }> {
  const enc = encryptUploadContent(content, session.bankEncPubKey, session.partnerId, session.userId);
  const initBody = await session.post(
    buildEbicsUploadInitRequest(
      HOST_ID, session.partnerId, session.userId, session.keys, session.bankCerts,
      options.serviceName ?? 'SCI', options.msgName ?? 'pain.001', enc, options.upload ?? SCI_UPLOAD,
    ),
  );
  const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', parseXml(initBody))!;
  let transferBody = '';
  for (let i = 0; i < enc.segments.length; i++) {
    transferBody = await session.post(
      buildEbicsUploadTransferRequest(HOST_ID, session.keys, transactionId, i + 1, i === enc.segments.length - 1, enc.segments[i]!),
    );
  }
  return { initBody, transferBody, transactionId, orderId: readOrderId(initBody) };
}

export interface DownloadResult {
  code?: string;
  body: string;
  data?: Buffer;
  transactionId?: string;
}

function decode(session: EbicsSession, body: string): DownloadResult {
  const code = readBusinessReturnCode(body);
  if (code !== '000000') return { code, body };
  const { data, transactionId } = decryptDownloadResponseBytes(body, session.keys.encKeyPair.privateKey);
  return { code, body, data, transactionId };
}

export async function downloadOrder(
  session: EbicsSession,
  orderType: string,
  params?: DownloadParams,
  standard?: { dateRange?: DateRange },
): Promise<DownloadResult> {
  const xml = buildEbicsDownloadInitRequest(HOST_ID, session.partnerId, session.userId, session.keys, session.bankCerts, orderType, params, standard);
  return decode(session, await session.post(xml));
}

/** Download with explicit order params XML, e.g. HVZ/HVD/HVT */
export async function downloadWithOrderParams(session: EbicsSession, orderType: string, orderParamsXml: string): Promise<DownloadResult> {
  const xml = buildEbicsOrderParamsDownloadInitRequest(HOST_ID, session.partnerId, session.userId, session.keys, session.bankCerts, orderType, orderParamsXml);
  return decode(session, await session.post(xml));
}

export function sendReceipt(session: EbicsSession, transactionId: string, code: 0 | 1 = 0): Promise<string> {
  return session.post(buildEbicsReceiptRequest(HOST_ID, session.keys, transactionId, code));
}

/** HVE or HVS; returns the business return code and the OrderID of the HVE/HVS */
export async function sendVeuSignature(
  session: EbicsSession,
  orderType: 'HVE' | 'HVS',
  ref: VeuOrderRef,
  options: VeuSignatureOptions = {},
): Promise<{ code?: string; technicalCode?: string; orderId?: string; body: string }> {
  const body = await session.post(
    buildEbicsVeuSignatureRequest(HOST_ID, session.partnerId, session.userId, session.keys, session.bankCerts, orderType, ref, session.bankEncPubKey, options),
  );
  const technicalCode = xpathString('//ebics:header/ebics:mutable/ebics:ReturnCode/text()', parseXml(body));
  return { code: readBusinessReturnCode(body), technicalCode, orderId: readOrderId(body), body };
}

/** Text content of all elements matching a path of local names, anywhere in the document */
export function localTexts(xml: string, path: string): string[] {
  const expression = '//' + path.split('/').map((name) => `*[local-name()='${name}']`).join('/');
  return (xpathSelect(expression, parseXml(xml)) as unknown as Node[]).map((n) => n.textContent ?? '');
}

/** Attribute of the first element with the given local name */
export function localAttribute(xml: string, name: string, attribute: string): string | null {
  const element = parseXml(xml).getElementsByTagNameNS('*', name).item(0);
  return element ? element.getAttribute(attribute) : null;
}

/** Attribute of every element with the given local name, in document order (null where it is missing) */
export function localAttributes(xml: string, name: string, attribute: string): (string | null)[] {
  const elements = parseXml(xml).getElementsByTagNameNS('*', name);
  return Array.from({ length: elements.length }, (_, i) => elements.item(i)!.getAttribute(attribute));
}
