import type { HandlerContext, HandlerResult } from '../handlers/handler-types.js';
import type { AppStore, Subscriber, HostConfig } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { handleHev } from '../handlers/hev.js';
import { handleIni } from '../handlers/ini.js';
import { handleHia } from '../handlers/hia.js';
import { handleHpb } from '../handlers/hpb.js';
import { getRootElementName, xpathSelect, xpathString } from './xml-parser.js';
import { ReturnCode } from './return-codes.js';
import { buildKeyManagementResponse, buildEbicsResponse, type EbicsResponseOptions } from './xml-builder.js';
import { extractPublicKeyFromCertBase64 } from './xml-signature.js';
import { authenticateRequest, requestSystemId } from './request-authentication.js';
import { generateTransactionId, base64Decode } from './crypto.js';
import { prepareDownload } from './download-pipeline.js';
import { handleHpd } from '../handlers/hpd.js';
import { handleHtd } from '../handlers/htd.js';
import { handleHkd } from '../handlers/hkd.js';
import { handleHaa } from '../handlers/haa.js';
import { handleHac } from '../handlers/hac.js';
import { handleBtd } from '../handlers/btd.js';
import { handleBtu } from '../handlers/btu.js';
import { handleSpr } from '../handlers/spr.js';
import { handlePub } from '../handlers/pub.js';
import { handleHca as handleHcaKeyMgmt } from '../handlers/hca.js';
import { handleHcs } from '../handlers/hcs.js';
import { decryptUpload } from './upload-pipeline.js';
import { logError } from '../logger.js';
import { createZip } from './zip.js';
import { validatePayload } from './xml-validator.js';
import type { DownloadOrderData, DownloadPayload } from '../handlers/handler-types.js';
import { OrderRejection } from '../handlers/handler-types.js';
import { recordEvent, recordUploadCompleted, recordUploadRejected } from '../banking/order-events.js';
import { handleHvd, handleHvt, handleHvu, handleHvz, processVeuSignature } from '../handlers/veu.js';
import { handlePtk } from '../handlers/ptk.js';
import { SignatureCheckError, decryptSignatureData, verifyUserSignatureData } from '../banking/electronic-signatures.js';
import { hacDownloadEvents } from '../config/feature-flags.js';
import { PROTOCOL_ORDER_TYPES } from '../handlers/partner-info.js';

export interface DispatcherConfig {
  hostId: string;
  store: AppStore;
  /** Validate generated camt / pain.002 documents against their ISO 20022 schemas (violations are logged) */
  validatePayloads?: boolean;
}

export type DownloadOrderHandler = (
  ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
) => DownloadOrderData;

export async function dispatch(ctx: HandlerContext, config: DispatcherConfig): Promise<HandlerResult> {
  const rootElement = getRootElementName(ctx.doc);
  let result: HandlerResult;

  switch (rootElement) {
    case 'ebicsHEVRequest':
      result = await handleHev(ctx, config.hostId);
      break;

    case 'ebicsUnsecuredRequest':
      result = dispatchUnsecured(ctx, config);
      break;

    case 'ebicsNoPubKeyDigestsRequest':
      result = dispatchNoPubKeyDigests(ctx, config);
      break;

    case 'ebicsRequest':
      result = dispatchEbicsRequest(ctx, config);
      break;

    default:
      result = buildKeyManagementResponse(
        ReturnCode.EBICS_INVALID_REQUEST,
        ReturnCode.EBICS_INVALID_REQUEST,
      );
      break;
  }

  if (result.logEntry) {
    config.store.logActivity({
      eventType: 'ebics_request',
      partnerId: result.logEntry.partnerId,
      userId: result.logEntry.userId,
      orderType: result.logEntry.orderType,
      resultCode: result.logEntry.resultCode,
    });
  }

  return result;
}

function dispatchUnsecured(ctx: HandlerContext, config: DispatcherConfig): HandlerResult {
  const orderType = xpathString('//ebics:AdminOrderType/text()', ctx.doc);

  switch (orderType) {
    case 'INI':
      return handleIni(ctx.doc, config.store, config.hostId);
    case 'HIA':
      return handleHia(ctx.doc, config.store, config.hostId);
    default:
      return buildKeyManagementResponse(
        ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE,
        ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE,
      );
  }
}

