import { randomBytes, publicEncrypt, constants } from 'node:crypto';
import type { HandlerResult } from './handler-types.js';
import type { XmlDocument } from '../protocol/xml-parser.js';
import type { EbicsStore, Subscriber } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { xpathString } from '../protocol/xml-parser.js';
import { buildKeyManagementResponse, buildHpbOrderData } from '../protocol/xml-builder.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { extractPublicKeyFromCertBase64 } from '../protocol/xml-signature.js';
import { authenticateRequest, requestSystemId } from '../protocol/request-authentication.js';
import { aesEncrypt, deflate, base64Encode } from '../protocol/crypto.js';
import { allowPreActivation } from '../config/feature-flags.js';

export function handleHpb(
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

  // Real banks only serve HPB to a fully activated (READY) subscriber. We allow the
  // pre-activation INITIALIZED state only when EBICS_ALLOW_PREACTIVATION is set, for
  // convenient local testing. Order processing is already gated on READY in the dispatcher.
  const stateOk = (s: Subscriber) =>
    s.state === SubscriberState.READY || (s.state === SubscriberState.INITIALIZED && allowPreActivation());
  // With SystemID a technical subscriber of the same customer signs the request (chapters 3.7 and 4.4.2.1)
  const authenticated = authenticateRequest(doc, store, { partnerId, userId, systemId: requestSystemId(doc) }, stateOk);
  if ('error' in authenticated) {
    return buildKeyManagementResponse(authenticated.error, authenticated.error);
  }
  const recipient = authenticated.technical ?? authenticated.subscriber;

  const hostConfig = store.getHostConfig();
  if (!hostConfig) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INTERNAL_ERROR, ReturnCode.EBICS_INTERNAL_ERROR);
  }

  const orderDataXml = buildHpbOrderData(
    hostConfig.bankKeys.authenticationCertificate,
    hostConfig.bankKeys.authenticationVersion,
    hostConfig.bankKeys.encryptionCertificate,
    hostConfig.bankKeys.encryptionVersion,
    configuredHostId,
  );

  const compressed = deflate(Buffer.from(orderDataXml, 'utf8'));

  // E002: AES-128-CBC with ICV 0 and ANSI X9.23 padding, like every other download
  const transactionKey = randomBytes(16);
  const encrypted = aesEncrypt(compressed, transactionKey);

  // Wrap the transaction key with the encryption key of the subscriber, or of the technical subscriber (chapter 3.7)
  const encPubKey = extractPublicKeyFromCertBase64(recipient.keys.encryptionCertificate!);
  const wrappedKey = publicEncrypt(
    { key: encPubKey, padding: constants.RSA_PKCS1_PADDING },
    transactionKey,
  );

  return buildKeyManagementResponse(
    ReturnCode.EBICS_OK,
    ReturnCode.EBICS_OK,
    {
      encryptedOrderData: base64Encode(encrypted),
      transactionKey: base64Encode(wrappedKey),
    },
  );
}
