import { Hono } from 'hono';
import { parseXml, getRootElementName, xpathString } from '../protocol/xml-parser.js';
import { dispatch, type DispatcherConfig } from '../protocol/dispatcher.js';
import { validateXml, selectRequestValidator, selectResponseValidator } from '../protocol/xml-validator.js';
import { ReturnCode } from '../protocol/return-codes.js';
import { buildHevResponse } from '../protocol/xml-builder.js';

export interface EbicsRouteConfig {
  dispatcher: DispatcherConfig;
  validateRequests?: boolean;
  validateResponses?: boolean;
}

export function createEbicsRoute(config: EbicsRouteConfig) {
  const app = new Hono();
  const { validateRequests = true, validateResponses = true } = config;

  app.post('/', async (c) => {
    const startTime = Date.now();
    const rawBody = await c.req.text();

    if (!rawBody || rawBody.trim().length === 0) {
      return c.text('', 400);
    }

    let doc;
    try {
      doc = parseXml(rawBody);
    } catch {
      const responseXml = buildHevResponse(ReturnCode.EBICS_INVALID_XML, '[EBICS_INVALID_XML] Invalid XML', []);
      logExchange(config, rawBody, responseXml, startTime);
      return c.body(responseXml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
    }

    const rootElement = getRootElementName(doc);
    if (!rootElement) {
      const responseXml = buildHevResponse(ReturnCode.EBICS_INVALID_XML, '[EBICS_INVALID_XML] Invalid XML', []);
      logExchange(config, rawBody, responseXml, startTime);
      return c.body(responseXml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
    }

    if (validateRequests) {
      try {
        const validatorName = selectRequestValidator(rootElement);
        validateXml(rawBody, validatorName);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Schema validation failed';
        const responseXml = buildHevResponse(
          ReturnCode.EBICS_INVALID_XML,
          `[EBICS_INVALID_XML] ${message}`,
          [],
        );
        logExchange(config, rawBody, responseXml, startTime);
        return c.body(responseXml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
      }
    }

    const ctx = { rawXml: rawBody, doc, hostId: '' };
    const result = await dispatch(ctx, config.dispatcher);

    if (validateResponses) {
      try {
        const responseDoc = parseXml(result.responseXml);
        const responseRoot = getRootElementName(responseDoc);
        if (responseRoot) {
          const validatorName = selectResponseValidator(responseRoot);
          validateXml(result.responseXml, validatorName);
        }
      } catch (err) {
        console.error('Response XSD validation failed (server bug):', err);
      }
    }

    logExchange(config, rawBody, result.responseXml, startTime, doc);

    return c.body(result.responseXml, 200, {
      'Content-Type': 'text/xml; charset=utf-8',
    });
  });

  return app;
}

function logExchange(
  config: EbicsRouteConfig,
  requestXml: string,
  responseXml: string,
  startTime: number,
  requestDoc?: ReturnType<typeof parseXml>,
): void {
  try {
    const durationMs = Date.now() - startTime;
    let rootElement: string | undefined;
    let orderType: string | undefined;
    let partnerId: string | undefined;
    let userId: string | undefined;
    let transactionId: string | undefined;
    let transactionPhase: string | undefined;
    let returnCode: string | undefined;

    if (requestDoc) {
      rootElement = getRootElementName(requestDoc);
      orderType = xpathString('//ebics:AdminOrderType/text()', requestDoc);
      partnerId = xpathString('//ebics:PartnerID/text()', requestDoc);
      userId = xpathString('//ebics:UserID/text()', requestDoc);
      transactionId = xpathString('//ebics:header/ebics:static/ebics:TransactionID/text()', requestDoc);
      transactionPhase = xpathString('//ebics:mutable/ebics:TransactionPhase/text()', requestDoc);
    }

    try {
      const responseDoc = parseXml(responseXml);
      returnCode = xpathString('//ebics:mutable/ebics:ReturnCode/text()', responseDoc)
        ?? xpathString('//ebics:ReturnCode/text()', responseDoc);
      if (!transactionId) {
        transactionId = xpathString('//ebics:TransactionID/text()', responseDoc);
      }
    } catch { /* response might not be valid XML (HEV error) */ }

    config.dispatcher.store.logProtocol({
      rootElement,
      orderType,
      partnerId,
      userId,
      transactionId,
      transactionPhase,
      returnCode,
      requestXml,
      responseXml,
      durationMs,
    });
  } catch {
    // never let logging failures break the protocol
  }
}
