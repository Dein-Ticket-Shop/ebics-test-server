import type { HandlerContext, HandlerResult } from './handler-types.js';
import type { Subscriber, AppStore, HostConfig } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { buildEbicsResponse } from '../protocol/xml-builder.js';
import { xpathString } from '../protocol/xml-parser.js';
import { SignatureCheckError, decryptSignatureData, verifyUserSignatureData } from '../banking/electronic-signatures.js';
import { logError } from '../logger.js';

/** The dummy file signed with SPR: exactly one space, not transmitted (EBICS 3.0.2 chapter 4.5.1) */
export const SPR_SIGNED_DATA = ' ';

/**
 * SPR suspends the subscriber (EBICS 3.0.2 chapters 4.5.1 and 4.5.2): an upload that carries only the EU of the
 * subscriber to be suspended over a dummy file with exactly one space, processed in the Initialisation phase. The
 * response carries the OrderID assigned by the bank (also on errors, chapter 5.5) but no TransactionID. An SPR
 * request with an OrderID is EBICS_INVALID_REQUEST_CONTENT.
 */
export function handleSpr(
  ctx: HandlerContext,
  subscriber: Subscriber,
  hostConfig: HostConfig,
  store: AppStore,
): HandlerResult {
  const orderId = store.nextOrderId(subscriber.partnerId);
  const respond = (businessCode: ReturnCode, technicalCode: ReturnCode = ReturnCode.EBICS_OK): HandlerResult => ({
    ...buildEbicsResponse({ technicalCode, businessCode, transactionPhase: 'Initialisation', orderId }),
    logEntry: {
      orderType: 'SPR',
      partnerId: subscriber.partnerId,
      userId: subscriber.userId,
      resultCode: technicalCode === ReturnCode.EBICS_OK ? businessCode : technicalCode,
    },
  });

  const requestOrderId = xpathString('//ebics:header/ebics:static/ebics:OrderDetails/ebics:OrderID/text()', ctx.doc);
  const wrappedKey = xpathString('//ebics:body/ebics:DataTransfer/ebics:DataEncryptionInfo/ebics:TransactionKey/text()', ctx.doc);
  const signatureData = xpathString('//ebics:body/ebics:DataTransfer/ebics:SignatureData/text()', ctx.doc);
  if (requestOrderId || !wrappedKey || !signatureData) {
    // A technical return code (EBICS annex 1, chapter 2)
    return respond(ReturnCode.EBICS_INVALID_REQUEST_CONTENT, ReturnCode.EBICS_INVALID_REQUEST_CONTENT);
  }

  try {
    const signers = verifyUserSignatureData(store, {
      partnerId: subscriber.partnerId,
      signatureDataXml: decryptSignatureData(signatureData, wrappedKey, hostConfig.bankKeys.encryptionPrivateKey),
      data: SPR_SIGNED_DATA,
    });
    // The EU file holds the signature of the subscriber to be suspended; other or additional EUs are refused
    if (signers.length !== 1 || signers[0]!.userId !== subscriber.userId) {
      throw new SignatureCheckError(
        ReturnCode.EBICS_SIGNATURE_VERIFICATION_FAILED,
        'DS0G',
        `SPR erfordert genau eine EU des Teilnehmers ${subscriber.partnerId}/${subscriber.userId}`,
      );
    }
  } catch (err) {
    if (err instanceof SignatureCheckError) return respond(err.returnCode);
    logError('SPR processing', err);
    return respond(ReturnCode.EBICS_PROCESSING_ERROR);
  }

  store.updateSubscriberState(subscriber.partnerId, subscriber.userId, SubscriberState.SUSPENDED);
  store.logActivity({
    eventType: 'subscriber_suspended',
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    orderType: 'SPR',
    resultCode: ReturnCode.EBICS_OK,
  });
  return respond(ReturnCode.EBICS_OK);
}
