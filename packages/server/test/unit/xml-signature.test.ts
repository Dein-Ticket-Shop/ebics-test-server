import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createHash, createSign } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { C14nCanonicalization } from 'xml-crypto';
import { verifyAuthSignature, extractPublicKeyFromCertPem, extractPublicKeyFromCertBase64 } from '../../src/protocol/xml-signature.js';
import { parseXml } from '../../src/protocol/xml-parser.js';
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
  const c14n = new C14nCanonicalization();
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
  for (const n of authNodes) canonicalized += c14n.process(n, {});

  const digest = createHash('sha256').update(canonicalized).digest('base64');
  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#xpointer(//*[@authenticate='true'])"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

  const signedInfoDoc = new DOMParser().parseFromString(signedInfoXml, 'text/xml');
  const signedInfoC14n = c14n.process(signedInfoDoc.documentElement as unknown as Node, {});

  const signer = createSign('RSA-SHA256');
  signer.update(signedInfoC14n);
  const signatureValue = signer.sign(privateKeyPem, 'base64');

  const authSig = `<AuthSignature xmlns="urn:org:ebics:H005">${signedInfoXml}<ds:SignatureValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signatureValue}</ds:SignatureValue></AuthSignature>`;
  return xml.replace('<AuthSignature/>', authSig);
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
