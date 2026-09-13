import type { PaymentOrderStatus, PaymentStatusCode, VopStatus, HacAction } from './types.js';

export const PAYMENT_ORDER_STATUS: Record<PaymentOrderStatus, { label: string; badge: string }> = {
  PENDING_EDS: { label: 'Awaiting EDS', badge: 'badge-warning' },
  EXECUTED: { label: 'Executed', badge: 'badge-success' },
  CANCELLED: { label: 'Cancelled', badge: 'badge-neutral' },
  REJECTED: { label: 'Rejected', badge: 'badge-error' },
};

export const VOP_STATUS: Record<VopStatus, { label: string; badge: string }> = {
  RCVC: { label: 'Match', badge: 'badge-success' },
  RVMC: { label: 'Close match', badge: 'badge-warning' },
  RVNM: { label: 'No match', badge: 'badge-error' },
  RVNA: { label: 'Not applicable', badge: 'badge-ghost' },
};

export const PAYMENT_STATUS_CODES: { code: PaymentStatusCode; label: string }[] = [
  { code: 'ACTC', label: 'Accepted technical validation' },
  { code: 'ACCP', label: 'Accepted customer profile' },
  { code: 'ACSP', label: 'Accepted settlement in process' },
  { code: 'ACSC', label: 'Accepted settlement completed' },
  { code: 'ACWC', label: 'Accepted with change' },
  { code: 'RJCT', label: 'Rejected' },
];

export function paymentStatusCodeBadge(code: PaymentStatusCode): string {
  if (code === 'RJCT') return 'badge-error';
  if (code === 'ACSC') return 'badge-success';
  return 'badge-info';
}

export const HAC_ACTIONS: HacAction[] = [
  'FILE_UPLOAD',
  'FILE_DOWNLOAD',
  'ES_VERIFICATION',
  'VEU_FORWARDING',
  'VEU_VERIFICATION_END',
  'VEU_CANCEL_ORDER',
  'ADDITIONAL',
  'ORDER_HAC_FINAL_POS',
  'ORDER_HAC_FINAL_NEG',
];

export function hacActionBadge(action: string): string {
  switch (action) {
    case 'ORDER_HAC_FINAL_POS':
      return 'badge-success';
    case 'ORDER_HAC_FINAL_NEG':
      return 'badge-error';
    case 'VEU_CANCEL_ORDER':
    case 'VEU_FORWARDING':
      return 'badge-warning';
    default:
      return 'badge-ghost';
  }
}

export function formatCents(cents: number, currency = 'EUR'): string {
  return (cents / 100).toLocaleString('de-DE', { style: 'currency', currency });
}

/** New resources carry full ISO timestamps with a zone, so no `+ 'Z'` is needed. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE');
}

/** One entry per non-empty line, as the API expects for additionalInfo. */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}
