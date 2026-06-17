import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';
import type { BankKeys } from '../store/types.js';

export function generateBankKeys(hostId: string): BankKeys {
  const authKeyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const encKeyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const authCert = generateSelfSignedCert(
    authKeyPair.privateKey,
    authKeyPair.publicKey,
    `CN=${hostId} Authentication Key, O=EBICS Test Server`,
  );

  const encCert = generateSelfSignedCert(
    encKeyPair.privateKey,
    encKeyPair.publicKey,
    `CN=${hostId} Encryption Key, O=EBICS Test Server`,
  );

  return {
    authenticationPrivateKey: authKeyPair.privateKey,
    authenticationCertificate: authCert,
    authenticationVersion: 'X002',
    encryptionPrivateKey: encKeyPair.privateKey,
    encryptionCertificate: encCert,
    encryptionVersion: 'E002',
  };
}

function generateSelfSignedCert(
  privateKeyPem: string,
  publicKeyPem: string,
  subject: string,
): string {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01';

  const now = new Date();
  cert.validity.notBefore = now;
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 10);
  cert.validity.notAfter = expires;

  const attrs = parseSubject(subject);
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.sign(privateKey, forge.md.sha256.create());

  return forge.pki.certificateToPem(cert);
}

function parseSubject(dn: string): forge.pki.CertificateField[] {
  return dn.split(',').map((part) => {
    const [key, value] = part.trim().split('=');
    const nameMap: Record<string, string> = {
      CN: 'commonName',
      O: 'organizationName',
      OU: 'organizationalUnitName',
      C: 'countryName',
    };
    return { name: nameMap[key] ?? key, value: value ?? '' };
  });
}
