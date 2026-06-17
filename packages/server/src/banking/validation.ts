import { xpathSelect } from '../protocol/xml-parser.js';
import { validateIban, validateBic } from './iban.js';

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
 * Strict validation is on by default: the server rejects malformed IBAN/BIC
 * values like a real bank, which is what makes the test server useful for
 * catching client bugs. Set EBICS_STRICT_VALIDATION=false to relax it and book
 * deliberately rough data anyway.
 */
export function isStrictValidation(): boolean {
  const v = process.env['EBICS_STRICT_VALIDATION'];
  return v !== 'false' && v !== '0';
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
