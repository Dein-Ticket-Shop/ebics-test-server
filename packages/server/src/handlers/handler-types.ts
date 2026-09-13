import type { DeliveryKind } from '../store/types.js';
import type { ReturnCode } from '../protocol/return-codes.js';
import type { XmlDocument } from '../protocol/xml-parser.js';

export interface HandlerContext {
  rawXml: string;
  doc: XmlDocument;
  hostId: string;
  /** URL of the EBICS request, used to build URLs handed to the client (e.g. the real-time endpoint) */
  requestUrl?: string;
}

export interface HandlerLogEntry {
  orderType?: string;
  partnerId?: string;
  userId?: string;
  resultCode?: string;
}

export interface HandlerResult {
  responseXml: string;
  logEntry?: HandlerLogEntry;
}

export type EbicsHandler = (ctx: HandlerContext) => HandlerResult | Promise<HandlerResult>;

export interface DownloadDocument {
  name: string;
  content: string | Buffer;
}

/**
 * Download order data made of separate documents. Zipped when the client requests
 * `<Container containerType="ZIP">`, otherwise the documents are joined by newlines.
 * Items listed in `deliveryKeys` are marked delivered when the client sends a positive receipt.
 */
export interface DownloadPayload {
  documents: DownloadDocument[];
  deliveryKind?: DeliveryKind;
  deliveryKeys?: string[];
}

export type DownloadOrderData = string | DownloadPayload | null;

/** Thrown by an order handler to answer with an EBICS business return code instead of order data */
export class OrderRejection extends Error {
  constructor(
    readonly returnCode: ReturnCode,
    message?: string,
  ) {
    super(message ?? returnCode);
    this.name = 'OrderRejection';
  }
}
