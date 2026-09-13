import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { DownloadOrderData, HandlerContext, HandlerResult } from './handler-types.js';
import { OrderRejection } from './handler-types.js';
import type { AppStore, HostConfig, OrderSignature, PaymentOrder, Subscriber } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';
import { parseXml, xpathSelect, xpathString, type XmlDocument } from '../protocol/xml-parser.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { buildEbicsResponse } from '../protocol/xml-builder.js';
import { decryptUpload } from '../protocol/upload-pipeline.js';
import { generateTransactionId } from '../protocol/crypto.js';
import {
  VeuError,
  canSign,
  cancelVeuOrder,
  getVeuOrder,
  listVeuOrders,
  numSigRequired,
  signVeuOrder,
  type VeuOrder,
} from '../banking/veu.js';
import { creditTransferProtocolText } from '../banking/payments.js';
import { logError } from '../logger.js';

const NS = EBICS_NS.H005;

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function addService(parent: XMLBuilder, order: PaymentOrder): void {
  const service = parent.ele(NS, 'Service');
  service.ele(NS, 'ServiceName').txt(order.serviceName);
  service.ele(NS, 'Scope').txt('DE');
  if (order.serviceOption) service.ele(NS, 'ServiceOption').txt(order.serviceOption);
  service.ele(NS, 'MsgName').txt(order.msgName);
}

function addSignerInfo(parent: XMLBuilder, signature: OrderSignature): void {
  const signer = parent.ele(NS, 'SignerInfo');
  signer.ele(NS, 'PartnerID').txt(signature.partnerId);
  signer.ele(NS, 'UserID').txt(signature.userId);
  signer.ele(NS, 'Name').txt(signature.userId);
  signer.ele(NS, 'Timestamp').txt(signature.signedAt);
  // The signature class the signer had when signing
  signer.ele(NS, 'Permission').att('AuthorisationLevel', signature.signatureClass);
}

/** Order must belong to the requesting partner and be waiting for signatures */
function requestedVeuOrder(ctx: HandlerContext, store: AppStore, subscriber: Subscriber, orderType: string): VeuOrder {
  const params = `//ebics:${orderType}OrderParams`;
  const partnerId = xpathString(`${params}/ebics:PartnerID/text()`, ctx.doc) ?? subscriber.partnerId;
  if (partnerId !== subscriber.partnerId) {
    throw new OrderRejection(ReturnCode.EBICS_PARTNER_ID_MISMATCH);
  }
  const orderId = xpathString(`${params}/ebics:OrderID/text()`, ctx.doc);
  const veu = orderId ? getVeuOrder(store, partnerId, orderId) : undefined;
  if (!veu) throw new OrderRejection(ReturnCode.EBICS_ORDERID_UNKNOWN);
  return veu;
}

/** HVZ: VEU overview with order details of every order waiting for signatures */
export function handleHvz(
  _ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const veuOrders = listVeuOrders(store, subscriber.partnerId);
  if (veuOrders.length === 0) return null;

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVZResponseOrderData');
  for (const veu of veuOrders) {
    const first = veu.orders[0]!;
    const transactions = veu.orders.flatMap((o) => store.listPaymentTransactions(o.id));
    const details = root.ele(NS, 'OrderDetails');
    addService(details, first);
    details.ele(NS, 'OrderID').txt(veu.orderId);
    details.ele(NS, 'DataDigest').att('SignatureVersion', 'A006').txt(veu.dataDigest);
    details.ele(NS, 'OrderDataAvailable').txt('true');
    details.ele(NS, 'OrderDataSize').txt(String(Math.max(1, Buffer.byteLength(veu.rawContent))));
    details.ele(NS, 'OrderDetailsAvailable').txt('true');

    details.ele(NS, 'TotalOrders').txt(String(transactions.length));
    details
      .ele(NS, 'TotalAmount')
      .att('isCredit', 'false')
      .txt(formatAmount(transactions.reduce((sum, tx) => sum + tx.amountCents, 0)));
    details.ele(NS, 'Currency').txt(transactions[0]?.currency ?? 'EUR');
    const firstTx = transactions[0];
    if (firstTx) {
      const info = details.ele(NS, 'FirstOrderInfo');
      info.ele(NS, 'OrderPartyInfo').txt(firstTx.creditorName ?? '');
      const account = info.ele(NS, 'AccountInfo');
      account.ele(NS, 'AccountNumber').att('international', 'true').txt(firstTx.creditorIban ?? '');
      account.ele(NS, 'BankCode').att('international', 'true').txt(firstTx.creditorBic ?? store.getBankConfig()?.bic ?? '');
    }

    details
      .ele(NS, 'SigningInfo')
      .att('readyToBeSigned', String(canSign(veu, subscriber)))
      .att('NumSigRequired', String(numSigRequired(veu)))
      .att('NumSigDone', String(veu.signatures.length));
    for (const signature of veu.signatures) addSignerInfo(details, signature);

    const originator = details.ele(NS, 'OriginatorInfo');
    originator.ele(NS, 'PartnerID').txt(first.partnerId);
    originator.ele(NS, 'UserID').txt(first.userId);
    originator.ele(NS, 'Name').txt(first.userId);
    originator.ele(NS, 'Timestamp').txt(first.createdAt);
  }

  return { documents: [{ name: 'hvz.xml', content: root.end({ prettyPrint: true }) }] };
}

