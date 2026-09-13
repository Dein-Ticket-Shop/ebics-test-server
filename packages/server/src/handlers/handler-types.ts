import type { DeliveryKind } from '../store/types.js';
import type { XmlDocument } from '../protocol/xml-parser.js';

export interface HandlerContext {
  rawXml: string;
  doc: XmlDocument;
  hostId: string;
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
  content: string;
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
