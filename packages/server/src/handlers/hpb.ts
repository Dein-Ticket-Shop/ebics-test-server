import { randomBytes, publicEncrypt, createCipheriv, constants } from 'node:crypto';
import type { HandlerResult } from './handler-types.js';
import type { XmlDocument } from '../protocol/xml-parser.js';
import type { EbicsStore } from '../store/types.js';
import { SubscriberState } from '../store/types.js';
import { xpathString } from '../protocol/xml-parser.js';
import { buildKeyManagementResponse, buildHpbOrderData } from '../protocol/xml-builder.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { verifyAuthSignature, extractPublicKeyFromCertBase64 } from '../protocol/xml-signature.js';
import { deflate, base64Encode } from '../protocol/crypto.js';
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

  const subscriber = store.getSubscriber(partnerId, userId);
  if (!subscriber) {
    return buildKeyManagementResponse(ReturnCode.EBICS_USER_UNKNOWN, ReturnCode.EBICS_USER_UNKNOWN);
  }

  // Real banks only serve HPB to a fully activated (READY) subscriber. We allow the
  // pre-activation INITIALIZED state only when EBICS_ALLOW_PREACTIVATION is set, for
  // convenient local testing. Order processing is already gated on READY in the dispatcher.
  const stateOk =
    subscriber.state === SubscriberState.READY ||
    (subscriber.state === SubscriberState.INITIALIZED && allowPreActivation());
  if (!stateOk) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_USER_STATE, ReturnCode.EBICS_INVALID_USER_STATE);
  }

  if (!subscriber.keys.authenticationCertificate) {
    return buildKeyManagementResponse(ReturnCode.EBICS_INVALID_USER_STATE, ReturnCode.EBICS_INVALID_USER_STATE);
  }

  const subscriberPubKey = extractPublicKeyFromCertBase64(subscriber.keys.authenticationCertificate);
  if (!verifyAuthSignature(doc, subscriberPubKey)) {
    return buildKeyManagementResponse(ReturnCode.EBICS_AUTHENTICATION_FAILED, ReturnCode.EBICS_AUTHENTICATION_FAILED);
  }

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

  // Encrypt with AES-128-CBC (zero IV per EBICS spec for key management)
  const transactionKey = randomBytes(16);
  const iv = Buffer.alloc(16, 0);
  const cipher = createCipheriv('aes-128-cbc', transactionKey, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);

  // Wrap transaction key with subscriber's encryption public key
  const encPubKey = extractPublicKeyFromCertBase64(subscriber.keys.encryptionCertificate!);
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
