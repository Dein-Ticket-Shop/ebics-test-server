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
