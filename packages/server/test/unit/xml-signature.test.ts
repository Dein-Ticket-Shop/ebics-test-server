import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createHash, createSign } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import {
  verifyAuthSignature,
  canonicalizeSubtree,
  extractPublicKeyFromCertPem,
  extractPublicKeyFromCertBase64,
} from '../../src/protocol/xml-signature.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { inflate, base64Decode } from '../../src/protocol/crypto.js';
import forge from 'node-forge';

function makeKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function makeCert(privateKeyPem: string, publicKeyPem: string) {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([{ name: 'commonName', value: 'Test' }]);
  cert.setIssuer([{ name: 'commonName', value: 'Test' }]);
  cert.sign(privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function buildSignedRequest(privateKeyPem: string): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>TEST</HostID></static><mutable/></header><AuthSignature/><body/></ebicsNoPubKeyDigestsRequest>`;

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const authNodes: any[] = [];
  function collect(node: any) {
    if (node.nodeType === 1) {
      if (node.getAttribute?.('authenticate') === 'true') authNodes.push(node);
      if (node.childNodes) for (let i = 0; i < node.childNodes.length; i++) collect(node.childNodes.item(i));
    }
  }
  collect(doc.documentElement);

  let canonicalized = '';
  for (const n of authNodes) canonicalized += canonicalizeSubtree(n);

  const digest = createHash('sha256').update(canonicalized).digest('base64');
  const signedInfoXml = `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#xpointer(//*[@authenticate='true'])"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const withSignedInfo = xml.replace(
    '<AuthSignature/>',
    `<AuthSignature>${signedInfoXml}<ds:SignatureValue>__SIGNATURE__</ds:SignatureValue></AuthSignature>`,
  );

  // SignedInfo is canonicalized in its document context (inherits the default and ds namespaces)
  const signedDoc = new DOMParser().parseFromString(withSignedInfo, 'text/xml');
  const signedInfo = signedDoc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignedInfo').item(0);
  const signer = createSign('RSA-SHA256');
  signer.update(canonicalizeSubtree(signedInfo));
  return withSignedInfo.replace('__SIGNATURE__', signer.sign(privateKeyPem, 'base64'));
}