function dispatchNoPubKeyDigests(ctx: HandlerContext, config: DispatcherConfig): HandlerResult {
  const orderType = xpathString('//ebics:AdminOrderType/text()', ctx.doc);

  switch (orderType) {
    case 'HPB':
      return handleHpb(ctx.doc, config.store, config.hostId);
    default:
      return buildKeyManagementResponse(
        ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE,
        ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE,
      );
  }
}

function errorResponse(code: ReturnCode, phase: EbicsResponseOptions['transactionPhase'] = 'Initialisation'): HandlerResult {
  return buildEbicsResponse({
    technicalCode: code,
    businessCode: code,
    transactionPhase: phase,
  });
}

function validateNonce(store: AppStore, nonce: string, timestamp: string): ReturnCode | null {
  const ts = new Date(timestamp).getTime();
  const now = Date.now();
  const sixHours = 6 * 60 * 60 * 1000;

  if (Math.abs(now - ts) > sixHours) {
    return ReturnCode.EBICS_INVALID_REQUEST;
  }

  if (store.hasNonce(nonce)) {
    return ReturnCode.EBICS_TX_MESSAGE_REPLAY;
  }

  store.storeNonce(nonce, timestamp);
  return null;
}

function dispatchEbicsRequest(ctx: HandlerContext, config: DispatcherConfig): HandlerResult {
  const hostId = xpathString('//ebics:header/ebics:static/ebics:HostID/text()', ctx.doc);
  if (hostId !== config.hostId) {
    return errorResponse(ReturnCode.EBICS_INVALID_HOST_ID);
  }

  const transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', ctx.doc);
  const transactionPhase = xpathString('//ebics:mutable/ebics:TransactionPhase/text()', ctx.doc);

  if (transactionId) {
    return handleTransactionContinuation(ctx, config, transactionId, transactionPhase as 'Transfer' | 'Receipt');
  }

  return handleTransactionInit(ctx, config);
}

