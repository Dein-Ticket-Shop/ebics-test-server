export function calculateIban(blz: string, accountNumber: string): string {
  const padded = accountNumber.padStart(10, '0');
  const bban = blz + padded;
  // D=13, E=14 → DE00 becomes 131400
  const numericString = bban + '131400';
  const remainder = BigInt(numericString) % 97n;
  const checkDigits = (98n - remainder).toString().padStart(2, '0');
  return `DE${checkDigits}${bban}`;
}

export function validateIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return BigInt(numeric) % 97n === 1n;
}

// SWIFT BIC: 6-letter bank + 2-char location (no 0/1 lead) + optional 3-char branch.
// Same shape EBICS clients enforce, so a value that passes here also passes there.
const BIC_RE = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/;

export function validateBic(bic: string): boolean {
  return BIC_RE.test(bic);
}

// German Bankleitzahl: exactly 8 digits.
export function validateBlz(blz: string): boolean {
  return /^\d{8}$/.test(blz);
}
