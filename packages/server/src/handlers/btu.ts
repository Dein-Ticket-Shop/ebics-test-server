import type { Subscriber, AppStore } from '../store/types.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { processPain001 } from '../banking/processors/pain001.js';
import { processPain008 } from '../banking/processors/pain008.js';
import { OrderDataError, OrderAuthError, SignatureAuthorisationError } from '../banking/validation.js';
import { directDebitProtocolText, receiveCreditTransfers, uploadRefusal } from '../banking/payments.js';
import { holdDirectDebits } from '../banking/direct-debits.js';
import { recordUploadCompleted, recordUploadRejected, type OrderContext } from '../banking/order-events.js';
import { uploadDecision, uploadSignatureClass } from '../banking/signatures.js';
import { SignatureCheckError, decryptSignatureData, verifyUserSignatureData } from '../banking/electronic-signatures.js';
import { logError } from '../logger.js';

/** Upload transaction attributes the order lifecycle needs (set by the dispatcher) */
export interface BtuOrderContext {
  orderId?: string;
  serviceOption?: string;
  /** BTUOrderParams/SignatureFlag is present: the order is authorised within EBICS */
  signatureFlag?: boolean;
  /** BTUOrderParams/SignatureFlag/@requestEDS */
  requestEds?: boolean;
  /**
   * SignatureData of the upload (encrypted) with the wrapped transaction key. When given, every electronic signature
   * is verified against the order data and the verified signers authorise the order; without it (direct calls in
   * tests) the uploader counts as the only signer.
   */
  signature?: { signatureData?: string; transactionKey: string; bankEncryptionPrivateKey: string };
  /** SystemID of the technical subscriber that sent the upload: its EUs are transport signatures (chapter 3.7) */
  technicalUserId?: string;
}

export function handleBtu(
  rawContent: string,
  serviceName: string,
  msgName: string | undefined,
  subscriber: Subscriber,
  store: AppStore,
  context: BtuOrderContext = {},
): ReturnCode {
  const order = store.createUploadedOrder({
    partnerId: subscriber.partnerId,
    userId: subscriber.userId,
    serviceName,
    msgName,
    rawContent,
    orderId: context.orderId,
  });

  const events: OrderContext | undefined = context.orderId
    ? {
        partnerId: subscriber.partnerId,
        userId: subscriber.userId,
        orderId: context.orderId,
        adminOrderType: 'BTU',
        serviceName,
        serviceOption: context.serviceOption,
        msgName,
        uploadedOrderId: order.id,
      }
    : undefined;

  const signatureFlag = context.signatureFlag ?? false;
  const requestEds = context.requestEds ?? false;

  try {
    const signers = context.signature
      ? verifyUserSignatureData(store, {
          partnerId: subscriber.partnerId,
          signatureDataXml: decryptSignatureData(
            context.signature.signatureData ?? '',
            context.signature.transactionKey,
            context.signature.bankEncryptionPrivateKey,
          ),
          data: rawContent,
        }).map((signer) => ({
          userId: signer.userId,
          // A technical subscriber cannot place bank-technical signatures (chapter 3.7)
          signatureClass: signer.userId === context.technicalUserId ? ('T' as const) : signer.subscriber.signatureClass,
        }))
      : [{ userId: subscriber.userId, signatureClass: subscriber.signatureClass }];
    const signerClasses = signers.map((signer) => uploadSignatureClass(signatureFlag, signer.signatureClass));

    const minimumSignatures = store.getMinimumSignatures(subscriber.partnerId, serviceName);
    const agreements = store.getCustomerAgreements(subscriber.partnerId);
    const decision = uploadDecision({ signatureFlag, requestEds, signerClasses, minimumSignatures, agreements });
    const refusal = uploadRefusal({ decision, signatureFlag, signers, signerClasses, minimumSignatures });
    if (refusal) throw refusal;
    if (msgName === 'pain.001') {
      if (context.orderId) {
        // Payment orders with VoP, payment status history, HAC events and the VEU for missing signatures
        receiveCreditTransfers(store, {
          rawContent,
          partnerId: subscriber.partnerId,
          userId: subscriber.userId,
          orderId: context.orderId,
          uploadedOrderId: order.id,
          serviceName,
          serviceOption: context.serviceOption,
          msgName,
          signatureFlag,
          requestEds,
          signers,
        });
      } else {
        processPain001(rawContent, store, subscriber.partnerId);
      }
      store.markUploadedOrderProcessed(order.id);
    } else if (msgName === 'pain.008') {
      if (context.orderId && decision === 'veu') {
        // Signatures missing and EDS requested: the direct debits wait in the VEU (EBICS 3.0.2 chapter 8)
        holdDirectDebits(store, {
          rawContent,
          partnerId: subscriber.partnerId,
          userId: subscriber.userId,
          orderId: context.orderId,
          uploadedOrderId: order.id,
          serviceName,
          serviceOption: context.serviceOption,
          msgName,
          signers: signers.map((signer, index) => ({ userId: signer.userId, signatureClass: signerClasses[index]! })),
          minimumSignatures,
        });
        store.markUploadedOrderProcessed(order.id);
      } else {
        processPain008(rawContent, store, subscriber.partnerId);
        store.markUploadedOrderProcessed(order.id);
        if (events) recordUploadCompleted(store, events, directDebitProtocolText(store, rawContent));
      }
    } else if (events) {
      recordUploadCompleted(store, events);
    }
  } catch (err) {
    // best-effort — upload is still stored, left unprocessed
    logError(`${msgName ?? serviceName} processing`, err);
    if (events) {
      const reasonCode =
        err instanceof SignatureCheckError || err instanceof SignatureAuthorisationError ? err.reasonCode : 'TD03';
      recordUploadRejected(store, events, err instanceof Error ? err.message : String(err), reasonCode);
    }
    // Electronic signature not verifiable (chapter 5.3): the return code of the failed check
    if (err instanceof SignatureCheckError) {
      return err.returnCode;
    }
    // Malformed IBAN/BIC under strict validation: bounce the file like a real bank.
    if (err instanceof OrderDataError) {
      return ReturnCode.EBICS_INVALID_ORDER_DATA_FORMAT;
    }
    // Ordering-party account unknown or partner not authorised for it.
    if (err instanceof OrderAuthError) {
      return ReturnCode.EBICS_ACCOUNT_AUTHORISATION_FAILED;
    }
    // Signature flag set, but the uploader's signature class does not authorise the order and no VEU was requested:
    // "Authorization failed" (EBICS 3.0.2 chapter 3.14), EBICS_AUTHORISATION_ORDER_IDENTIFIER_FAILED in H005
    // Without VEU agreement a requested VEU is "EBICS Distributed Signature authorization failed" (chapter 3.14)
    if (err instanceof SignatureAuthorisationError) {
      return err.veuAgreementMissing ? ReturnCode.EBICS_DISTRIBUTED_SIGNATURE_AUTHORISATION_FAILED : ReturnCode.EBICS_AUTHORISATION_ORDER_TYPE_FAILED;
    }
  }

  return ReturnCode.EBICS_OK;
}
