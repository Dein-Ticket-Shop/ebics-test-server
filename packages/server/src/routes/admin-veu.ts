import { Hono, type Context } from 'hono';
import type { AppStore } from '../store/types.js';
import {
  VeuError,
  cancelVeuOrder,
  distinctSigners,
  getVeuOrder,
  hasRequiredSignatures,
  isReleasable,
  listVeuOrders,
  numSigRequired,
  signVeuOrder,
  type VeuOrder,
} from '../banking/veu.js';
import { vopGroupStatus } from '../banking/generators/pain002.js';

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

/** Bank-side VEU: orders waiting for electronic signatures, signed or cancelled on behalf of a user */
export function createVeuAdminRoute(store: AppStore) {
  const app = new Hono();

  const view = (veu: VeuOrder) => {
    const first = veu.orders[0]!;
    const transactions = veu.orders.flatMap((o) => store.listPaymentTransactions(o.id));
    return {
      partnerId: veu.partnerId,
      orderId: veu.orderId,
      paymentOrderIds: veu.orders.map((o) => o.id),
      serviceName: first.serviceName,
      serviceOption: first.serviceOption,
      msgName: first.msgName,
      msgId: first.msgId,
      originatorUserId: first.userId,
      createdAt: first.createdAt,
      debtorName: first.debtorName,
      debtorIban: first.debtorIban,
      totalCents: transactions.reduce((sum, tx) => sum + tx.amountCents, 0),
      currency: transactions[0]?.currency ?? 'EUR',
      vopGroupStatus: vopGroupStatus(transactions.map((tx) => tx.vopStatus)),
      transactions,
      signatures: veu.signatures,
      signaturesDone: distinctSigners(veu),
      signaturesComplete: hasRequiredSignatures(veu),
      numSigRequired: numSigRequired(veu),
      vopConfirmationRequired: veu.vopConfirmationRequired,
      vopConfirmed: veu.vopConfirmed,
      releasable: isReleasable(veu),
      dataDigest: veu.dataDigest,
    };
  };

  const signerFor = (c: Context, userId: string | undefined) => {
    const partnerId = c.req.param('partnerId') ?? '';
    if (!userId) return { error: 'userId is required' };
    if (!store.getSubscriber(partnerId, userId)) return { error: `Unknown user ${userId} for partner ${partnerId}` };
    return { request: { partnerId, orderId: c.req.param('orderId') ?? '', userId } };
  };

  app.get('/veu/orders', (c) => c.json(listVeuOrders(store, c.req.query('partnerId') || undefined).map(view)));

  app.get('/veu/orders/:partnerId/:orderId', (c) => {
    const veu = getVeuOrder(store, c.req.param('partnerId'), c.req.param('orderId'));
    return veu ? c.json(view(veu)) : c.json({ error: 'Not found' }, 404);
  });

  app.post('/veu/orders/:partnerId/:orderId/sign', async (c) => {
    const input = await body<{ userId: string }>(c);
    const signer = signerFor(c, input.userId);
    if (signer.error) return c.json({ error: signer.error }, 400);
    try {
      const result = signVeuOrder(store, signer.request!);
      const remaining = getVeuOrder(store, signer.request!.partnerId, signer.request!.orderId);
      return c.json({ ...result, order: remaining ? view(remaining) : null });
    } catch (err) {
      if (err instanceof VeuError) return c.json({ error: err.message, returnCode: err.returnCode }, 409);
      throw err;
    }
  });

  app.post('/veu/orders/:partnerId/:orderId/cancel', async (c) => {
    const input = await body<{ userId: string; additionalInfo: string[] }>(c);
    const signer = signerFor(c, input.userId);
    if (signer.error) return c.json({ error: signer.error }, 400);
    try {
      const info = Array.isArray(input.additionalInfo) ? input.additionalInfo.filter((line) => typeof line === 'string' && line) : [];
      return c.json(cancelVeuOrder(store, signer.request!, info));
    } catch (err) {
      if (err instanceof VeuError) return c.json({ error: err.message, returnCode: err.returnCode }, 409);
      throw err;
    }
  });

  return app;
}