function handleTransactionInit(ctx: HandlerContext, config: DispatcherConfig): HandlerResult {
  const { store, hostId } = config;

  const nonce = xpathString('//ebics:header/ebics:static/ebics:Nonce/text()', ctx.doc);
  const timestamp = xpathString('//ebics:header/ebics:static/ebics:Timestamp/text()', ctx.doc);

  if (!nonce || !timestamp) {
    return errorResponse(ReturnCode.EBICS_INVALID_REQUEST);
  }

  const nonceError = validateNonce(store, nonce, timestamp);
  if (nonceError) {
    return errorResponse(nonceError);
  }

  const partnerId = xpathString('//ebics:header/ebics:static/ebics:PartnerID/text()', ctx.doc);
  const userId = xpathString('//ebics:header/ebics:static/ebics:UserID/text()', ctx.doc);

  if (!partnerId || !userId) {
    return errorResponse(ReturnCode.EBICS_INVALID_REQUEST);
  }

  // Authenticity (chapters 3.7, 5.5.1.2.1): with SystemID a technical subscriber signs for the subscriber of UserID
  const systemId = requestSystemId(ctx.doc);
  const authenticated = authenticateRequest(ctx.doc, store, { partnerId, userId, systemId }, (s) => s.state === SubscriberState.READY);
  if ('error' in authenticated) {
    return errorResponse(authenticated.error);
  }
  const { subscriber } = authenticated;
  // Responses for a technical subscriber are encrypted with its encryption key (chapter 3.7)
  const recipient = authenticated.technical ?? subscriber;

  const hostConfig = store.getHostConfig();
  if (!hostConfig) {
    return errorResponse(ReturnCode.EBICS_INTERNAL_ERROR);
  }

  const orderType = xpathString('//ebics:OrderDetails/ebics:AdminOrderType/text()', ctx.doc);
  if (!orderType) {
    return errorResponse(ReturnCode.EBICS_INVALID_ORDER_TYPE);
  }

  // Key management orders (no data transfer, no segments)
  if (orderType === 'SPR') {
    return handleSpr(ctx, subscriber, hostConfig, store);
  }

  // VEU signature and cancellation carry only signature data (NumSegments 0) and are processed at once
  if (orderType === 'HVE' || orderType === 'HVS') {
    return processVeuSignature(ctx, store, subscriber, hostConfig, orderType);
  }

  // Customer protocol downloads can be switched off per subscriber in the admin API/UI
  if (PROTOCOL_ORDER_TYPES.includes(orderType) && !subscriber.protocolDownloadsAllowed) {
    return buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED,
      transactionPhase: 'Initialisation',
    });
  }

  // Upload detection: NumSegments in request static header = upload
  const numSegmentsStr = xpathString('//ebics:header/ebics:static/ebics:NumSegments/text()', ctx.doc);
  if (numSegmentsStr) {
    return handleUploadInit(ctx, config, subscriber, hostConfig, partnerId!, userId!, parseInt(numSegmentsStr, 10), orderType, systemId);
  }

  const handlers: Record<string, DownloadOrderHandler> = {
    HPD: handleHpd,
    HTD: handleHtd,
    HKD: handleHkd,
    HAA: handleHaa,
    HAC: handleHac,
    PTK: handlePtk,
    HVU: handleHvu,
    HVZ: handleHvz,
    HVD: handleHvd,
    HVT: handleHvt,
    BTD: handleBtd,
  };

  const handler = handlers[orderType];
  if (!handler) {
    return errorResponse(ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE);
  }

  let orderData: DownloadOrderData;
  try {
    orderData = handler(ctx, subscriber, hostConfig, store);
  } catch (err) {
    if (err instanceof OrderRejection) {
      return buildEbicsResponse({
        technicalCode: ReturnCode.EBICS_OK,
        businessCode: err.returnCode,
        transactionPhase: 'Initialisation',
      });
    }
    throw err;
  }
  if (orderData === null) {
    return buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_NO_DOWNLOAD_DATA_AVAILABLE,
      transactionPhase: 'Initialisation',
    });
  }

  if (!recipient.keys.encryptionCertificate) {
    return errorResponse(ReturnCode.EBICS_INVALID_USER_STATE);
  }

  if (config.validatePayloads) {
    const documents = typeof orderData === 'string' ? [orderData] : orderData.documents.map((d) => d.content);
    for (const document of documents) {
      if (typeof document !== 'string') continue;
      try {
        validatePayload(document);
      } catch (err) {
        logError(`${orderType} payload XSD validation (server bug)`, err);
      }
    }
  }

  if (hacDownloadEvents() && orderType !== 'HAC' && orderType !== 'PTK') {
    const service = (name: string) => xpathString(`//ebics:BTDOrderParams/ebics:Service/ebics:${name}/text()`, ctx.doc);
    recordEvent(
      store,
      {
        partnerId,
        userId,
        orderId: store.nextOrderId(partnerId),
        adminOrderType: orderType,
        serviceName: service('ServiceName'),
        scope: service('Scope'),
        serviceOption: service('ServiceOption'),
        containerType: xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:Container/@containerType', ctx.doc),
        msgName: service('MsgName'),
      },
      'FILE_DOWNLOAD',
      { reasonCode: 'TS01' },
    );
  }

  const subscriberEncPubKey = extractPublicKeyFromCertBase64(recipient.keys.encryptionCertificate);
  const bankEncCertDer = base64Decode(
    hostConfig.bankKeys.encryptionCertificate
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, ''),
  );

  const containerType = xpathString('//ebics:OrderDetails//ebics:Service/ebics:Container/@containerType', ctx.doc);
  const packed = packDownload(ctx, orderData, containerType);
  const download = prepareDownload(packed.data, subscriberEncPubKey, bankEncCertDer);
  const txId = generateTransactionId();

  store.createTransaction({
    transactionId: txId,
    partnerId,
    userId,
    hostId,
    direction: 'download',
    phase: 'Initialisation',
    orderType,
    numSegments: download.numSegments,
    currentSegment: 1,
    segments: download.segments,
    transactionKey: download.wrappedTransactionKey,
    encKeyDigest: download.encKeyDigest,
    deliveryKind: packed.deliveryKind,
    deliveryKeys: packed.deliveryKeys,
  });

  if (download.numSegments > 1) {
    store.updateTransactionPhase(txId, 'Transfer');
  }

  const logEntry = {
    orderType,
    partnerId,
    userId,
    resultCode: ReturnCode.EBICS_OK,
  };

  return {
    ...buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_OK,
      transactionId: txId,
      numSegments: download.numSegments,
      transactionPhase: 'Initialisation',
      segmentNumber: 1,
      lastSegment: download.numSegments === 1,
      dataTransfer: {
        encKeyDigest: download.encKeyDigest,
        transactionKey: download.wrappedTransactionKey,
        orderData: download.segments[0],
      },
    }),
    logEntry,
  };
}

