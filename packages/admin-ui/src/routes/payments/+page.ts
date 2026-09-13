import { getServerFlags, listPayments } from '$lib/api.js';
import type { PaymentOrderStatus } from '$lib/types.js';

const STATUSES: PaymentOrderStatus[] = ['PENDING_EDS', 'EXECUTED', 'CANCELLED', 'REJECTED'];

export async function load({ url }: { url: URL }) {
  const statusParam = url.searchParams.get('status');
  const status = STATUSES.includes(statusParam as PaymentOrderStatus) ? (statusParam as PaymentOrderStatus) : undefined;
  const [payments, flags] = await Promise.all([listPayments({ status }), getServerFlags().catch(() => null)]);
  return { payments, flags, status: status ?? ('' as const) };
}
