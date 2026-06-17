import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { prepareDownload } from '../../src/protocol/download-pipeline.js';
import { aesDecrypt, rsaUnwrapKey, base64Decode, inflate } from '../../src/protocol/crypto.js';

describe('download-pipeline', () => {
  let encPublicKey: string;
  let encPrivateKey: string;
  const bankEncCertDer = Buffer.from('fake-bank-enc-cert-der-data');

  beforeAll(() => {
    const kp = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    encPublicKey = kp.publicKey;
    encPrivateKey = kp.privateKey;
  });

  it('should return all required fields', () => {
    const result = prepareDownload('test data', encPublicKey, bankEncCertDer);
    expect(result.transactionKey).toBeInstanceOf(Buffer);
    expect(result.transactionKey.length).toBe(16);
    expect(result.wrappedTransactionKey).toBeTruthy();
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.numSegments).toBe(result.segments.length);
    expect(result.encKeyDigest).toBeTruthy();
  });

  it('should produce single segment for small data', () => {
    const result = prepareDownload('small', encPublicKey, bankEncCertDer);
    expect(result.numSegments).toBe(1);
  });

  it('should produce multiple segments for large data', () => {
    const largeData = Array.from({ length: 2_000_000 }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join('');
    const result = prepareDownload(largeData, encPublicKey, bankEncCertDer);
    expect(result.numSegments).toBeGreaterThan(1);
  });

  it('should allow full round-trip decryption', () => {
    const original = '<HPDResponseOrderData>bank params here</HPDResponseOrderData>';
    const result = prepareDownload(original, encPublicKey, bankEncCertDer);

    const wrappedKey = base64Decode(result.wrappedTransactionKey);
    const transactionKey = rsaUnwrapKey(wrappedKey, encPrivateKey);
    expect(transactionKey).toEqual(result.transactionKey);

    const encryptedParts = result.segments.map((s) => base64Decode(s));
    const fullEncrypted = Buffer.concat(encryptedParts);
    const decrypted = aesDecrypt(fullEncrypted, transactionKey);
    const decompressed = inflate(decrypted).toString('utf8');
    expect(decompressed).toBe(original);
  });

  it('should produce consistent encKeyDigest for same cert', () => {
    const r1 = prepareDownload('a', encPublicKey, bankEncCertDer);
    const r2 = prepareDownload('b', encPublicKey, bankEncCertDer);
    expect(r1.encKeyDigest).toBe(r2.encKeyDigest);
  });

  it('should produce different wrapped keys each call', () => {
    const r1 = prepareDownload('data', encPublicKey, bankEncCertDer);
    const r2 = prepareDownload('data', encPublicKey, bankEncCertDer);
    expect(r1.wrappedTransactionKey).not.toBe(r2.wrappedTransactionKey);
  });

  it('should handle empty order data', () => {
    const result = prepareDownload('', encPublicKey, bankEncCertDer);
    expect(result.numSegments).toBeGreaterThanOrEqual(1);

    const wrappedKey = base64Decode(result.wrappedTransactionKey);
    const transactionKey = rsaUnwrapKey(wrappedKey, encPrivateKey);
    const encryptedParts = result.segments.map((s) => base64Decode(s));
    const fullEncrypted = Buffer.concat(encryptedParts);
    const decrypted = aesDecrypt(fullEncrypted, transactionKey);
    const decompressed = inflate(decrypted).toString('utf8');
    expect(decompressed).toBe('');
  });

  it('should produce base64-valid segments', () => {
    const result = prepareDownload('test', encPublicKey, bankEncCertDer);
    for (const seg of result.segments) {
      expect(seg).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });
});
