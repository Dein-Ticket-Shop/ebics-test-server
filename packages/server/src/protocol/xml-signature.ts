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
    canonicalized += canonicalizeSubtree(n);
  }

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

  // Verify signature: canonicalize SignedInfo (same inclusive C14N of the in-document subtree), verify with RSA-SHA256.
  const signedInfoC14n = canonicalizeSubtree(signedInfo);

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

/**
 * Inclusive Canonical XML 1.0 (REC-xml-c14n-20010315) of an element and its subtree, as EBICS uses it
 * for the AuthSignature reference `#xpointer(//*[@authenticate='true'])` and for SignedInfo.
 *
 * A same-document reference's node-set includes the namespace nodes of the selected elements
 * (XMLDSig 1.1 §4.4.3.3), and every element carries namespace nodes for the declarations it inherits
 * from its ancestors (C14N §2.1). The apex has no output ancestor, so all of them are rendered there
 * (C14N §2.3), e.g. `<header xmlns="urn:org:ebics:H005" xmlns:ds="…" xmlns:xsi="…" authenticate="true">`
 * when the request root declares `ds` and `xsi`. This is byte-identical to Apache Santuario's
 * `Canonicalizer.canonicalizeSubtree`, which real bank servers use.
 *
 * xml-crypto's C14nCanonicalization only renders prefixes visibly used inside the subtree, so the
 * inherited declarations are passed in explicitly.
 */
export function canonicalizeSubtree(element: any): string {
  const declaredOnElement = new Map<string, string>();
  forEachNamespaceDeclaration(element, (prefix, namespaceURI) => declaredOnElement.set(prefix, namespaceURI));

  let inheritedDefaultNs: string | undefined;
  const inheritedPrefixed = new Map<string, string>();
  for (let ancestor = element.parentNode; ancestor && ancestor.nodeType === 1; ancestor = ancestor.parentNode) {
    forEachNamespaceDeclaration(ancestor, (prefix, namespaceURI) => {
      if (declaredOnElement.has(prefix)) return;
      if (prefix === '') {
        inheritedDefaultNs ??= namespaceURI;
      } else if (!inheritedPrefixed.has(prefix)) {
        inheritedPrefixed.set(prefix, namespaceURI);
      }
    });
  }
  const ancestorNamespaces = [...inheritedPrefixed].map(([prefix, namespaceURI]) => ({ prefix, namespaceURI }));

  if (!element.prefix) {
    // xml-crypto renders the unprefixed apex's own default namespace itself
    return c14n.process(element, { ancestorNamespaces });
  }

  // xml-crypto never renders the default namespace on a prefixed apex (neither its own declaration nor an
  // inherited one). A non-empty default namespace is in scope, so render it; it sorts first (C14N §2.2).
  const defaultNs = declaredOnElement.get('') ?? inheritedDefaultNs ?? '';
  const canonical = c14n.process(element, { ancestorNamespaces, defaultNs });
  if (!defaultNs) return canonical;
  const start = `<${element.nodeName}`;
  return `${start} xmlns="${escapeC14nAttributeValue(defaultNs)}"${canonical.slice(start.length)}`;
}

function forEachNamespaceDeclaration(element: any, callback: (prefix: string, namespaceURI: string) => void) {
  const attributes = element.attributes;
  if (!attributes) return;
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes.item(i);
    if (attr.name === 'xmlns') callback('', attr.value);
    else if (attr.prefix === 'xmlns') callback(attr.localName, attr.value);
  }
}

function escapeC14nAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

export function extractPublicKeyFromCertPem(certPem: string): string {
  const cert = forge.pki.certificateFromPem(certPem);
  return forge.pki.publicKeyToPem(cert.publicKey as forge.pki.rsa.PublicKey);
}

export function extractPublicKeyFromCertBase64(certBase64: string): string {
  const pem = `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`;
  return extractPublicKeyFromCertPem(pem);
}
