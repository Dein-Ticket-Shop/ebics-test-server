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
