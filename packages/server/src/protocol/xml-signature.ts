import { C14nCanonicalization } from 'xml-crypto';
import { createVerify, createHash } from 'node:crypto';
import { XMLSerializer } from '@xmldom/xmldom';
import type { XmlDocument } from './xml-parser.js';
import forge from 'node-forge';
import { logger } from '../logger.js';

const c14n = new C14nCanonicalization();

export function verifyAuthSignature(doc: XmlDocument, publicKeyPem: string): boolean {
  // Find AuthSignature element (in H005 namespace)
  const authSigElements = doc.getElementsByTagNameNS('urn:org:ebics:H005', 'AuthSignature');
  if (authSigElements.length === 0) return false;
  const authSig = authSigElements.item(0)!;

  // Extract SignedInfo and SignatureValue from ds namespace
  const signedInfoElements = authSig.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignedInfo');
  if (signedInfoElements.length === 0) return false;
  const signedInfo = signedInfoElements.item(0)!;

  const sigValueElements = authSig.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignatureValue');
  if (sigValueElements.length === 0) return false;
  const signatureValue = sigValueElements.item(0)!.textContent?.trim();
  if (!signatureValue) return false;

  // Extract digest from SignedInfo
  const digestValueElements = signedInfo.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'DigestValue');
  if (digestValueElements.length === 0) return false;
  const expectedDigest = digestValueElements.item(0)!.textContent?.trim();
  if (!expectedDigest) return false;

  // Verify digest: canonicalize all elements with authenticate="true" and compute SHA-256
  const authNodes: any[] = [];
  function collectAuth(node: any) {
    if (node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('authenticate') === 'true') {
        authNodes.push(node);
      }
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          collectAuth(node.childNodes.item(i));
        }
      }
    }
  }
  collectAuth(doc.documentElement);

  let canonicalized = '';
  for (const n of authNodes) {
    canonicalized += c14n.process(n, {});
  }

  // Inclusive C14n (REC-xml-c14n-20010315) re-declares ALL in-scope namespaces at the
  // detached apex, even ones not visibly used inside the subtree (e.g. `ds`, declared on
  // the request root). xml-crypto's C14nCanonicalization renders the in-scope default
  // namespace but buggily omits in-scope prefix namespaces, so we re-inject `xmlns:ds`
  // to reproduce the spec-correct canonical form. Verified byte-identical against real
  // clients (node-ebics-client 6.0.0, @kage0x3b/ebics-client).
  canonicalized = canonicalized.replace(
    /xmlns="urn:org:ebics:H005"/g,
    'xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
  );

  const computedDigest = createHash('sha256').update(canonicalized).digest('base64');
  if (computedDigest !== expectedDigest) {
    logger.debug({
      evt: 'authsig',
      reason: 'digest_mismatch',
      expectedDigest,
      computedDigest,
      authNodes: authNodes.length,
      canonicalized: canonicalized.slice(0, 500),
    }, 'AuthSignature digest mismatch');
    return false;
  }

  // Verify signature: canonicalize SignedInfo, verify with RSA-SHA256. Same in-scope
  // namespace fixup as the digest: the default H005 namespace is in scope from the request
  // root, so inclusive C14n re-declares it on the SignedInfo apex. xml-crypto omits it, so
  // we inject it alongside the `ds` prefix it already renders.
  const signedInfoC14n = c14n
    .process(signedInfo as unknown as Node, {})
    .replace(
      'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
      'xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    );

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signedInfoC14n);
  const sigResult = verifier.verify(publicKeyPem, signatureValue, 'base64');
  if (!sigResult) {
    logger.debug({
      evt: 'authsig',
      reason: 'verify_failed',
      signedInfoC14n: signedInfoC14n.slice(0, 500),
    }, 'AuthSignature verification failed');
  }
  return sigResult;
}

export function extractPublicKeyFromCertPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  return forge.pki.publicKeyToPem(cert.publicKey as forge.pki.rsa.PublicKey);
}

export function extractPublicKeyFromCertBase64(certBase64: string): string {
  const pem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`;
  return extractPublicKeyFromCertPem(pem);
}
