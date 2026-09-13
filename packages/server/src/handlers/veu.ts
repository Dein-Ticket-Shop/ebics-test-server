import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { DownloadOrderData, HandlerContext, HandlerResult } from './handler-types.js';
import { OrderRejection } from './handler-types.js';
import type { AppStore, HostConfig, OrderSignature, PaymentOrder, Subscriber } from '../store/types.js';
import { EBICS_NS } from '../protocol/constants.js';
import { parseXml, xpathSelect, xpathString, type XmlDocument } from '../protocol/xml-parser.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { buildEbicsResponse } from '../protocol/xml-builder.js';
import { SignatureCheckError, decryptSignatureData, verifyUserSignatureData } from '../banking/electronic-signatures.js';
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
  type VeuOrderHead,
} from '../banking/veu.js';
import { creditTransferProtocolText, directDebitProtocolText } from '../banking/payments.js';
import { parsePain001 } from '../banking/processors/pain001.js';
import { parsePain008 } from '../banking/processors/pain008.js';
import { logError } from '../logger.js';

const NS = EBICS_NS.H005;

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function addService(parent: XMLBuilder, order: Pick<VeuOrderHead, 'serviceName' | 'serviceOption' | 'msgName'>): void {
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

function addSigningInfo(parent: XMLBuilder, veu: VeuOrder, subscriber: Subscriber): void {
  parent
    .ele(NS, 'SigningInfo')
    .att('readyToBeSigned', String(canSign(veu, subscriber)))
    .att('NumSigRequired', String(numSigRequired(veu)))
    .att('NumSigDone', String(veu.signatures.length));
}

function addOriginatorInfo(parent: XMLBuilder, order: Pick<VeuOrderHead, 'partnerId' | 'userId' | 'createdAt'>): void {
  const originator = parent.ele(NS, 'OriginatorInfo');
  originator.ele(NS, 'PartnerID').txt(order.partnerId);
  originator.ele(NS, 'UserID').txt(order.userId);
  originator.ele(NS, 'Name').txt(order.userId);
  originator.ele(NS, 'Timestamp').txt(order.createdAt);
}

/** ServiceFilter of HVUOrderParams / HVZOrderParams (ServiceType: every element optional) */
interface ServiceFilter {
  serviceName?: string;
  scope?: string;
  serviceOption?: string;
  /** Container@containerType */
  containerType?: string;
  msgName?: string;
}

function childElement(element: Element, name: string): Element | undefined {
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes.item(i);
    if (child && child.nodeType === 1 && (child as Element).localName === name) return child as Element;
  }
  return undefined;
}

function childText(element: Element, name: string): string | undefined {
  return childElement(element, name)?.textContent?.trim() || undefined;
}

function serviceFilters(ctx: HandlerContext, orderType: 'HVU' | 'HVZ'): ServiceFilter[] {
  const elements = xpathSelect(`//*[local-name()='${orderType}OrderParams']/*[local-name()='ServiceFilter']`, ctx.doc) as Element[];
  return elements.map((element) => ({
    serviceName: childText(element, 'ServiceName'),
    scope: childText(element, 'Scope'),
    serviceOption: childText(element, 'ServiceOption'),
    containerType: childElement(element, 'Container')?.getAttribute('containerType') || undefined,
    msgName: childText(element, 'MsgName'),
  }));
}

/**
 * Chapter 8.3.1: only orders whose BTF values are in the filter. Orders are listed with Scope DE and without
 * Container (see addService), so a filter asking for a container matches none of them.
 */
function matchesServiceFilter(order: VeuOrderHead, filter: ServiceFilter): boolean {
  return (
    (!filter.serviceName || filter.serviceName === order.serviceName) &&
    (!filter.scope || filter.scope === 'DE') &&
    (!filter.serviceOption || filter.serviceOption === order.serviceOption) &&
    !filter.containerType &&
    (!filter.msgName || filter.msgName === order.msgName)
  );
}

/**
 * Orders of the partner waiting for signatures; with ServiceFilter entries only those matching one of them.
 * HVU/HVZ list the orders the subscriber may sign (EBICS 3.0.2 chapter 8.3.1), so none for signature class T.
 */
function filteredVeuOrders(ctx: HandlerContext, store: AppStore, subscriber: Subscriber, orderType: 'HVU' | 'HVZ'): VeuOrder[] {
  if (subscriber.signatureClass === 'T') return [];
  const filters = serviceFilters(ctx, orderType);
  const veuOrders = listVeuOrders(store, subscriber.partnerId);
  if (filters.length === 0) return veuOrders;
  return veuOrders.filter((veu) => filters.some((filter) => matchesServiceFilter(veu.head, filter)));
}