describe('xml-signature', () => {
  const keyPair = makeKeyPair();

  describe('verifyAuthSignature', () => {
    it('should return true for valid signature', () => {
      const signedXml = buildSignedRequest(keyPair.privateKey);
      const doc = parseXml(signedXml);
      expect(verifyAuthSignature(doc, keyPair.publicKey)).toBe(true);
    });

    it('should return false for tampered content', () => {
      const signedXml = buildSignedRequest(keyPair.privateKey).replace('TEST', 'TAMPERED');
      const doc = parseXml(signedXml);
      expect(verifyAuthSignature(doc, keyPair.publicKey)).toBe(false);
    });

    it('should return false for wrong key', () => {
      const otherKey = makeKeyPair();
      const signedXml = buildSignedRequest(keyPair.privateKey);
      const doc = parseXml(signedXml);
      expect(verifyAuthSignature(doc, otherKey.publicKey)).toBe(false);
    });

    it('should return false when AuthSignature missing', () => {
      const xml = `<ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><body/></ebicsNoPubKeyDigestsRequest>`;
      const doc = parseXml(xml);
      expect(verifyAuthSignature(doc, keyPair.publicKey)).toBe(false);
    });

    it('should return false when SignedInfo missing', () => {
      const xml = `<ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><AuthSignature><ds:SignatureValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">abc</ds:SignatureValue></AuthSignature><body/></ebicsNoPubKeyDigestsRequest>`;
      const doc = parseXml(xml);
      expect(verifyAuthSignature(doc, keyPair.publicKey)).toBe(false);
    });

    it('should return false when SignatureValue empty', () => {
      const xml = `<ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><AuthSignature><ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#xpointer(//*[@authenticate='true'])"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>bad</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#"></ds:SignatureValue></AuthSignature><body/></ebicsNoPubKeyDigestsRequest>`;
      const doc = parseXml(xml);
      expect(verifyAuthSignature(doc, keyPair.publicKey)).toBe(false);
    });
  });

  describe('canonicalizeSubtree (inclusive C14N 1.0 of a document subset)', () => {
    const DS = 'http://www.w3.org/2000/09/xmldsig#';
    const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

    it('renders every namespace inherited from the request root on the apex element', () => {
      const doc = parseXml(
        `<ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" xmlns:xsi="${XSI}" Version="H005" xsi:schemaLocation="urn:org:ebics:H005 ebics_H005.xsd"><header authenticate="true"><static><HostID>H</HostID></static><mutable/></header></ebicsNoPubKeyDigestsRequest>`,
      );
      const header = doc.getElementsByTagNameNS('urn:org:ebics:H005', 'header').item(0);
      expect(canonicalizeSubtree(header)).toBe(
        `<header xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" xmlns:xsi="${XSI}" authenticate="true"><static><HostID>H</HostID></static><mutable></mutable></header>`,
      );
    });

    it('only renders namespaces that are actually declared on ancestors', () => {
      const doc = parseXml(
        `<ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" Version="H005"><header authenticate="true"><static/></header></ebicsRequest>`,
      );
      const header = doc.getElementsByTagNameNS('urn:org:ebics:H005', 'header').item(0);
      expect(canonicalizeSubtree(header)).toBe(
        `<header xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" authenticate="true"><static></static></header>`,
      );
    });

    it('renders the inherited default namespace first on a prefixed apex (SignedInfo)', () => {
      const doc = parseXml(
        `<ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" xmlns:xsi="${XSI}"><AuthSignature><ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:SignedInfo></AuthSignature></ebicsRequest>`,
      );
      const signedInfo = doc.getElementsByTagNameNS(DS, 'SignedInfo').item(0);
      expect(canonicalizeSubtree(signedInfo)).toBe(
        `<ds:SignedInfo xmlns="urn:org:ebics:H005" xmlns:ds="${DS}" xmlns:xsi="${XSI}"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod></ds:SignedInfo>`,
      );
    });
  });

  describe('client requests declaring xmlns:xsi on the root (regression fixture)', () => {
    // INI/HIA/HPB exchange recorded from a real client whose request root declares xmlns, xmlns:ds and xmlns:xsi.
    // The recorded signature was cross-checked with Apache Santuario's inclusive C14N; the fixture is re-signed
    // with a test key in the same canonical form.
    const fixture = (name: string) => readFileSync(new URL(`../fixtures/client-requests/${name}`, import.meta.url), 'utf8');

    function authPublicKeyFromHia(): string {
      const hiaDoc = parseXml(fixture('hia-request.xml'));
      const orderData = inflate(
        base64Decode(xpathString('//ebics:body/ebics:DataTransfer/ebics:OrderData/text()', hiaDoc)!),
      ).toString('utf8');
      const authCert = parseXml(orderData)
        .getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')
        .item(0)!
        .textContent!.trim();
      return extractPublicKeyFromCertBase64(authCert);
    }

    it('verifies the HPB authentication signature with the key sent in HIA', () => {
      expect(verifyAuthSignature(parseXml(fixture('hpb-request.xml')), authPublicKeyFromHia())).toBe(true);
    });

    it('rejects the HPB request when authenticated content is modified', () => {
      const tampered = fixture('hpb-request.xml').replace('<AdminOrderType>HPB</AdminOrderType>', '<AdminOrderType>HKD</AdminOrderType>');
      expect(verifyAuthSignature(parseXml(tampered), authPublicKeyFromHia())).toBe(false);
    });
  });

  describe('extractPublicKeyFromCertPem', () => {
    it('should extract public key from cert', () => {
      const cert = makeCert(keyPair.privateKey, keyPair.publicKey);
      const pubKey = extractPublicKeyFromCertPem(cert);
      expect(pubKey).toContain('-----BEGIN PUBLIC KEY-----');
    });
  });

  describe('extractPublicKeyFromCertBase64', () => {
    it('should work with base64-encoded cert', () => {
      const cert = makeCert(keyPair.privateKey, keyPair.publicKey);
      const b64 = cert.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '').replace(/\s/g, '');
      const pubKey = extractPublicKeyFromCertBase64(b64);
      expect(pubKey).toContain('-----BEGIN PUBLIC KEY-----');
    });
  });
});
