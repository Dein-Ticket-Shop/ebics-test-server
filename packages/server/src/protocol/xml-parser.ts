import { DOMParser, type Document as XmlDocument } from '@xmldom/xmldom';
import xpath from 'xpath';
import { EBICS_NS } from './constants.js';

export type { XmlDocument };

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

export function parseXml(xmlString: string): XmlDocument {
  const errors: string[] = [];

  const parser = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level === 'error' || level === 'fatalError') {
        errors.push(msg);
      }
    },
  });

  const doc = parser.parseFromString(xmlString, 'text/xml');

  if (errors.length > 0) {
    throw new XmlParseError(errors.join('; '));
  }

  if (!doc.documentElement) {
    throw new XmlParseError('No document element');
  }

  return doc;
}

const nsResolver = xpath.useNamespaces({
  ebics: EBICS_NS.H005,
  hev: EBICS_NS.H000,
  ds: EBICS_NS.XMLDSIG,
  s002: EBICS_NS.S002,
});

export function xpathSelect(expression: string, doc: XmlDocument, extraNamespaces?: Record<string, string>) {
  if (extraNamespaces) {
    const resolver = xpath.useNamespaces({ ...Object.fromEntries(Object.entries({ ebics: EBICS_NS.H005, hev: EBICS_NS.H000, ds: EBICS_NS.XMLDSIG, s002: EBICS_NS.S002 })), ...extraNamespaces });
    return resolver(expression, doc as unknown as Node);
  }
  return nsResolver(expression, doc as unknown as Node);
}

export function xpathString(expression: string, doc: XmlDocument): string | undefined {
  const result = nsResolver(expression, doc as unknown as Node);
  if (Array.isArray(result) && result.length > 0) {
    const node = result[0];
    if (node && typeof node === 'object' && 'nodeValue' in node) {
      return (node as { nodeValue: string | null }).nodeValue ?? undefined;
    }
    if (typeof node === 'string') return node;
  }
  return undefined;
}

export function getRootElementName(doc: XmlDocument): string | undefined {
  return doc.documentElement?.localName ?? undefined;
}

export function getRootNamespace(doc: XmlDocument): string | undefined {
  return doc.documentElement?.namespaceURI ?? undefined;
}