/**
 * HVD/HVT: the subscriber needs a bank-technical signature authorisation (class E, A or B) for the order,
 * otherwise EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED (EBICS 3.0.2 chapters 8.3.2 and 8.3.3)
 */
function requireSignatureAuthorisation(subscriber: Subscriber): void {
  if (subscriber.signatureClass === 'T') {
    throw new OrderRejection(ReturnCode.EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED);
  }
}

/**
 * The order an HVD/HVT/HVE/HVS request refers to: it must wait for signatures (EBICS_ORDERID_UNKNOWN) and belong to the
 * customer of the subscriber, as cross-customer signatures (chapter 3.5) are not supported. Missing authorisation is
 * EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED for HVD/HVT (chapters 8.3.2, 8.3.3) and
 * EBICS_AUTHORISATION_ORDER_IDENTIFIER_FAILED for HVE (chapter 8.3.4) and HVS.
 */
function requestedVeuOrder(ctx: HandlerContext, store: AppStore, subscriber: Subscriber, orderType: 'HVD' | 'HVT' | 'HVE' | 'HVS'): VeuOrder {
  const params = `//ebics:${orderType}OrderParams`;
  const partnerId = xpathString(`${params}/ebics:PartnerID/text()`, ctx.doc) ?? subscriber.partnerId;
  const orderId = xpathString(`${params}/ebics:OrderID/text()`, ctx.doc);
  const veu = orderId ? getVeuOrder(store, partnerId, orderId) : undefined;
  if (!veu) throw new OrderRejection(ReturnCode.EBICS_ORDERID_UNKNOWN);
  if (veu.partnerId !== subscriber.partnerId) {
    throw new OrderRejection(
      orderType === 'HVD' || orderType === 'HVT'
        ? ReturnCode.EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED
        : ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED,
    );
  }
  return veu;
}

/** HVU: VEU overview without order details, optionally restricted by ServiceFilter */
export function handleHvu(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const veuOrders = filteredVeuOrders(ctx, store, subscriber, 'HVU');
  if (veuOrders.length === 0) return null;

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVUResponseOrderData');
  for (const veu of veuOrders) {
    const first = veu.head;
    const details = root.ele(NS, 'OrderDetails');
    addService(details, first);
    details.ele(NS, 'OrderID').txt(veu.orderId);
    details.ele(NS, 'OrderDataSize').txt(String(Math.max(1, Buffer.byteLength(veu.rawContent))));
    addSigningInfo(details, veu, subscriber);
    for (const signature of veu.signatures) addSignerInfo(details, signature);
    addOriginatorInfo(details, first);
  }

  return { documents: [{ name: 'hvu.xml', content: root.end({ prettyPrint: true }) }] };
}

/**
 * Amounts of the single orders and the ordering party (Auftraggeber) of the first logical file: the debtor of a credit
 * transfer, the creditor collecting a direct debit. Its account is held at this bank.
 */
function orderSummary(
  store: AppStore,
  veu: VeuOrder,
): { amounts: { amountCents: number; currency: string }[]; orderingParty?: { name?: string; iban?: string } } {
  if (veu.kind === 'directDebit') {
    const instructions = parsePain008(veu.rawContent);
    const first = instructions[0];
    return {
      amounts: instructions.flatMap((instruction) => instruction.transactions),
      orderingParty: first && { name: first.creditorName, iban: first.creditorIban },
    };
  }
  const first = veu.orders[0]!;
  return {
    amounts: veu.orders.flatMap((order) => store.listPaymentTransactions(order.id)),
    orderingParty: { name: first.debtorName, iban: first.debtorIban },
  };
}

