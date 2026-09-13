import type { HandlerContext, DownloadOrderData } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore, DateFilter, PaymentOrder } from '../store/types.js';
import { xpathString } from '../protocol/xml-parser.js';
import { generateCamt053Multi, type StatementInput } from '../banking/generators/camt053.js';
import { generateMt940 } from '../banking/generators/mt940.js';
import { generateCamt052 } from '../banking/generators/camt052.js';
import { generateCamt054 } from '../banking/generators/camt054.js';
import { generatePaymentStatusReport, generateVopReport } from '../banking/generators/pain002.js';
import { websocketParameters } from './oth.js';

export function handleBtd(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): DownloadOrderData {
  const serviceName = xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:ServiceName/text()', ctx.doc);
  const msgName = xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:MsgName/text()', ctx.doc);
  const serviceOption = xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:ServiceOption/text()', ctx.doc);

  if (!serviceName) {
    return null;
  }

  // Static seeding takes priority — explicit download_data overrides dynamic generation
  const data = store.getDownloadData(serviceName, msgName ?? undefined, serviceOption ?? undefined);
  if (data) {
    return data.content;
  }

  const dynamic = tryDynamicGeneration(store, subscriber, serviceName, msgName ?? undefined, ctx);
  if (dynamic !== undefined) return dynamic;

  const report = tryReportGeneration(store, subscriber, serviceName, serviceOption, msgName, ctx);
  if (report !== undefined) return report;

  return null;
}

function readDateRange(ctx: HandlerContext): DateFilter {
  return {
    from: xpathString('//ebics:BTDOrderParams/ebics:DateRange/ebics:Start/text()', ctx.doc),
    to: xpathString('//ebics:BTDOrderParams/ebics:DateRange/ebics:End/text()', ctx.doc),
  };
}

/**
 * Reports generated from bookings and payment orders:
 * - STM camt.052: intraday account report (DateRange, default today)
 * - STM camt.054: debit/credit notifications
 * - REP pain.002: payment status reports; with ServiceOption VOP the Verification of Payee reports
 *
 * Without a DateRange, notifications and reports hand out each item once (marked delivered on a
 * positive receipt), like a bank delivering "new" data. With a DateRange everything in range is returned.
 */
function tryReportGeneration(
  store: AppStore,
  subscriber: Subscriber,
  serviceName: string,
  serviceOption: string | undefined,
  msgName: string | undefined,
  ctx: HandlerContext,
): DownloadOrderData | undefined {
  if (serviceName === 'OTH' && msgName === 'wssparam') return websocketParameters(store, subscriber, ctx);
  if (serviceName === 'STM' && msgName === 'camt.052') return intradayReport(store, subscriber, readDateRange(ctx));
  if (serviceName === 'STM' && msgName === 'camt.054') return notifications(store, subscriber, readDateRange(ctx));
  if (serviceName === 'REP' && msgName === 'pain.002') {
    return serviceOption === 'VOP'
      ? vopReports(store, subscriber, readDateRange(ctx))
      : paymentStatusReports(store, subscriber, readDateRange(ctx));
  }
  return undefined;
}

function hasRange(range: DateFilter): boolean {
  return Boolean(range.from || range.to);
}

function intradayReport(store: AppStore, subscriber: Subscriber, range: DateFilter): DownloadOrderData {
  const bankConfig = store.getBankConfig();
  if (!bankConfig) return null;
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = range.from ?? today;
  const toDate = range.to ?? today;

  const reports: StatementInput[] = [];
  for (const account of store.listAccountsForPartner(subscriber.partnerId)) {
    const person = store.getPerson(account.personId);
    if (!person) continue;
    reports.push({
      account,
      person,
      bankConfig,
      bookings: store.listBookingsForAccount(account.id, fromDate, toDate),
      openingBalanceCents: store.getOpeningBalanceCents(account.id, fromDate),
    });
  }
  if (reports.every((r) => r.bookings.length === 0)) return null;

  return { documents: [{ name: 'camt.052.xml', content: generateCamt052(reports, fromDate, toDate) }] };
}

function notifications(store: AppStore, subscriber: Subscriber, range: DateFilter): DownloadOrderData {
  const bankConfig = store.getBankConfig();
  if (!bankConfig) return null;
  const ranged = hasRange(range);
  const delivered = ranged ? new Set<string>() : store.listDeliveredKeys(subscriber.partnerId, 'camt.054');

  const inputs = [];
  const keys: string[] = [];
  for (const account of store.listAccountsForPartner(subscriber.partnerId)) {
    const person = store.getPerson(account.personId);
    if (!person) continue;
    const bookings = store
      .listBookingsForAccount(account.id, range.from, range.to)
      .filter((b) => !delivered.has(`booking:${b.id}`));
    if (bookings.length === 0) continue;
    keys.push(...bookings.map((b) => `booking:${b.id}`));
    inputs.push({ account, person, bankConfig, bookings });
  }
  if (inputs.length === 0) return null;

  return {
    documents: [{ name: 'camt.054.xml', content: generateCamt054(inputs) }],
    ...(ranged ? {} : { deliveryKind: 'camt.054' as const, deliveryKeys: keys }),
  };
}