function handleTransactionContinuation(
  ctx: HandlerContext,
  config: DispatcherConfig,
  transactionId: string,
  phase: 'Transfer' | 'Receipt',
): HandlerResult {
  const { store } = config;

  const tx = store.getTransaction(transactionId);
  if (!tx) {
    return errorResponse(ReturnCode.EBICS_TX_UNKNOWN_TXID, phase);
  }

  if (tx.direction === 'upload') {
    return handleUploadContinuation(ctx, config, tx, transactionId, phase);
  }

  if (phase === 'Receipt') {
    // A positive receipt (0) confirms the download: its items are not handed out again without DateRange
    const receiptCode = xpathString('//ebics:TransferReceipt/ebics:ReceiptCode/text()', ctx.doc);
    if (receiptCode === '0' && tx.deliveryKind && tx.deliveryKeys?.length) {
      store.markDelivered(tx.partnerId, tx.deliveryKind, tx.deliveryKeys);
    }
    store.deleteTransaction(transactionId);

    return buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_DOWNLOAD_POSTPROCESS_DONE,
      transactionId,
      transactionPhase: 'Receipt',
    });
  }

  // Transfer phase (download)
  const segmentNumberStr = xpathString('//ebics:mutable/ebics:SegmentNumber/text()', ctx.doc);
  const segmentNumber = segmentNumberStr ? parseInt(segmentNumberStr, 10) : tx.currentSegment + 1;

  if (segmentNumber < 1 || segmentNumber > tx.numSegments) {
    return errorResponse(ReturnCode.EBICS_TX_SEGMENT_NUMBER_EXCEEDED, 'Transfer');
  }

  store.updateTransactionSegment(transactionId, segmentNumber);

  const lastSegment = segmentNumber === tx.numSegments;

  return buildEbicsResponse({
    technicalCode: ReturnCode.EBICS_OK,
    businessCode: ReturnCode.EBICS_OK,
    transactionId,
    transactionPhase: 'Transfer',
    segmentNumber,
    lastSegment,
    dataTransfer: {
      encKeyDigest: tx.encKeyDigest,
      transactionKey: tx.transactionKey,
      orderData: tx.segments[segmentNumber - 1],
    },
  });
}

function handleUploadInit(
  ctx: HandlerContext,
  config: DispatcherConfig,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  partnerId: string,
  userId: string,
  numSegments: number,
  orderType: string,
  systemId?: string,
): HandlerResult {
  const { store, hostId } = config;

  const serviceName = xpathString('//ebics:BTUOrderParams/ebics:Service/ebics:ServiceName/text()', ctx.doc);
  const msgName = xpathString('//ebics:BTUOrderParams/ebics:Service/ebics:MsgName/text()', ctx.doc);
  const serviceOption = xpathString('//ebics:BTUOrderParams/ebics:Service/ebics:ServiceOption/text()', ctx.doc);
  const signatureFlag =
    (xpathSelect("//*[local-name()='BTUOrderParams']/*[local-name()='SignatureFlag']", ctx.doc) as Node[]).length > 0;
  const requestEds = xpathString('//ebics:BTUOrderParams/ebics:SignatureFlag/@requestEDS', ctx.doc) === 'true';

  const wrappedKey = xpathString('//ebics:body/ebics:DataTransfer/ebics:DataEncryptionInfo/ebics:TransactionKey/text()', ctx.doc);
  const signatureData = xpathString('//ebics:body/ebics:DataTransfer/ebics:SignatureData/text()', ctx.doc);

  if (!wrappedKey) {
    return errorResponse(ReturnCode.EBICS_INVALID_REQUEST);
  }

  const txId = generateTransactionId();
  // Banks allocate an OrderID per upload and echo it in the responses (HAC refers to it)
  const orderId = store.nextOrderId(partnerId);

  store.createTransaction({
    transactionId: txId,
    partnerId,
    userId,
    hostId,
    direction: 'upload',
    phase: 'Transfer',
    orderType,
    numSegments,
    currentSegment: 0,
    segments: [],
    transactionKey: wrappedKey,
    encKeyDigest: '',
    signatureData: signatureData ?? undefined,
    serviceName: serviceName ?? undefined,
    msgName: msgName ?? undefined,
    orderId,
    serviceOption: serviceOption ?? undefined,
    signatureFlag,
    requestEds,
    systemId,
  });

  return {
    ...buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_OK,
      transactionId: txId,
      transactionPhase: 'Initialisation',
      orderId,
    }),
    logEntry: {
      orderType,
      partnerId,
      userId,
      resultCode: ReturnCode.EBICS_OK,
    },
  };
}

