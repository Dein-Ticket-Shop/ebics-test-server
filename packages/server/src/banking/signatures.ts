import type { SignatureClass } from '../store/types.js';

/**
 * EBICS signature classes (Unterschriftsklassen). E, A and B are bank-technical signatures that authorise
 * orders; T (transport signature) only submits them, e.g. for technical users.
 */
export const SIGNATURE_CLASSES: readonly SignatureClass[] = ['E', 'A', 'B', 'T'];

export function isSignatureClass(value: unknown): value is SignatureClass {
  return typeof value === 'string' && (SIGNATURE_CLASSES as readonly string[]).includes(value);
}

export function isBankTechnical(signatureClass: SignatureClass): boolean {
  return signatureClass !== 'T';
}

/**
 * Authorisation scheme for orders that need one bank-technical signature (EBICS 3.0.2 chapter 11.2.3): a single
 * signature (E), or two signatures of different users where at least one is E or A, so B + B is not enough.
 * Pass one class per distinct signer.
 */
export function isAuthorised(signerClasses: SignatureClass[]): boolean {
  const bankTechnical = signerClasses.filter(isBankTechnical);
  return bankTechnical.includes('E') || (bankTechnical.length >= 2 && bankTechnical.includes('A'));
}

/** The class an upload's signature counts as: without SignatureFlag it is only a transport signature */
export function uploadSignatureClass(signatureFlag: boolean, subscriberClass: SignatureClass): SignatureClass {
  return signatureFlag ? subscriberClass : 'T';
}

export type UploadDecision = 'execute' | 'veu' | 'reject';

/**
 * What happens to an upload, following the SignatureFlag documentation of the H005 schema:
 * - no SignatureFlag: the order is authorised outside EBICS (accompanying note) and executed
 * - SignatureFlag: the signatures in the order (one class per distinct signer) must authorise it, otherwise it is
 *   rejected (090003, chapter 3.14)
 * - SignatureFlag with requestEDS: missing signatures are collected in the VEU
 */
export function uploadDecision(upload: { signatureFlag: boolean; requestEds: boolean; signerClasses: SignatureClass[] }): UploadDecision {
  if (!upload.signatureFlag || isAuthorised(upload.signerClasses)) return 'execute';
  return upload.requestEds ? 'veu' : 'reject';
}