/** HVD: VEU state of one order with its display file (German protocol text) */
export function handleHvd(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const veu = requestedVeuOrder(ctx, store, subscriber, 'HVD');
  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVDResponseOrderData');
  root.ele(NS, 'DataDigest').att('SignatureVersion', 'A006').txt(veu.dataDigest);
  root.ele(NS, 'DisplayFile').txt(Buffer.from(creditTransferProtocolText(store, veu.orders).join('\n'), 'utf8').toString('base64'));
  root.ele(NS, 'OrderDataAvailable').txt('true');
  root.ele(NS, 'OrderDataSize').txt(String(Math.max(1, Buffer.byteLength(veu.rawContent))));
  root.ele(NS, 'OrderDetailsAvailable').txt('true');
  for (const signature of veu.signatures) addSignerInfo(root, signature);
  return { documents: [{ name: 'hvd.xml', content: root.end({ prettyPrint: true }) }] };
}

/** HVT: the complete order data of one order (only completeOrderData="true" is supported) */
export function handleHvt(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const veu = requestedVeuOrder(ctx, store, subscriber, 'HVT');
  const complete = xpathString('//ebics:HVTOrderParams/ebics:OrderFlags/@completeOrderData', ctx.doc) === 'true';
  if (!complete) {
    throw new OrderRejection(ReturnCode.EBICS_INVALID_ORDER_PARAMS, 'Only completeOrderData="true" is supported');
  }
  return veu.rawContent;
}

function localText(doc: XmlDocument, name: string): string | undefined {
  const node = (xpathSelect(`//*[local-name()='${name}']`, doc) as Node[])[0];
  return node?.textContent?.trim() || undefined;
}

/**
 * HVE (sign) and HVS (cancel): the request carries only the encrypted UserSignatureData (NumSegments 0)
 * and is processed at once. The signer in the signature data must be the requesting subscriber.
 * Signature values are parsed but not cryptographically verified, like uploads.
 */
export function processVeuSignature(
  ctx: HandlerContext,
  store: AppStore,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  orderType: 'HVE' | 'HVS',
): HandlerResult {
  const respond = (businessCode: ReturnCode, orderId?: string): HandlerResult => ({
    ...buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode,
      transactionId: generateTransactionId(),
      transactionPhase: 'Initialisation',
      orderId,
    }),
    logEntry: { orderType, partnerId: subscriber.partnerId, userId: subscriber.userId, resultCode: businessCode },
  });

  try {
    const veu = requestedVeuOrder(ctx, store, subscriber, orderType);
    const wrappedKey = xpathString('//ebics:body/ebics:DataTransfer/ebics:DataEncryptionInfo/ebics:TransactionKey/text()', ctx.doc);
    const signatureData = xpathString('//ebics:body/ebics:DataTransfer/ebics:SignatureData/text()', ctx.doc);
    if (!wrappedKey || !signatureData) return respond(ReturnCode.EBICS_INVALID_REQUEST_CONTENT);

    let signer: { partnerId?: string; userId?: string };
    try {
      const signatureDoc = parseXml(decryptUpload([signatureData], wrappedKey, hostConfig.bankKeys.encryptionPrivateKey));
      signer = { partnerId: localText(signatureDoc, 'PartnerID'), userId: localText(signatureDoc, 'UserID') };
    } catch {
      return respond(ReturnCode.EBICS_INVALID_SIGNATURE_FILE_FORMAT);
    }
    if (signer.partnerId !== subscriber.partnerId || signer.userId !== subscriber.userId) {
      return respond(ReturnCode.EBICS_SIGNER_UNKNOWN);
    }

    const request = { partnerId: subscriber.partnerId, orderId: veu.orderId, userId: subscriber.userId };
    const result = orderType === 'HVE' ? signVeuOrder(store, request) : cancelVeuOrder(store, request);
    return respond(ReturnCode.EBICS_OK, result.orderId);
  } catch (err) {
    if (err instanceof OrderRejection || err instanceof VeuError) return respond(err.returnCode);
    logError(`${orderType} processing`, err);
    return respond(ReturnCode.EBICS_PROCESSING_ERROR);
  }
}
