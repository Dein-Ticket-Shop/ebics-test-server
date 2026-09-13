import { Hono, type Context } from 'hono';
import type {
  AppStore,
  DeliveryKind,
  PaymentOrder,
  PaymentOrderStatus,
  PaymentStatusCode,
  VopStatus,
} from '../store/types.js';
import {
  PaymentOrderStateError,
  addPaymentStatusEvent,
  cancelPaymentOrder,
  overrideVop,
  rejectPaymentOrder,
  releasePaymentOrder,
} from '../banking/payments.js';
import {
  generateHacReport,
  generatePaymentStatusReport,
  generateVopReport,
  vopGroupStatus,
} from '../banking/generators/pain002.js';
import { partnerDisplayName } from '../handlers/hac.js';
import { generateCustomerProtocolText } from '../banking/generators/ptk.js';

const ORDER_STATUSES: PaymentOrderStatus[] = ['PENDING_EDS', 'EXECUTED', 'CANCELLED', 'REJECTED'];
const STATUS_CODES: PaymentStatusCode[] = ['ACTC', 'ACCP', 'ACSP', 'ACSC', 'ACWC', 'RJCT'];
const VOP_STATUSES: VopStatus[] = ['RCVC', 'RVMC', 'RVNM', 'RVNA'];
const DELIVERY_KINDS: DeliveryKind[] = ['camt.054', 'psr', 'vop', 'hac', 'ptk'];

