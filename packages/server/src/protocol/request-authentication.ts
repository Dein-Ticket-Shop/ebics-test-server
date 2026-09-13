import type { EbicsStore, Subscriber } from '../store/types.js';
import type { XmlDocument } from './xml-parser.js';
import { xpathString } from './xml-parser.js';
import { ReturnCode } from './return-codes.js';
import { extractPublicKeyFromCertBase64, verifyAuthSignature } from './xml-signature.js';

/** The authenticated subscriber of UserID, and the technical subscriber of SystemID that signed the request, if any */
export type RequestAuthentication = { subscriber: Subscriber; technical?: Subscriber } | { error: ReturnCode };

/** SystemID of a technical subscriber in the static header of ebicsRequest / ebicsNoPubKeyDigestsRequest */
export function requestSystemId(doc: XmlDocument): string | undefined {
  return xpathString('//ebics:header/ebics:static/ebics:SystemID/text()', doc) ?? undefined;
}

function signedBy(doc: XmlDocument, subscriber: Subscriber): boolean {
  const certificate = subscriber.keys.authenticationCertificate;
  return Boolean(certificate) && verifyAuthSignature(doc, extractPublicKeyFromCertBase64(certificate!));
}

/**
 * Authenticity of an EBICS request (EBICS 3.0.2 chapter 5.5.1.2.1). The signing subscriber must be registered, in an
 * allowed state and its authentication signature must verify, otherwise the answer is EBICS_AUTHENTICATION_FAILED, so
 * the sender learns nothing about subscriber IDs or states. With SystemID (chapter 3.7) the technical subscriber
 * (PartnerID + SystemID) signs; only after its signature verified are an unknown or not ready subscriber of UserID
 * reported with EBICS_USER_UNKNOWN / EBICS_INVALID_USER_STATE. Without SystemID the subscriber of UserID signs.
 */
export function authenticateRequest(
  doc: XmlDocument,
  store: Pick<EbicsStore, 'getSubscriber'>,
  request: { partnerId: string; userId: string; systemId?: string },
  stateOk: (subscriber: Subscriber) => boolean,
): RequestAuthentication {
  if (request.systemId) {
    const technical = store.getSubscriber(request.partnerId, request.systemId);
    if (!technical || !stateOk(technical) || !signedBy(doc, technical)) {
      return { error: ReturnCode.EBICS_AUTHENTICATION_FAILED };
    }
    const subscriber = store.getSubscriber(request.partnerId, request.userId);
    if (!subscriber) return { error: ReturnCode.EBICS_USER_UNKNOWN };
    if (!stateOk(subscriber)) return { error: ReturnCode.EBICS_INVALID_USER_STATE };
    return { subscriber, technical };
  }

  const subscriber = store.getSubscriber(request.partnerId, request.userId);
  if (!subscriber || !stateOk(subscriber) || !signedBy(doc, subscriber)) {
    return { error: ReturnCode.EBICS_AUTHENTICATION_FAILED };
  }
  return { subscriber };
}
