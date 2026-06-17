import type { HandlerContext } from './handler-types.js';
import type { Subscriber, HostConfig, AppStore } from '../store/types.js';
import { xpathString } from '../protocol/xml-parser.js';
import { generateCamt053 } from '../banking/generators/camt053.js';
import { generateMt940 } from '../banking/generators/mt940.js';

export function handleBtd(
  ctx: HandlerContext,
  subscriber: Subscriber,
  _hostConfig: HostConfig,
  store: AppStore,
): string | null {
  const serviceName = xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:ServiceName/text()', ctx.doc);
  const msgName = xpathString('//ebics:BTDOrderParams/ebics:Service/ebics:MsgName/text()', ctx.doc);

  if (!serviceName) {
    return null;
  }

  // Static seeding takes priority — explicit download_data overrides dynamic generation
  const data = store.getDownloadData(serviceName, msgName ?? undefined);
  if (data) {
    return data.content;
  }

  const dynamic = tryDynamicGeneration(store, subscriber, serviceName, msgName ?? undefined, ctx);
  if (dynamic !== undefined) return dynamic;

  return null;
}

function tryDynamicGeneration(
  store: AppStore,
  subscriber: Subscriber,
  serviceName: string,
  msgName: string | undefined,
  ctx: HandlerContext,
): string | null | undefined {
  if (serviceName !== 'STA') return undefined;
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
  let hasAny = false;
  const parts: string[] = [];

  for (const account of accounts) {
    const person = store.getPerson(account.personId);
    if (!person) continue;

    const bookings = store.listBookingsForAccount(account.id, fromDate, toDate);
    const openingBalance = store.getOpeningBalanceCents(account.id, fromDate);

    parts.push(generateCamt053(account, person, bankConfig, bookings, openingBalance, fromDate, toDate));
    hasAny = true;
  }

  if (!hasAny) return null;
  if (parts.length === 1) return parts[0];
  return parts[0];
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