/**
 * Decrypt the accumulated upload, hand it to the matching order handler, and
 * return the business return code.
 *
 * EBICS uploads carry the result in the response to the last Transfer segment;
 * there is no mandatory client Receipt (that is download-only). We process the
 * order on that last segment and then mark the transaction `Receipt` WITHOUT
 * deleting it, so a defensive client that does send a trailing Receipt gets an
 * idempotent acknowledgement instead of EBICS_TX_UNKNOWN_TXID. A second call for
 * an already-finalized transaction is a no-op ack that clears the record; if no
 * Receipt ever arrives, cleanExpiredTransactions reaps it.
 */
function finalizeUpload(store: AppStore, transactionId: string): ReturnCode {
  const tx = store.getTransaction(transactionId);
  if (!tx) {
    return ReturnCode.EBICS_OK;
  }

  // Already processed on the last Transfer — this is a trailing Receipt ack.
  if (tx.phase === 'Receipt') {
    store.deleteTransaction(transactionId);
    return ReturnCode.EBICS_OK;
  }

  const hostConfig = store.getHostConfig();
  if (!hostConfig) {
    return ReturnCode.EBICS_INTERNAL_ERROR;
  }

  let businessCode = ReturnCode.EBICS_OK;
  let rejection: { message: string; reasonCode: string } | undefined;
  try {
    if (tx.segments.length > 0) {
      const rawContent = decryptUpload(
        tx.segments,
        tx.transactionKey,
        hostConfig.bankKeys.encryptionPrivateKey,
      );
      const subscriber = store.getSubscriber(tx.partnerId, tx.userId);
      const sub = subscriber ?? { partnerId: tx.partnerId, userId: tx.userId } as Subscriber;
      const signature = {
        signatureData: tx.signatureData,
        transactionKey: tx.transactionKey,
        bankEncryptionPrivateKey: hostConfig.bankKeys.encryptionPrivateKey,
      };

      switch (tx.orderType) {
        case 'PUB':
        case 'HCA':
        case 'HCS': {
          // Chapter 4.6.1: exactly one EU of the subscriber whose keys change (any signature class), verified with the
          // signature key registered so far
          const signers = verifyUserSignatureData(store, {
            partnerId: tx.partnerId,
            signatureDataXml: decryptSignatureData(tx.signatureData ?? '', tx.transactionKey, hostConfig.bankKeys.encryptionPrivateKey),
            data: rawContent,
          });
          if (signers.length !== 1 || signers[0]!.userId !== tx.userId) {
            throw new SignatureCheckError(
              ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED,
              'DS0G',
              `${tx.orderType} erfordert genau eine EU des Teilnehmers ${tx.partnerId}/${tx.userId}`,
            );
          }
          if (tx.orderType === 'PUB') businessCode = handlePub(rawContent, sub, store);
          else if (tx.orderType === 'HCA') businessCode = handleHcaKeyMgmt(rawContent, sub, store);
          else businessCode = handleHcs(rawContent, sub, store);
          break;
        }
        default:
          businessCode = handleBtu(
            rawContent,
            tx.serviceName ?? tx.orderType,
            tx.msgName,
            sub,
            store,
            { orderId: tx.orderId, serviceOption: tx.serviceOption, signatureFlag: tx.signatureFlag, requestEds: tx.requestEds, signature, technicalUserId: tx.systemId },
          );
          break;
      }
    }
  } catch (err) {
    if (err instanceof SignatureCheckError) {
      businessCode = err.returnCode;
      rejection = { message: err.message, reasonCode: err.reasonCode };
    } else {
      logError(`upload processing (${tx.orderType})`, err);
      businessCode = ReturnCode.EBICS_PROCESSING_ERROR;
    }
  }

  if (tx.orderId && (tx.orderType === 'PUB' || tx.orderType === 'HCA' || tx.orderType === 'HCS')) {
    const orderCtx = { partnerId: tx.partnerId, userId: tx.userId, orderId: tx.orderId, adminOrderType: tx.orderType };
    if (businessCode === ReturnCode.EBICS_OK) {
      recordUploadCompleted(store, orderCtx);
    } else {
      recordUploadRejected(store, orderCtx, rejection?.message ?? `Return code ${businessCode}`, rejection?.reasonCode);
    }
  }

  // Keep the record (marked finalized) to acknowledge an optional client Receipt.
  store.updateTransactionPhase(transactionId, 'Receipt');
  return businessCode;
}

