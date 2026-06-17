import { describe, it, expect } from 'vitest';
import { parseXml, getRootElementName, getRootNamespace, xpathString, xpathSelect, XmlParseError } from '../../src/protocol/xml-parser.js';

describe('xml-parser', () => {
  describe('parseXml', () => {
    it('should parse valid XML', () => {
      const doc = parseXml('<root><child>text</child></root>');
      expect(doc.documentElement).toBeTruthy();
      expect(doc.documentElement.localName).toBe('root');
    });

    it('should throw XmlParseError on malformed XML', () => {
      expect(() => parseXml('<unclosed')).toThrow();
    });

    it('should throw on empty string', () => {
      expect(() => parseXml('')).toThrow();
    });

    it('should handle XML with multiple namespaces', () => {
      const xml = `<root xmlns="urn:ns1" xmlns:ns2="urn:ns2"><ns2:child>val</ns2:child></root>`;
      const doc = parseXml(xml);
      expect(doc.documentElement.namespaceURI).toBe('urn:ns1');
    });

    it('should handle XML declaration', () => {
      const doc = parseXml('<?xml version="1.0" encoding="UTF-8"?><root/>');
      expect(doc.documentElement.localName).toBe('root');
    });
  });

  describe('getRootElementName', () => {
    it('should return local name without prefix', () => {
      const doc = parseXml('<ebics:request xmlns:ebics="urn:org:ebics:H005"/>');
      expect(getRootElementName(doc)).toBe('request');
    });

    it('should return local name for unprefixed element', () => {
      const doc = parseXml('<ebicsHEVRequest xmlns="http://www.ebics.org/H000"/>');
      expect(getRootElementName(doc)).toBe('ebicsHEVRequest');
    });
  });

  describe('getRootNamespace', () => {
    it('should return namespace URI', () => {
      const doc = parseXml('<root xmlns="urn:test:ns"/>');
      expect(getRootNamespace(doc)).toBe('urn:test:ns');
    });

    it('should return undefined for no namespace', () => {
      const doc = parseXml('<root/>');
      expect(getRootNamespace(doc)).toBeUndefined();
    });
  });

  describe('xpathString', () => {
    it('should extract text content', () => {
      const doc = parseXml('<root xmlns="urn:org:ebics:H005"><HostID>BANK1</HostID></root>');
      expect(xpathString('//ebics:HostID/text()', doc)).toBe('BANK1');
    });

    it('should work with HEV namespace', () => {
      const doc = parseXml('<ebicsHEVRequest xmlns="http://www.ebics.org/H000"><HostID>TEST</HostID></ebicsHEVRequest>');
      expect(xpathString('//hev:HostID/text()', doc)).toBe('TEST');
    });

    it('should return undefined for non-existent path', () => {
      const doc = parseXml('<root xmlns="urn:org:ebics:H005"><A>1</A></root>');
      expect(xpathString('//ebics:NonExistent/text()', doc)).toBeUndefined();
    });

    it('should handle deeply nested elements', () => {
      const doc = parseXml(`<root xmlns="urn:org:ebics:H005"><header><static><HostID>DEEP</HostID></static></header></root>`);
      expect(xpathString('//ebics:HostID/text()', doc)).toBe('DEEP');
    });
  });

  describe('xpathSelect', () => {
    it('should return multiple nodes', () => {
      const doc = parseXml('<root xmlns="urn:org:ebics:H005"><item>A</item><item>B</item></root>');
      const result = xpathSelect('//ebics:item', doc);
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(2);
    });
  });
});
