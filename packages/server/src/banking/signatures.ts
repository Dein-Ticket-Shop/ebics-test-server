import type { MinimumSignatures, SignatureClass } from '../store/types.js';

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
 * Authorisation schemes of EBICS 3.0.2 chapter 11.2.3 for the minimum number of bank-technical signatures agreed for
 * the order (T never counts; pass one class per distinct signer):
 * - minimum 1: a single signature (E), or two signatures of different users where at least one is E or A (not B + B)
 * - minimum 2: any two bank-technical signatures of different users except B + B; E alone is not enough
 */
export function isAuthorised(signerClasses: SignatureClass[], minimumSignatures: MinimumSignatures = 1): boolean {
  const bankTechnical = signerClasses.filter(isBankTechnical);
  if (minimumSignatures === 2) return bankTechnical.length >= 2 && bankTechnical.some((signatureClass) => signatureClass !== 'B');
  return bankTechnical.includes('E') || (bankTechnical.length >= 2 && bankTechnical.includes('A'));
}

/** The fewest further signatures of other users that can authorise the order; 0 when it is authorised */
export function missingSignatures(signerClasses: SignatureClass[], minimumSignatures: MinimumSignatures = 1): number {
  if (isAuthorised(signerClasses, minimumSignatures)) return 0;
  return minimumSignatures === 2 && !signerClasses.some(isBankTechnical) ? 2 : 1;
}

/** Suffix for protocol texts of orders that need two bank-technical signatures */
export function minimumSignaturesNote(minimumSignatures: MinimumSignatures): string {
  return minimumSignatures === 2 ? ' (Mindestanzahl 2 EUs)' : '';
}

/** The class an upload's signature counts as: without SignatureFlag it is only a transport signature */
export function uploadSignatureClass(signatureFlag: boolean, subscriberClass: SignatureClass): SignatureClass {
  return signatureFlag ? subscriberClass : 'T';
}

export type UploadDecision = 'execute' | 'veu' | 'reject';

/**
 * What happens to an upload, following the SignatureFlag documentation of the H005 schema:
 * - no SignatureFlag: the order is authorised outside EBICS (accompanying note) and executed
 * - SignatureFlag: the signatures in the order (one class per distinct signer) must authorise it for the agreed
 *   minimum number of signatures, otherwise it is rejected (090003, chapter 3.14)
 * - SignatureFlag with requestEDS: missing signatures are collected in the VEU
 */
export function uploadDecision(upload: {
  signatureFlag: boolean;
  requestEds: boolean;
  signerClasses: SignatureClass[];
  minimumSignatures?: MinimumSignatures;
}): UploadDecision {
  if (!upload.signatureFlag || isAuthorised(upload.signerClasses, upload.minimumSignatures)) return 'execute';
  return upload.requestEds ? 'veu' : 'reject';
}
