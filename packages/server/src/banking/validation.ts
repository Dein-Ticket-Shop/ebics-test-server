import { xpathSelect } from '../protocol/xml-parser.js';
import { validateIban, validateBic } from './iban.js';
import type { AppStore } from '../store/types.js';
import { strictValidation } from '../config/feature-flags.js';

/**
 * Thrown when an uploaded payment carries a malformed IBAN or BIC. The BTU
 * handler maps it to EBICS_INVALID_ORDER_DATA_FORMAT (090004), the same bounce
 * a production bank gives when SEPA payload validation fails.
 */
export class OrderDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderDataError';
  }
}

/**
 * Thrown when the ordering party's account is unknown to this bank or the
 * uploading partner is not authorised for it. The BTU handler maps it to
 * EBICS_ACCOUNT_AUTHORISATION_FAILED (091302) — a real bank only books an order
 * against an account it holds and the submitter is entitled to draw on.
 */
export class OrderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderAuthError';
  }
}

/**
 * Thrown when an upload with SignatureFlag carries no signature that authorises it (signature class A, B or T)
 * and does not request the VEU. The BTU handler maps it to EBICS_SIGNATURE_VERIFICATION_FAILED (091301); the
 * customer protocol shows DS19 (signature rights insufficient).
 */
export class SignatureAuthorisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureAuthorisationError';
  }
}

/**
 * Validate the ordering party's own account: the debtor for a credit transfer
 * (pain.001), the creditor for a direct debit (pain.008). Under strict mode the
 * account must exist at this bank and the uploading partner must have access to
 * it. The counterparty account lives at another bank and is deliberately NOT
 * checked. No-op unless strict validation is enabled.
 */
export function validateOrderingAccount(
  store: AppStore,
  partnerId: string,
  iban: string | undefined,
  label: string,
): void {
  if (!isStrictValidation()) return;

  const account = iban ? store.getAccountByIban(iban) : undefined;
  if (!account) {
    throw new OrderAuthError(`${label} account not held at this bank: ${iban ?? '(missing IBAN)'}`);
  }
  if (!store.partnerHasAccountAccess(partnerId, account.id)) {
    throw new OrderAuthError(`partner ${partnerId} not authorised for ${label} account ${iban}`);
  }
}

/** EBICS_STRICT_VALIDATION, on by default (described in ENV_FLAGS in config/feature-flags.ts) */
export function isStrictValidation(): boolean {
  return strictValidation();
}

/**
 * Scan an uploaded payment document for every IBAN and BIC (namespace-agnostic,
 * so pain.001 / pain.008 of any version are covered) and reject the whole file
 * if any value is malformed. No-op unless strict validation is enabled.
 */
export function validateOrderData(doc: Node): void {
  if (!isStrictValidation()) return;

  for (const iban of textValues(doc, "//*[local-name()='IBAN']")) {
    if (!validateIban(iban)) throw new OrderDataError(`invalid IBAN in order data: ${iban}`);
  }
  for (const bic of textValues(doc, "//*[local-name()='BIC' or local-name()='BICFI']")) {
    if (!validateBic(bic)) throw new OrderDataError(`invalid BIC in order data: ${bic}`);
  }
}

function textValues(doc: Node, expr: string): string[] {
  const nodes = xpathSelect(expr, doc as any);
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) => (n as { textContent?: string | null }).textContent?.trim() ?? '')
    .filter((v) => v.length > 0);
}
