/** German IBAN from bank code and account number, same calculation as the server (banking/iban.ts). */
export function calculateIban(blz: string, accountNumber: string): string {
  const bban = blz + accountNumber.padStart(10, '0');
  const checkDigits = (98n - (BigInt(bban + '131400') % 97n)).toString().padStart(2, '0');
  return `DE${checkDigits}${bban}`;
}

/** IBAN in groups of four for display */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}
