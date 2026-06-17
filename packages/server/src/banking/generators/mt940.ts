import type { Account, BankConfig, Booking } from '../../store/types.js';

function formatDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function formatAmount(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${whole},${String(frac).padStart(2, '0')}`;
}

function cdIndicator(cents: number): 'C' | 'D' {
  return cents >= 0 ? 'C' : 'D';
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

export function generateMt940(
  account: Account,
  bankConfig: BankConfig,
  bookings: Booking[],
  openingBalanceCents: number,
  fromDate: string,
  toDate: string,
): string {
  const lines: string[] = [];
  const closingBalanceCents = openingBalanceCents + bookings.reduce((s, b) => s + b.amountCents, 0);
  const ref = truncate(`STMT${account.id}${Date.now()}`, 16);

  lines.push(`:20:${ref}`);
  lines.push(`:25:${account.iban}/${account.currency}`);
  lines.push(`:28C:00001/001`);
  lines.push(`:60F:${cdIndicator(openingBalanceCents)}${formatDate(fromDate)}${account.currency}${formatAmount(openingBalanceCents)}`);

  for (const booking of bookings) {
    const bookDate = formatDate(booking.bookingDate);
    const valMmDd = formatDate(booking.valueDate).slice(2);
    const entryRef = truncate(booking.endToEndId ?? `BK${booking.id}`, 16);
    lines.push(`:61:${bookDate}${valMmDd}${cdIndicator(booking.amountCents)}${formatAmount(booking.amountCents)}NTRF${entryRef}`);

    const narrativeLines: string[] = [];
    if (booking.counterpartyName) narrativeLines.push(booking.counterpartyName);
    if (booking.remittanceInfo) narrativeLines.push(booking.remittanceInfo);
    if (booking.counterpartyIban) narrativeLines.push(booking.counterpartyIban);
    if (narrativeLines.length > 0) {
      const truncated = narrativeLines.map((l) => truncate(l, 65)).slice(0, 6);
      lines.push(`:86:${truncated.join('\r\n')}`);
    }
  }

  lines.push(`:62F:${cdIndicator(closingBalanceCents)}${formatDate(toDate)}${account.currency}${formatAmount(closingBalanceCents)}`);
  lines.push('-');

  return lines.join('\r\n');
}