/** HVZ: VEU overview with order details of every order waiting for signatures, optionally restricted by ServiceFilter */
export function handleHvz(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const veuOrders = filteredVeuOrders(ctx, store, subscriber, 'HVZ');
  if (veuOrders.length === 0) return null;

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVZResponseOrderData');
  for (const veu of veuOrders) {
    const first = veu.head;
    const summary = orderSummary(store, veu);
    const details = root.ele(NS, 'OrderDetails');
    addService(details, first);
    details.ele(NS, 'OrderID').txt(veu.orderId);
    details.ele(NS, 'DataDigest').att('SignatureVersion', 'A006').txt(veu.dataDigest);
    details.ele(NS, 'OrderDataAvailable').txt('true');
    details.ele(NS, 'OrderDataSize').txt(String(Math.max(1, Buffer.byteLength(veu.rawContent))));
    details.ele(NS, 'OrderDetailsAvailable').txt('true');

    details.ele(NS, 'TotalOrders').txt(String(summary.amounts.length));
    details
      .ele(NS, 'TotalAmount')
      // Credit transfers (Überweisungen) are "true", direct debits (Lastschriften) "false" (EBICS 3.0.2 chapter 8.3.1.4)
      .att('isCredit', String(veu.kind === 'creditTransfer'))
      .txt(formatAmount(summary.amounts.reduce((sum, amount) => sum + amount.amountCents, 0)));
    details.ele(NS, 'Currency').txt(summary.amounts[0]?.currency ?? 'EUR');
    if (summary.orderingParty) {
      // FirstOrderInfo: the ordering party (Auftraggeber) of the first logical file, as in the display file
      const info = details.ele(NS, 'FirstOrderInfo');
      info.ele(NS, 'OrderPartyInfo').txt(summary.orderingParty.name ?? '');
      const account = info.ele(NS, 'AccountInfo');
      account.ele(NS, 'AccountNumber').att('international', 'true').txt(summary.orderingParty.iban ?? '');
      account.ele(NS, 'BankCode').att('international', 'true').txt(store.getBankConfig()?.bic ?? '');
    }

    addSigningInfo(details, veu, subscriber);
    for (const signature of veu.signatures) addSignerInfo(details, signature);
    addOriginatorInfo(details, first);
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
  requireSignatureAuthorisation(subscriber);
  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVDResponseOrderData');
  root.ele(NS, 'DataDigest').att('SignatureVersion', 'A006').txt(veu.dataDigest);
  const displayFile = veu.kind === 'directDebit' ? directDebitProtocolText(store, veu.rawContent) : creditTransferProtocolText(store, veu.orders);
  root.ele(NS, 'DisplayFile').txt(Buffer.from(displayFile.join('\n'), 'utf8').toString('base64'));
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
  requireSignatureAuthorisation(subscriber);
  const flag = (name: string) => xpathString(`//ebics:HVTOrderParams/ebics:OrderFlags/@${name}`, ctx.doc);
  const completeOrderData = flag('completeOrderData');
  // Chapter 8.3.3.2: completeOrderData="true" is a standard download of the original order data
  if (completeOrderData === 'true' || completeOrderData === '1') return veu.rawContent;
  return hvtOrderDetails(veu, Number(flag('fetchLimit') ?? '0'), Number(flag('fetchOffset') ?? '0'));
}

/** AccountInfo (AttributedAccountType) of one party of a single order; IBAN and BIC in the international format */
function addHvtAccountInfo(
  parent: XMLBuilder,
  role: 'Originator' | 'Recipient',
  party: { iban?: string; bic?: string; name?: string },
): void {
  if (!party.iban) {
    // AccountNumber is mandatory; without an IBAN the details of this order cannot be rendered
    throw new OrderRejection(ReturnCode.EBICS_UNSUPPORTED_REQUEST_FOR_ORDER_INSTANCE, `${role} account without IBAN`);
  }
  const account = parent.ele(NS, 'AccountInfo');
  account.ele(NS, 'AccountNumber').att('Role', role).att('international', 'true').txt(party.iban);
  if (party.bic) account.ele(NS, 'BankCode').att('Role', role).att('international', 'true').txt(party.bic);
  if (party.name) account.ele(NS, 'AccountHolder').att('Role', role).txt(party.name);
}

interface HvtSingleOrder {
  originator: { iban?: string; bic?: string; name?: string };
  recipient: { iban?: string; bic?: string; name?: string };
  executionDate?: string;
  amountCents: number;
  currency: string;
  remittanceInfo?: string;
}

/**
 * The single orders of the order data: every CdtTrfTxInf of a pain.001 file, or every DrctDbtTxInf of a pain.008 file,
 * where the creditor collecting the direct debit is the ordering party (Originator) and the debtor the Recipient
 */
function hvtSingleOrders(veu: VeuOrder): HvtSingleOrder[] {
  if (veu.kind === 'directDebit') {
    return parsePain008(veu.rawContent).flatMap((instruction) =>
      instruction.transactions.map((transaction) => ({
        originator: { iban: instruction.creditorIban, name: instruction.creditorName },
        recipient: { iban: transaction.debtorIban, bic: transaction.debtorBic, name: transaction.debtorName },
        executionDate: instruction.requestedCollectionDate,
        amountCents: transaction.amountCents,
        currency: transaction.currency,
        remittanceInfo: transaction.remittanceInfo,
      })),
    );
  }
  return parsePain001(parseXml(veu.rawContent), { includeNonPositiveAmounts: true }).flatMap((instruction) =>
    instruction.transactions.map((transaction) => ({
      originator: { iban: instruction.debtorIban, bic: instruction.debtorBic, name: instruction.debtorName },
      recipient: { iban: transaction.creditorIban, bic: transaction.creditorBic, name: transaction.creditorName },
      executionDate: instruction.requestedExecutionDate,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
      remittanceInfo: transaction.remittanceInfo,
    })),
  );
}

/**
 * HVT with completeOrderData="false" (EBICS 3.0.2 chapter 8.3.3): HVTResponseOrderData with NumOrderInfos (every single
 * order of the file) and one OrderInfo per single order, at most fetchLimit (0 = all) starting at the running number
 * fetchOffset (0 = first).
 */
function hvtOrderDetails(veu: VeuOrder, fetchLimit: number, fetchOffset: number): string {
  const details = hvtSingleOrders(veu);
  // Chapter 8.3.3.1: a fetchOffset beyond the single orders is EBICS_INVALID_ORDER_PARAMS. An offset equal to their
  // number is refused as well, because HVTResponseOrderData needs at least one OrderInfo.
  if (fetchOffset >= details.length) {
    throw new OrderRejection(ReturnCode.EBICS_INVALID_ORDER_PARAMS, `fetchOffset ${fetchOffset} with ${details.length} single orders`);
  }
  const selected = details.slice(fetchOffset, fetchLimit === 0 ? undefined : fetchOffset + fetchLimit);

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(NS, 'HVTResponseOrderData');
  root.ele(NS, 'NumOrderInfos').txt(String(details.length));
  for (const order of selected) {
    const info = root.ele(NS, 'OrderInfo');
    info.ele(NS, 'MsgName').txt(veu.head.msgName);
    addHvtAccountInfo(info, 'Originator', order.originator);
    addHvtAccountInfo(info, 'Recipient', order.recipient);
    if (order.executionDate) {
      info.ele(NS, 'ExecutionDate').txt(order.executionDate.slice(0, 10));
    }
    // A credit transfer is a credit (isCredit="true", example of chapter 8.3.3.2), a direct debit is not
    info.ele(NS, 'Amount').att('isCredit', String(veu.kind === 'creditTransfer')).att('Currency', order.currency).txt(formatAmount(order.amountCents));
    if (order.remittanceInfo) {
      info.ele(NS, 'Description').att('Type', 'Purpose').txt(order.remittanceInfo);
    }
  }
  return root.end({ prettyPrint: true });
}

/**
 * HVE (sign) and HVS (cancel): the request carries only the encrypted UserSignatureData (NumSegments 0) and is
 * processed at once. Every EU signs the order data waiting in the VEU and must come from the customer of the request
 * (chapters 7 and 8.3.4/8.3.5); the verified signers sign or cancel the order.
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
    if (!wrappedKey || !signatureData) {
      // A technical return code (EBICS annex 1, chapter 2)
      const code = ReturnCode.EBICS_INVALID_REQUEST_CONTENT;
      return {
        ...buildEbicsResponse({ technicalCode: code, businessCode: code, transactionPhase: 'Initialisation' }),
        logEntry: { orderType, partnerId: subscriber.partnerId, userId: subscriber.userId, resultCode: code },
      };
    }

    const signers = verifyUserSignatureData(store, {
      partnerId: subscriber.partnerId,
      signatureDataXml: decryptSignatureData(signatureData, wrappedKey, hostConfig.bankKeys.encryptionPrivateKey),
      data: veu.rawContent,
    });

    // A technical subscriber cannot place bank-technical signatures (chapter 3.7): its EU neither signs nor cancels
    const systemId = xpathString('//ebics:header/ebics:static/ebics:SystemID/text()', ctx.doc);
    if (systemId && signers.some((signer) => signer.userId === systemId)) {
      return respond(ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED);
    }

    const request = { partnerId: subscriber.partnerId, orderId: veu.orderId, userId: signers.map((signer) => signer.userId) };
    const result = orderType === 'HVE' ? signVeuOrder(store, request) : cancelVeuOrder(store, request);
    return respond(ReturnCode.EBICS_OK, result.orderId);
  } catch (err) {
    if (err instanceof OrderRejection || err instanceof VeuError || err instanceof SignatureCheckError) return respond(err.returnCode);
    logError(`${orderType} processing`, err);
    return respond(ReturnCode.EBICS_PROCESSING_ERROR);
  }
}
