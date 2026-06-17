import { describe, it, expect } from 'vitest';
import { generateBankKeys } from '../../src/bank/bank-keys.js';
import { createPublicKey } from 'node:crypto';
import forge from 'node-forge';

describe('bank-keys', () => {
  const keys = generateBankKeys('TESTBANK');

  it('should return all required fields', () => {
    expect(keys.authenticationPrivateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keys.authenticationCertificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(keys.authenticationVersion).toBe('X002');
    expect(keys.encryptionPrivateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(keys.encryptionCertificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(keys.encryptionVersion).toBe('E002');
  });

  it('should generate valid RSA 2048-bit auth key', () => {
    const pubKey = createPublicKey(keys.authenticationPrivateKey);
    expect(pubKey.asymmetricKeyType).toBe('rsa');
    expect(pubKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('should generate valid RSA 2048-bit enc key', () => {
    const pubKey = createPublicKey(keys.encryptionPrivateKey);
    expect(pubKey.asymmetricKeyType).toBe('rsa');
    expect(pubKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('should generate valid X.509 certificates', () => {
    const authCert = forge.pki.certificateFromPem(keys.authenticationCertificate);
    expect(authCert.publicKey).toBeTruthy();
    expect(authCert.validity.notAfter.getTime()).toBeGreaterThan(Date.now());

    const encCert = forge.pki.certificateFromPem(keys.encryptionCertificate);
    expect(encCert.publicKey).toBeTruthy();
  });

  it('should generate different key pairs for auth and enc', () => {
    expect(keys.authenticationPrivateKey).not.toBe(keys.encryptionPrivateKey);
    expect(keys.authenticationCertificate).not.toBe(keys.encryptionCertificate);
  });

  it('should include hostId in cert subject', () => {
    const cert = forge.pki.certificateFromPem(keys.authenticationCertificate);
    const cn = cert.subject.getField('CN');
    expect(cn.value).toContain('TESTBANK');
  });
});
