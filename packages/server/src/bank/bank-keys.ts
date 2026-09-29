import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import type { BankKeys, HostConfig } from '../store/types.js';

/** SHA-256 over the DER certificate, base64: the value clients send in BankPubKeyDigests */
export function bankCertificateDigest(certificatePem: string): string {
  const der = Buffer.from(certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, ''), 'base64');
  return createHash('sha256').update(der).digest('base64');
}

/**
 * SHA-256 over the public key (hex): lowercase hex exponent and modulus without leading zeros, separated by a space.
 * Bank letters list it as X002/E002 next to the certificate hash ("Zert"); it stays the same when a certificate is
 * renewed for the same key pair.
 */
export function bankPublicKeyDigest(certificatePem: string): string {
  const jwk = new X509Certificate(certificatePem).publicKey.export({ format: 'jwk' });
  const hex = (value: string) => Buffer.from(value, 'base64url').toString('hex').replace(/^0+/, '');
  return createHash('sha256').update(`${hex(jwk.e!)} ${hex(jwk.n!)}`).digest('hex');
}

/**
 * Bank key change: new authentication and encryption keys for the host, self-signed or, with signWithPreviousKeys,
 * signed by the old keys. The digests of the old certificates are kept, so requests that still name them get
 * EBICS_BANK_PUBKEY_UPDATE_REQUIRED until the client runs HPB again.
 */
export function rotateBankKeys(config: HostConfig, options: { signWithPreviousKeys?: boolean } = {}): HostConfig {
  return {
    hostId: config.hostId,
    bankKeys: generateBankKeys(config.hostId, options.signWithPreviousKeys ? config.bankKeys : undefined),
    retiredBankKeyDigests: [
      ...(config.retiredBankKeyDigests ?? []),
      bankCertificateDigest(config.bankKeys.authenticationCertificate),
      bankCertificateDigest(config.bankKeys.encryptionCertificate),
    ],
  };
}

/**
 * New bank keys with self-signed certificates, or, with `issuers`, certificates signed by the previous bank keys
 * (EBICS 3.0.2 chapter 4.6.2: Z2 signed by Z1), so clients can adopt them without a manual check.
 */
export function generateBankKeys(hostId: string, issuers?: BankKeys): BankKeys {
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

  const authCert = generateCert(
    authKeyPair.privateKey,
    authKeyPair.publicKey,
    `CN=${hostId} Authentication Key, O=EBICS Test Server`,
    issuers && { privateKeyPem: issuers.authenticationPrivateKey, certificatePem: issuers.authenticationCertificate },
  );

  const encCert = generateCert(
    encKeyPair.privateKey,
    encKeyPair.publicKey,
    `CN=${hostId} Encryption Key, O=EBICS Test Server`,
    issuers && { privateKeyPem: issuers.encryptionPrivateKey, certificatePem: issuers.encryptionCertificate },
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

function generateCert(
  privateKeyPem: string,
  publicKeyPem: string,
  subject: string,
  issuer?: { privateKeyPem: string; certificatePem: string },
): string {
  const privateKey = forge.pki.privateKeyFromPem(issuer?.privateKeyPem ?? privateKeyPem);
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = issuer ? randomBytes(8).toString('hex').replace(/^[89a-f]/, '0') : '01';

  const now = new Date();
  // A rotated certificate is used at once; a minute back tolerates clients whose clock is slightly behind
  cert.validity.notBefore = issuer ? new Date(now.getTime() - 60_000) : now;
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 10);
  cert.validity.notAfter = expires;

  const attrs = parseSubject(subject);
  cert.setSubject(attrs);
  cert.setIssuer(issuer ? forge.pki.certificateFromPem(issuer.certificatePem).subject.attributes : attrs);

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