function xml(c: Context, content: string) {
  return c.body(content, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
}

async function body<T>(c: Context): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

function lines(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/** Admin API for payment orders, the HAC event ledger and download deliveries */
export function createPaymentsAdminRoute(store: AppStore) {
  const app = new Hono();

  const view = (order: PaymentOrder) => {
    const transactions = store.listPaymentTransactions(order.id);
    return {
      ...order,
      vopGroupStatus: vopGroupStatus(transactions.map((tx) => tx.vopStatus)),
      totalCents: transactions.reduce((sum, tx) => sum + tx.amountCents, 0),
      transactions,
      statusEvents: store.listPaymentStatusEvents({ paymentOrderId: order.id }),
    };
  };

  const act = (c: Context, action: () => PaymentOrder) => {
    try {
      return c.json(view(action()));
    } catch (err) {
      if (err instanceof PaymentOrderStateError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };

  const orderParam = (c: Context) => parseInt(c.req.param('id') ?? '', 10);

  app.get('/payments', (c) => {
    const status = c.req.query('status') as PaymentOrderStatus | undefined;
    if (status && !ORDER_STATUSES.includes(status)) return c.json({ error: `Unknown status ${status}` }, 400);
    const orders = store.listPaymentOrders({ partnerId: c.req.query('partnerId') || undefined, status: status || undefined });
    return c.json(orders.map(view));
  });

  app.get('/payments/:id', (c) => {
    const order = store.getPaymentOrder(orderParam(c));
    if (!order) return c.json({ error: 'Not found' }, 404);
    return c.json(view(order));
  });

  app.post('/payments/:id/release', (c) => act(c, () => releasePaymentOrder(store, orderParam(c))));

  app.post('/payments/:id/cancel', async (c) => {
    const input = await body<{ additionalInfo: string[] }>(c);
    return act(c, () => cancelPaymentOrder(store, orderParam(c), lines(input.additionalInfo)));
  });

  app.post('/payments/:id/reject', async (c) => {
    const input = await body<{ reasonCode: string; additionalInfo: string[] }>(c);
    return act(c, () => rejectPaymentOrder(store, orderParam(c), input.reasonCode || undefined, lines(input.additionalInfo)));
  });

  app.post('/payments/:id/status-events', async (c) => {
    const input = await body<{ status: PaymentStatusCode; reasonCode: string; additionalInfo: string[] }>(c);
    if (!input.status || !STATUS_CODES.includes(input.status)) {
      return c.json({ error: `status must be one of ${STATUS_CODES.join(', ')}` }, 400);
    }
    return act(c, () =>
      addPaymentStatusEvent(store, orderParam(c), input.status!, input.reasonCode || undefined, lines(input.additionalInfo)),
    );
  });

  app.patch('/payments/:id/transactions/:txId/vop', async (c) => {
    const input = await body<{ status: VopStatus; correctedName: string }>(c);
    if (!input.status || !VOP_STATUSES.includes(input.status)) {
      return c.json({ error: `status must be one of ${VOP_STATUSES.join(', ')}` }, 400);
    }
    if (input.status === 'RVMC' && !input.correctedName) {
      return c.json({ error: 'correctedName is required for RVMC' }, 400);
    }
    return act(c, () => {
      const id = orderParam(c);
      overrideVop(store, id, parseInt(c.req.param('txId') ?? '', 10), input.status!, input.correctedName);
      return store.getPaymentOrder(id)!;
    });
  });

  app.get('/payments/:id/status-report', (c) => {
    const order = store.getPaymentOrder(orderParam(c));
    if (!order) return c.json({ error: 'Not found' }, 404);
    const latest = store.listPaymentStatusEvents({ paymentOrderId: order.id }).at(-1);
    if (!latest) return c.json({ error: 'No payment status yet' }, 404);
    return xml(c, generatePaymentStatusReport(order, store.listPaymentTransactions(order.id), latest, store.getBankConfig()?.bic));
  });

  app.get('/payments/:id/vop-report', (c) => {
    const order = store.getPaymentOrder(orderParam(c));
    if (!order) return c.json({ error: 'Not found' }, 404);
    const orders = store.listPaymentOrders({ partnerId: order.partnerId, msgId: order.msgId }).reverse();
    return xml(
      c,
      generateVopReport(
        order.msgId,
        orders.map((o) => ({ order: o, transactions: store.listPaymentTransactions(o.id) })),
        orders[0]!.createdAt,
      ),
    );
  });

  app.get('/hac-events', (c) => {
    const partnerId = c.req.query('partnerId') || undefined;
    const events = store.listHacEvents({ partnerId, orderId: c.req.query('orderId') || undefined });
    const delivered = new Map<string, Set<string>>();
    return c.json(
      events.map((event) => {
        if (!delivered.has(event.partnerId)) delivered.set(event.partnerId, store.listDeliveredKeys(event.partnerId, 'hac'));
        return { ...event, delivered: delivered.get(event.partnerId)!.has(`hac:${event.id}`) };
      }),
    );
  });

  app.post('/hac-events', async (c) => {
    const input = await body<{
      partnerId: string;
      userId: string;
      orderId: string;
      action: string;
      adminOrderType: string;
      serviceName: string;
      serviceOption: string;
      scope: string;
      containerType: string;
      msgName: string;
      orderIdRef: string;
      adminOrderTypeRef: string;
      reasonCode: string;
      additionalInfo: string[];
    }>(c);
    if (!input.partnerId || !input.action || !input.adminOrderType) {
      return c.json({ error: 'partnerId, action and adminOrderType are required' }, 400);
    }
    const event = store.appendHacEvent({
      partnerId: input.partnerId,
      userId: input.userId || undefined,
      orderId: input.orderId || store.nextOrderId(input.partnerId),
      action: input.action,
      adminOrderType: input.adminOrderType,
      serviceName: input.serviceName || undefined,
      serviceOption: input.serviceOption || undefined,
      scope: input.scope || undefined,
      containerType: input.containerType || undefined,
      msgName: input.msgName || undefined,
      orderIdRef: input.orderIdRef || undefined,
      adminOrderTypeRef: input.adminOrderTypeRef || undefined,
      reasonCode: input.reasonCode || undefined,
      additionalInfo: lines(input.additionalInfo),
    });
    return c.json({ ...event, delivered: false }, 201);
  });

  app.get('/hac/report', (c) => {
    const partnerId = c.req.query('partnerId');
    if (!partnerId) return c.json({ error: 'partnerId is required' }, 400);
    return xml(
      c,
      generateHacReport(store.listHacEvents({ partnerId }), {
        bankBic: store.getBankConfig()?.bic,
        customerName: (id) => partnerDisplayName(store, id),
      }),
    );
  });

  app.get('/ptk/report', (c) => {
    const partnerId = c.req.query('partnerId');
    if (!partnerId) return c.json({ error: 'partnerId is required' }, 400);
    const text = generateCustomerProtocolText(store.listHacEvents({ partnerId }), {
      hostId: store.getHostConfig()?.hostId ?? '',
      partnerId,
      customerName: partnerDisplayName(store, partnerId),
    });
    return c.body(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  });

  app.post('/deliveries/reset', async (c) => {
    const input = await body<{ partnerId: string; kind: DeliveryKind }>(c);
    if (input.kind && !DELIVERY_KINDS.includes(input.kind)) {
      return c.json({ error: `kind must be one of ${DELIVERY_KINDS.join(', ')}` }, 400);
    }
    return c.json({ reset: store.resetDeliveries({ partnerId: input.partnerId || undefined, kind: input.kind || undefined }) });
  });

  return app;
}
