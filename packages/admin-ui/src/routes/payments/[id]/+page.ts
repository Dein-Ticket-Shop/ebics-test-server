import { getPayment, listHacEvents } from '$lib/api.js';

export async function load({ params }: { params: { id: string } }) {
  const payment = await getPayment(parseInt(params.id, 10));
  // Order IDs are allocated per partner, so scope the protocol lookup to this partner.
  const hacEvents = await listHacEvents({ partnerId: payment.partnerId, orderId: payment.orderId }).catch(() => []);
  return { payment, hacEvents };
}
