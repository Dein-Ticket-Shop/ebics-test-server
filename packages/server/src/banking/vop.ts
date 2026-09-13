import type { AppStore, VopStatus } from '../store/types.js';
import { vopDefaultStatus } from '../config/feature-flags.js';

export interface PayeeVerification {
  status: VopStatus;
  /** Account holder name to suggest for a close match (RVMC) */
  correctedName?: string;
}

const LEGAL_FORMS = /\b(gmbh|ag|kg|ohg|ug|eg|ev|e\.v|mbh|co|gbr|se|ltd|inc|llc|sarl|s\.a\.r\.l)\b/g;

function strictName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function looseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(LEGAL_FORMS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = current;
    }
  }
  return previous[b.length]!;
}

/** Match / close match / no match between the name in the payment and the account holder. */
export function compareNames(paymentName: string, holderName: string): VopStatus {
  if (strictName(paymentName) === strictName(holderName)) return 'RCVC';
  const a = looseName(paymentName);
  const b = looseName(holderName);
  if (!a || !b) return 'RVNM';
  if (a === b) return 'RVMC';
  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  const sameTokens = tokensA.length === tokensB.length && [...tokensA].sort().join(' ') === [...tokensB].sort().join(' ');
  const threshold = Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.15));
  return sameTokens || levenshtein(a, b) <= threshold ? 'RVMC' : 'RVNM';
}

/**
 * Verification of Payee for one credit transfer. Creditors whose account is held at this bank are
 * checked against the account owner's name; for all others the configured default applies
 * (EBICS_VOP_DEFAULT, default RCVC). Transactions without a creditor IBAN are not applicable.
 */
export function verifyPayee(store: AppStore, creditorIban?: string, creditorName?: string): PayeeVerification {
  if (!creditorIban) return { status: 'RVNA' };

  const account = store.getAccountByIban(creditorIban.replace(/\s+/g, '').toUpperCase());
  if (!account) {
    const status = vopDefaultStatus();
    return status === 'RVMC' ? { status, correctedName: creditorName } : { status };
  }

  const holderName = store.getPerson(account.personId)?.name ?? account.name;
  if (!creditorName) return { status: 'RVNM' };
  const status = compareNames(creditorName, holderName);
  return status === 'RVMC' ? { status, correctedName: holderName } : { status };
}
