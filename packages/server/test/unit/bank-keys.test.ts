import { describe, it, expect } from 'vitest';
import { generateBankKeys, rotateBankKeys, bankCertificateDigest, bankPublicKeyDigest } from '../../src/bank/bank-keys.js';
import { createHash } from 'node:crypto';
import { X509Certificate } from 'node:crypto';
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

  describe('bankPublicKeyDigest', () => {
    it('hashes "exponent modulus" in lowercase hex without leading zeros', () => {
      const publicKey = forge.pki.certificateFromPem(keys.authenticationCertificate).publicKey as forge.pki.rsa.PublicKey;
      const expected = createHash('sha256')
        .update(`${publicKey.e.toString(16)} ${publicKey.n.toString(16)}`)
        .digest('hex');
      expect(bankPublicKeyDigest(keys.authenticationCertificate)).toBe(expected);
    });
  });

  describe('rotateBankKeys', () => {
    const config = { hostId: 'TESTBANK', bankKeys: keys };

    it('keeps the digests of the old certificates', () => {
      const rotated = rotateBankKeys(config);
      expect(rotated.retiredBankKeyDigests).toEqual([
        bankCertificateDigest(keys.authenticationCertificate),
        bankCertificateDigest(keys.encryptionCertificate),
      ]);
      expect(rotated.bankKeys.authenticationCertificate).not.toBe(keys.authenticationCertificate);
    });

    it('issues self-signed certificates by default', () => {
      const rotated = rotateBankKeys(config).bankKeys;
      const auth = new X509Certificate(rotated.authenticationCertificate);
      expect(auth.verify(auth.publicKey)).toBe(true);
      expect(auth.verify(new X509Certificate(keys.authenticationCertificate).publicKey)).toBe(false);
    });

    it('signs each new certificate with the previous key of the same type when asked', () => {
      const rotated = rotateBankKeys(config, { signWithPreviousKeys: true }).bankKeys;
      const oldAuth = new X509Certificate(keys.authenticationCertificate);
      const oldEnc = new X509Certificate(keys.encryptionCertificate);
      const auth = new X509Certificate(rotated.authenticationCertificate);
      const enc = new X509Certificate(rotated.encryptionCertificate);

      expect(auth.verify(oldAuth.publicKey)).toBe(true);
      expect(enc.verify(oldEnc.publicKey)).toBe(true);
      expect(auth.verify(auth.publicKey)).toBe(false);
      expect(auth.issuer).toBe(oldAuth.subject);
      expect(new Date(auth.validFrom).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