function paymentStatusReports(store: AppStore, subscriber: Subscriber, range: DateFilter): DownloadOrderData {
  const ranged = hasRange(range);
  const delivered = ranged ? new Set<string>() : store.listDeliveredKeys(subscriber.partnerId, 'psr');
  const events = store
    .listPaymentStatusEvents({ partnerId: subscriber.partnerId, ...range })
    .filter((e) => !delivered.has(`status:${e.id}`));
  if (events.length === 0) return null;

  const bic = store.getBankConfig()?.bic;
  const documents = events.map((event) => {
    const order = store.getPaymentOrder(event.paymentOrderId)!;
    return {
      name: `pain.002.psr.${String(event.id).padStart(8, '0')}.xml`,
      content: generatePaymentStatusReport(order, store.listPaymentTransactions(order.id), event, bic),
    };
  });

  return {
    documents,
    ...(ranged ? {} : { deliveryKind: 'psr' as const, deliveryKeys: events.map((e) => `status:${e.id}`) }),
  };
}

function vopReports(store: AppStore, subscriber: Subscriber, range: DateFilter): DownloadOrderData {
  const ranged = hasRange(range);
  const delivered = ranged ? new Set<string>() : store.listDeliveredKeys(subscriber.partnerId, 'vop');

  const byMessage = new Map<string, PaymentOrder[]>();
  for (const order of store.listPaymentOrders({ partnerId: subscriber.partnerId }).reverse()) {
    const day = order.createdAt.slice(0, 10);
    if (range.from && day < range.from) continue;
    if (range.to && day > range.to) continue;
    if (delivered.has(`vop:${order.msgId}`)) continue;
    byMessage.set(order.msgId, [...(byMessage.get(order.msgId) ?? []), order]);
  }
  if (byMessage.size === 0) return null;

  const documents = [...byMessage.entries()].map(([msgId, orders], index) => ({
    name: `pain.002.vop.${String(index + 1).padStart(4, '0')}.xml`,
    content: generateVopReport(
      msgId,
      orders.map((order) => ({ order, transactions: store.listPaymentTransactions(order.id) })),
      orders[0]!.createdAt,
    ),
  }));

  return {
    documents,
    ...(ranged ? {} : { deliveryKind: 'vop' as const, deliveryKeys: [...byMessage.keys()].map((id) => `vop:${id}`) }),
  };
}

function tryDynamicGeneration(
  store: AppStore,
  subscriber: Subscriber,
  serviceName: string,
  msgName: string | undefined,
  ctx: HandlerContext,
): string | null | undefined {
  // STA / EOP are both statement (End-of-Period) services; EOP is the camt.053 name.
  if (serviceName !== 'STA' && serviceName !== 'EOP') return undefined;
  if (msgName !== 'camt.053' && msgName !== 'mt940') return undefined;

  const bankConfig = store.getBankConfig();
  if (!bankConfig) return undefined;

  const accounts = store.listAccountsForPartner(subscriber.partnerId);
  if (accounts.length === 0) return undefined;

  const fromDateParam = xpathString('//ebics:BTDOrderParams/ebics:DateRange/ebics:Start/text()', ctx.doc);
  const toDateParam = xpathString('//ebics:BTDOrderParams/ebics:DateRange/ebics:End/text()', ctx.doc);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000);
  const fromDate = fromDateParam ?? thirtyDaysAgo.toISOString().slice(0, 10);
  const toDate = toDateParam ?? now.toISOString().slice(0, 10);

  if (msgName === 'camt.053') {
    return generateCamt053ForAccounts(store, bankConfig, accounts, fromDate, toDate);
  }

  return generateMt940ForAccounts(store, bankConfig, accounts, fromDate, toDate);
}

function generateCamt053ForAccounts(
  store: AppStore,
  bankConfig: ReturnType<AppStore['getBankConfig']> & {},
  accounts: ReturnType<AppStore['listAccounts']>,
  fromDate: string,
  toDate: string,
): string | null {
  const statements: StatementInput[] = [];

  for (const account of accounts) {
    const person = store.getPerson(account.personId);
    if (!person) continue;

    const bookings = store.listBookingsForAccount(account.id, fromDate, toDate);
    const openingBalance = store.getOpeningBalanceCents(account.id, fromDate);

    statements.push({ account, person, bankConfig, bookings, openingBalanceCents: openingBalance });
  }

  if (statements.length === 0) return null;
  return generateCamt053Multi(statements, fromDate, toDate);
}

function generateMt940ForAccounts(
  store: AppStore,
  bankConfig: ReturnType<AppStore['getBankConfig']> & {},
  accounts: ReturnType<AppStore['listAccounts']>,
  fromDate: string,
  toDate: string,
): string | null {
  const parts: string[] = [];

  for (const account of accounts) {
    const bookings = store.listBookingsForAccount(account.id, fromDate, toDate);
    const openingBalance = store.getOpeningBalanceCents(account.id, fromDate);
    parts.push(generateMt940(account, bankConfig, bookings, openingBalance, fromDate, toDate));
  }

  if (parts.length === 0) return null;
  return parts.join('\r\n');
}
