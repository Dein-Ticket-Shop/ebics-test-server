/**
 * Structured logging for the test server, built on pino.
 *
 * Every record carries machine-readable fields (so logs can be shipped or
 * grepped), while a human watching the terminal gets a concise, colourised
 * line per event: one per EBICS exchange, plus highlights for interesting
 * events (money moved) and anything that failed.
 *
 * Control with the environment:
 *   EBICS_LOG_LEVEL   pino level (trace..fatal, or `silent`). Default `info`.
 *   EBICS_QUIET=true  shorthand for `silent`.
 *   EBICS_LOG_JSON=1  force raw JSON output (no pretty printing).
 * Colour follows the usual `NO_COLOR` convention.
 */

import { pino } from 'pino';
import { ReturnCode } from './protocol/return-codes.js';

const level = process.env['EBICS_QUIET'] === 'true' || process.env['EBICS_QUIET'] === '1'
  ? 'silent'
  : process.env['EBICS_LOG_LEVEL'] ?? 'info';

const pretty = !process.env['EBICS_LOG_JSON'] && process.stdout.isTTY;

export const logger = pino({
  level,
  base: undefined, // drop pid/hostname noise
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: !process.env['NO_COLOR'],
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,evt',
            messageFormat: '{msg}',
          },
        },
      }
    : {}),
});

// Reverse lookup: return-code value ('000000') -> name ('EBICS_OK').
const RETURN_CODE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(ReturnCode).map(([name, value]) => [value, name]),
);

/** OK family: 00xxxx technical OK and 011xxx download post-process codes. */
function isOk(code: string | undefined): boolean {
  if (!code) return true;
  return code.startsWith('00') || code.startsWith('011');
}

/** Benign "nothing to do" business outcomes: not OK, but not a real error either. */
const BENIGN = new Set<string>([ReturnCode.EBICS_NO_DOWNLOAD_DATA_AVAILABLE]);

export interface EbicsLogFields {
  rootElement?: string;
  orderType?: string;
  partnerId?: string;
  userId?: string;
  transactionId?: string;
  transactionPhase?: string;
  returnCode?: string;
  durationMs: number;
}

/** Short label for the request: order type, else continuation phase, else root element. */
function requestLabel(f: EbicsLogFields): string {
  if (f.orderType) return f.orderType;
  if (f.transactionId && f.transactionPhase) return f.transactionPhase; // Transfer / Receipt
  if (f.rootElement === 'ebicsHEVRequest') return 'HEV';
  return f.rootElement ?? 'request';
}

export function logEbicsExchange(f: EbicsLogFields): void {
  const ok = isOk(f.returnCode);
  const benign = f.returnCode ? BENIGN.has(f.returnCode) : false;
  const codeName = f.returnCode ? RETURN_CODE_NAMES[f.returnCode] ?? f.returnCode : '';
  const mark = ok ? '✓' : benign ? '•' : '✗';

  const label = requestLabel(f).padEnd(8);
  const who = f.partnerId && f.userId ? `${f.partnerId}/${f.userId} ` : '';
  const msg = `EBICS  ${label} ${who}${mark} ${codeName} ${f.durationMs}ms`.replace(/ +/g, ' ');

  const fields = {
    evt: 'ebics',
    orderType: f.orderType,
    rootElement: f.rootElement,
    partnerId: f.partnerId,
    userId: f.userId,
    transactionId: f.transactionId,
    transactionPhase: f.transactionPhase,
    returnCode: f.returnCode,
    returnCodeName: codeName || undefined,
    durationMs: f.durationMs,
    msg,
  };

  // Protocol-level rejections are notable but not server faults -> warn.
  if (ok || benign) logger.info(fields);
  else logger.warn(fields);
}

export interface MoneyLogFields {
  amountCents: number;
  currency: string;
  from?: string;
  to?: string;
  toIban?: string;
  remittance?: string;
  /** true when the transfer actually changed a balance held on this server. */
  internal: boolean;
}

function formatAmount(cents: number, currency: string): string {
  const value = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value} ${currency}`;
}

export function logMoney(f: MoneyLogFields): void {
  const flow = `${f.from ?? '?'} -> ${f.to ?? f.toIban ?? '?'}`;
  const tag = f.internal ? '[booked]' : '[external]';
  const note = f.remittance ? ` "${f.remittance}"` : '';
  const msg = `MONEY  ${formatAmount(f.amountCents, f.currency)}  ${flow} ${tag}${note}`;

  logger.info({
    evt: 'money',
    amountCents: f.amountCents,
    currency: f.currency,
    from: f.from,
    to: f.to,
    toIban: f.toIban,
    remittance: f.remittance,
    internal: f.internal,
    msg,
  });
}

/** Generic server-level line (startup banner, lifecycle notices). */
export function logServer(message: string): void {
  logger.info({ evt: 'server', msg: `SERVER  ${message}` });
}

/**
 * Something went wrong. `context` says where, e.g. "pain.001 processing".
 * Logged at error level with the error attached for structured consumers.
 */
export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  logger.error({ evt: 'error', context, err, msg: `ERROR  ${context}: ${detail}` });
}
