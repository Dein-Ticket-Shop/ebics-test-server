import type { HandlerContext, HandlerResult } from '../handlers/handler-types.js';
import type { AppStore, Subscriber, HostConfig } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { handleHev } from '../handlers/hev.js';
import { handleIni } from '../handlers/ini.js';
import { handleHia } from '../handlers/hia.js';
import { handleHpb } from '../handlers/hpb.js';
import { getRootElementName, xpathString } from './xml-parser.js';
import { ReturnCode } from './return-codes.js';
import { buildKeyManagementResponse, buildEbicsResponse, type EbicsResponseOptions } from './xml-builder.js';
import { verifyAuthSignature, extractPublicKeyFromCertBase64 } from './xml-signature.js';
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

export interface DispatcherConfig {
  hostId: string;
  store: AppStore;
}

export type DownloadOrderHandler = (
  ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
) => string | null;

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

  const subscriber = store.getSubscriber(partnerId, userId);
  if (!subscriber) {
    return errorResponse(ReturnCode.EBICS_USER_UNKNOWN);
  }

  if (subscriber.state !== SubscriberState.READY) {
    return errorResponse(ReturnCode.EBICS_INVALID_USER_STATE);
  }

  if (!subscriber.keys.authenticationCertificate) {
    return errorResponse(ReturnCode.EBICS_INVALID_USER_STATE);
  }

  const subscriberAuthPubKey = extractPublicKeyFromCertBase64(subscriber.keys.authenticationCertificate);
  if (!verifyAuthSignature(ctx.doc, subscriberAuthPubKey)) {
    return errorResponse(ReturnCode.EBICS_AUTHENTICATION_FAILED);
  }

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

  // Upload detection: NumSegments in request static header = upload
  const numSegmentsStr = xpathString('//ebics:header/ebics:static/ebics:NumSegments/text()', ctx.doc);
  if (numSegmentsStr) {
    return handleUploadInit(ctx, config, subscriber, hostConfig, partnerId!, userId!, parseInt(numSegmentsStr, 10), orderType);
  }

  const handlers: Record<string, DownloadOrderHandler> = {
    HPD: handleHpd,
    HTD: handleHtd,
    HKD: handleHkd,
    HAA: handleHaa,
    HAC: handleHac,
    BTD: handleBtd,
  };

  const handler = handlers[orderType];
  if (!handler) {
    return errorResponse(ReturnCode.EBICS_UNSUPPORTED_ORDER_TYPE);
  }

  const orderDataXml = handler(ctx, subscriber, hostConfig, store);
  if (orderDataXml === null) {
    return buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_NO_DOWNLOAD_DATA_AVAILABLE,
      transactionPhase: 'Initialisation',
    });
  }

  if (!subscriber.keys.encryptionCertificate) {
    return errorResponse(ReturnCode.EBICS_INVALID_USER_STATE);
  }

  const subscriberEncPubKey = extractPublicKeyFromCertBase64(subscriber.keys.encryptionCertificate);
  const bankEncCertDer = base64Decode(
    hostConfig.bankKeys.encryptionCertificate
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, ''),
  );

  const download = prepareDownload(orderDataXml, subscriberEncPubKey, bankEncCertDer);
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
): HandlerResult {
  const { store, hostId } = config;

  const serviceName = xpathString('//ebics:BTUOrderParams/ebics:Service/ebics:ServiceName/text()', ctx.doc);
  const msgName = xpathString('//ebics:BTUOrderParams/ebics:Service/ebics:MsgName/text()', ctx.doc);

  const wrappedKey = xpathString('//ebics:body/ebics:DataTransfer/ebics:DataEncryptionInfo/ebics:TransactionKey/text()', ctx.doc);
  const signatureData = xpathString('//ebics:body/ebics:DataTransfer/ebics:SignatureData/text()', ctx.doc);

  if (!wrappedKey) {
    return errorResponse(ReturnCode.EBICS_INVALID_REQUEST);
  }

  const txId = generateTransactionId();

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
  });

  return {
    ...buildEbicsResponse({
      technicalCode: ReturnCode.EBICS_OK,
      businessCode: ReturnCode.EBICS_OK,
      transactionId: txId,
      transactionPhase: 'Initialisation',
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
 * clear the transaction. Returns the business return code.
 *
 * For EBICS uploads there is no client Receipt phase (that is download-only),
 * so this runs when the last Transfer segment arrives. We keep the Receipt
 * branch wired to the same logic for any client that does send one.
 */
function finalizeUpload(store: AppStore, transactionId: string): ReturnCode {
  const hostConfig = store.getHostConfig();
  if (!hostConfig) {
    return ReturnCode.EBICS_INTERNAL_ERROR;
  }

  let businessCode = ReturnCode.EBICS_OK;
  try {
    const tx = store.getTransaction(transactionId);
    if (tx && tx.segments.length > 0) {
      const rawContent = decryptUpload(
        tx.segments,
        tx.transactionKey,
        hostConfig.bankKeys.encryptionPrivateKey,
      );
      const subscriber = store.getSubscriber(tx.partnerId, tx.userId);
      const sub = subscriber ?? { partnerId: tx.partnerId, userId: tx.userId } as Subscriber;

      switch (tx.orderType) {
        case 'PUB':
          businessCode = handlePub(rawContent, sub, store);
          break;
        case 'HCA':
          businessCode = handleHcaKeyMgmt(rawContent, sub, store);
          break;
        case 'HCS':
          businessCode = handleHcs(rawContent, sub, store);
          break;
        default:
          businessCode = handleBtu(
            rawContent,
            tx.serviceName ?? tx.orderType,
            tx.msgName,
            sub,
            store,
          );
          break;
      }
    }
  } catch (err) {
    const tx = store.getTransaction(transactionId);
    logError(`upload processing (${tx?.orderType ?? 'unknown'})`, err);
    businessCode = ReturnCode.EBICS_PROCESSING_ERROR;
  }

  store.deleteTransaction(transactionId);
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
  });
}
