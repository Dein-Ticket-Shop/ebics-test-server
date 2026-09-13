import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppStore, Booking, HacEvent, PaymentOrder, PaymentStatusEvent } from '../store/types.js';
import { wssOneTimeTokens, wssReplay } from '../config/feature-flags.js';

/**
 * EBICS real-time notifications (DK DFÜ-Abkommen Anlage 2 "Spezifikation Echtzeitbenachrichtigungen" V1.0):
 * the client fetches connection parameters with BTD OTH/DE/wssparam, connects to the WebSocket with HTTP
 * Basic auth "PARTNERID_USERID:TOKEN" and receives "EBICS-HAA" messages naming the BTFs or order types
 * with new data. Messages only flow from server to client.
 */

export const REALTIME_PATH = '/realtime';

/** The WebSocket URL (ws:// or wss://) of the real-time endpoint on the server that received the given request URL */
export function realtimeUrl(requestUrl: string): string {
  const url = new URL(REALTIME_PATH, requestUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
const TOKEN_VALIDITY_MS = 60 * 60 * 1000;
const BATCH_DELAY_MS = 50;

export interface BtfNotification {
  SERVICE: string;
  SCOPE?: string;
  OPTION?: string;
  CONTTYPE?: string;
  MSGNAME: string;
}

export interface WssParameters {
  TOKEN: string;
  /** One-time token: Y = usable once, N = usable until VALIDITY */
  OTT: 'Y' | 'N';
  VALIDITY: string;
  PARTNERID: string;
  USERID?: string;
}

export interface HaaMessage {
  MCLASS: { NAME: 'EBICS-HAA'; VERS: '1.0'; TIMESTAMP: string }[];
  PARTNERID: string;
  USERID?: string;
  BTF?: BtfNotification[];
  ORDERTYPE?: string[];
}

export interface InfoMessage {
  MCLASS: { NAME: 'INFO'; VERS: '1.0'; TIMESTAMP: string }[];
  INFO: { LANG: string; FREE: string }[];
}

/** Messages kept for a customer without an open connection (EBICS_WSS_REPLAY), oldest first */
export interface KeptMessages {
  partnerId: string;
  messages: (HaaMessage | InfoMessage)[];
}

export interface RealtimeConnection {
  id: string;
  partnerId: string;
  userId?: string;
  connectedAt: string;
}

interface IssuedToken {
  partnerId: string;
  userId?: string;
  validUntil: number;
  oneTime: boolean;
  used: boolean;
}

interface PendingNotification {
  btf: Map<string, BtfNotification>;
  orderTypes: Set<string>;
}

const hubs = new WeakMap<AppStore, RealtimeHub>();

/** The hub of a store, created on first use */
export function realtimeHubFor(store: AppStore): RealtimeHub {
  return hubs.get(store) ?? new RealtimeHub(store);
}

export const NOTIFICATION_BTF = {
  notification: { SERVICE: 'STM', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'camt.054' },
  intraday: { SERVICE: 'STM', SCOPE: 'DE', CONTTYPE: 'ZIP', MSGNAME: 'camt.052' },
  paymentStatus: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'SCI', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' },
  vop: { SERVICE: 'REP', SCOPE: 'DE', OPTION: 'VOP', CONTTYPE: 'ZIP', MSGNAME: 'pain.002' },
} satisfies Record<string, BtfNotification>;

export class RealtimeHub {
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly connections = new Map<WebSocket, RealtimeConnection>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pending = new Map<string, PendingNotification>();
  private readonly kept = new Map<string, (HaaMessage | InfoMessage)[]>();
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly store: AppStore) {
    hubs.set(store, this);
    store.events.on('booking', (booking: Booking) => this.onBooking(booking));
    store.events.on('paymentStatus', (event: PaymentStatusEvent) => this.onPaymentStatus(event));
    store.events.on('paymentOrder', (order: PaymentOrder) => this.queue(order.partnerId, { btf: NOTIFICATION_BTF.vop }));
    store.events.on('hacEvent', (event: HacEvent) => this.queue(event.partnerId, { orderType: 'HAC' }));
  }

  /** wssparam order data without the URL (the caller knows the public address) */
  issueToken(partnerId: string, userId?: string): WssParameters {
    const token = randomUUID();
    const oneTime = wssOneTimeTokens();
    const validUntil = Date.now() + TOKEN_VALIDITY_MS;
    this.tokens.set(token, { partnerId, userId, validUntil, oneTime, used: false });
    return {
      TOKEN: token,
      OTT: oneTime ? 'Y' : 'N',
      VALIDITY: new Date(validUntil).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      PARTNERID: partnerId,
      ...(userId ? { USERID: userId } : {}),
    };
  }

  /** Handles WebSocket upgrades on REALTIME_PATH of the given HTTP server */
  attach(server: HttpServer): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== REALTIME_PATH) {
        // Leave the socket to other upgrade handlers if there are any, otherwise don't let the client hang
        if (server.listenerCount('upgrade') === 1) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        }
        return;
      }
      const identity = this.authenticate(request.headers.authorization);
      if (!identity) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="EBICS"\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.connections.set(ws, { id: randomUUID(), ...identity, connectedAt: new Date().toISOString() });
        ws.on('close', () => this.connections.delete(ws));
        this.replay(ws, identity.partnerId);
      });
    });
  }

  /** "Basic base64(PARTNERID[_USERID]:TOKEN)" with a valid token issued for exactly that partner and user */
  authenticate(header: string | undefined): { partnerId: string; userId?: string } | undefined {
    if (!header?.startsWith('Basic ')) return undefined;
    const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = credentials.lastIndexOf(':');
    if (separator < 0) return undefined;
    const [partnerId, ...userParts] = credentials.slice(0, separator).split('_');
    const userId = userParts.join('_') || undefined;
    const tokenValue = credentials.slice(separator + 1);

    const token = this.tokens.get(tokenValue);
    if (!token || token.partnerId !== partnerId || token.userId !== userId) return undefined;
    if (token.validUntil < Date.now()) {
      this.tokens.delete(tokenValue);
      return undefined;
    }
    if (token.oneTime) {
      if (token.used) return undefined;
      token.used = true;
    }
    return { partnerId: partnerId!, userId };
  }

  listConnections(): RealtimeConnection[] {
    return [...this.connections.values()];
  }

  /** Messages kept for customers without an open connection (EBICS_WSS_REPLAY) */
  listKeptMessages(): KeptMessages[] {
    this.dropExpiredKeptMessages();
    return [...this.kept].map(([partnerId, messages]) => ({ partnerId, messages }));
  }

  /**
   * Sends an EBICS-HAA message to every connection of the partner; returns the number of connections reached and
   * whether the message was kept for a later connection instead (1 or 0, EBICS_WSS_REPLAY)
   */
  notify(partnerId: string, content: { userId?: string; btf?: BtfNotification[]; orderTypes?: string[] }): { sent: number; kept: number } {
    const message: HaaMessage = {
      MCLASS: [{ NAME: 'EBICS-HAA', VERS: '1.0', TIMESTAMP: timestamp() }],
      PARTNERID: partnerId,
      ...(content.userId ? { USERID: content.userId } : {}),
      ...(content.btf?.length ? { BTF: content.btf } : {}),
      ...(content.orderTypes?.length ? { ORDERTYPE: content.orderTypes } : {}),
    };
    const sent = this.send(message, (connection) => connection.partnerId === partnerId);
    return { sent, kept: sent === 0 && this.keep(partnerId, message) ? 1 : 0 };
  }

  /**
   * Broadcasts an INFO message to all connections; returns the number of connections reached and of customers without
   * an open connection the message was kept for (EBICS_WSS_REPLAY)
   */
  broadcastInfo(text: string, lang = 'DE'): { sent: number; kept: number } {
    const message: InfoMessage = {
      MCLASS: [{ NAME: 'INFO', VERS: '1.0', TIMESTAMP: timestamp() }],
      INFO: [{ LANG: lang, FREE: text }],
    };
    const reached = new Set(this.openConnections().map((connection) => connection.partnerId));
    const sent = this.send(message, () => true);
    let kept = 0;
    for (const partnerId of this.partnersWithValidToken()) {
      if (!reached.has(partnerId) && this.keep(partnerId, message)) kept++;
    }
    return { sent, kept };
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const ws of this.connections.keys()) ws.terminate();
    this.kept.clear();
    this.wss.close();
  }

  private send(message: HaaMessage | InfoMessage, recipient: (connection: RealtimeConnection) => boolean): number {
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const [ws, connection] of this.connections) {
      if (ws.readyState === ws.OPEN && recipient(connection)) {
        ws.send(payload);
        sent++;
      }
    }
    return sent;
  }

  private openConnections(): RealtimeConnection[] {
    return [...this.connections].filter(([ws]) => ws.readyState === ws.OPEN).map(([, connection]) => connection);
  }

  /** A token issued for the customer has not reached its VALIDITY, so a client of the customer can (re)connect */
  private hasValidToken(partnerId: string): boolean {
    const now = Date.now();
    return [...this.tokens.values()].some((token) => token.partnerId === partnerId && token.validUntil >= now);
  }

  private partnersWithValidToken(): Set<string> {
    const now = Date.now();
    return new Set([...this.tokens.values()].filter((token) => token.validUntil >= now).map((token) => token.partnerId));
  }

  /**
   * DK Anlage 2 (chapters 3.1 and 3.2) lets the bank deliver a message later when no wss connection to the customer is
   * active; its TIMESTAMP stays the first delivery attempt. With EBICS_WSS_REPLAY the message is kept while a token of
   * the customer is valid.
   */
  private keep(partnerId: string, message: HaaMessage | InfoMessage): boolean {
    if (!wssReplay() || !this.hasValidToken(partnerId)) return false;
    this.kept.set(partnerId, [...(this.kept.get(partnerId) ?? []), message]);
    return true;
  }

  private dropExpiredKeptMessages(): void {
    for (const partnerId of [...this.kept.keys()]) {
      if (!this.hasValidToken(partnerId)) this.kept.delete(partnerId);
    }
  }

  /** Sends the messages kept for the customer to a new connection, once */
  private replay(ws: WebSocket, partnerId: string): void {
    this.dropExpiredKeptMessages();
    const messages = this.kept.get(partnerId);
    if (!messages) return;
    this.kept.delete(partnerId);
    for (const message of messages) ws.send(JSON.stringify(message));
  }

  private onBooking(booking: Booking): void {
    const partners = new Set(this.store.listSubscribers().map((s) => s.partnerId));
    for (const partnerId of partners) {
      if (this.store.partnerHasAccountAccess(partnerId, booking.accountId)) {
        this.queue(partnerId, { btf: NOTIFICATION_BTF.notification });
        this.queue(partnerId, { btf: NOTIFICATION_BTF.intraday });
      }
    }
  }

  private onPaymentStatus(event: PaymentStatusEvent): void {
    const order = this.store.getPaymentOrder(event.paymentOrderId);
    if (order) this.queue(order.partnerId, { btf: NOTIFICATION_BTF.paymentStatus });
  }

  /** Collects notifications per partner for a moment so one upload results in one message */
  private queue(partnerId: string, item: { btf?: BtfNotification; orderType?: string }): void {
    if (this.connections.size === 0 && !(wssReplay() && this.hasValidToken(partnerId))) return;
    const pending = this.pending.get(partnerId) ?? { btf: new Map(), orderTypes: new Set() };
    if (item.btf) pending.btf.set(Object.values(item.btf).join('/'), item.btf);
    if (item.orderType) pending.orderTypes.add(item.orderType);
    this.pending.set(partnerId, pending);
    this.flushTimer ??= setTimeout(() => this.flush(), BATCH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    this.flushTimer = undefined;
    for (const [partnerId, pending] of this.pending) {
      this.notify(partnerId, { btf: [...pending.btf.values()], orderTypes: [...pending.orderTypes] });
    }
    this.pending.clear();
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