function handleUploadContinuation(
  ctx: HandlerContext,
  config: DispatcherConfig,
  tx: ReturnType<AppStore['getTransaction']> & {},
  transactionId: string,
  phase: 'Transfer' | 'Receipt',
): HandlerResult {
  const { store } = config;

  if (phase === 'Receipt') {
    const businessCode = finalizeUpload(store, transactionId);
    return buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode,
      transactionId,
      transactionPhase: 'Receipt',
      orderId: tx.orderId,
    });
  }

  // Transfer phase — accumulate segment
  const orderData = xpathString('//ebics:body/ebics:DataTransfer/ebics:OrderData/text()', ctx.doc);
  if (!orderData) {
    return errorResponse(ReturnCode.EBICS_INVALID_REQUEST, 'Transfer');
  }

  store.appendUploadSegment(transactionId, orderData);

  const segmentNumberStr = xpathString('//ebics:mutable/ebics:SegmentNumber/text()', ctx.doc);
  const segmentNumber = segmentNumberStr ? parseInt(segmentNumberStr, 10) : tx.currentSegment + 1;
  const lastSegment = segmentNumber >= tx.numSegments;

  // EBICS uploads carry no Receipt phase: process the order as soon as the last
  // segment lands and return the business result in this Transfer response.
  const businessCode = lastSegment ? finalizeUpload(store, transactionId) : ReturnCode.EBICS_OK;

  return buildEbicsResponse({
    technicalCode: ReturnCode.EBICS_OK,
    businessCode,
    transactionId,
    transactionPhase: 'Transfer',
    segmentNumber,
    lastSegment,
    orderId: tx.orderId,
  });
}

/**
 * Turns handler output into order data bytes. With `<Container containerType="ZIP">` the documents
 * are packed into a ZIP (as clients expect for BTD); without a container a plain
 * string is sent unchanged and multi-document payloads are joined.
 */
function packDownload(
  ctx: HandlerContext,
  orderData: string | DownloadPayload,
  containerType: string | undefined,
): { data: string | Buffer; deliveryKind?: DownloadPayload['deliveryKind']; deliveryKeys?: string[] } {
  if (typeof orderData === 'string') {
    if (containerType !== 'ZIP') return { data: orderData };
    const msgName = xpathString('//ebics:OrderDetails//ebics:Service/ebics:MsgName/text()', ctx.doc) ?? 'orderdata';
    const extension = orderData.trimStart().startsWith('<') ? 'xml' : 'txt';
    return { data: createZip([{ name: `${msgName}.${extension}`, content: orderData }]) };
  }

  const contents = orderData.documents.map((d) => d.content);
  return {
    data: containerType === 'ZIP'
      ? createZip(orderData.documents)
      : contents.length === 1
        ? contents[0]!
        : contents.every((c) => typeof c === 'string')
          ? contents.join('\n')
          : Buffer.concat(contents.map((c) => (typeof c === 'string' ? Buffer.from(`${c}\n`) : c))),
    deliveryKind: orderData.deliveryKind,
    deliveryKeys: orderData.deliveryKeys,
  };
}
