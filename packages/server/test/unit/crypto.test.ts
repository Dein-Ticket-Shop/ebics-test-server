import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { deflate, inflate, base64Encode, base64Decode, sha256Digest, extractCertificateFromPem, generateTransactionKey, aesEncrypt, aesDecrypt, rsaWrapKey, rsaUnwrapKey, generateTransactionId } from '../../src/protocol/crypto.js';

describe('crypto', () => {
  describe('deflate / inflate', () => {
    it('should round-trip data correctly', () => {
      const original = Buffer.from('Hello EBICS World! This is test data.');
      const compressed = deflate(original);
      const decompressed = inflate(compressed);
      expect(decompressed).toEqual(original);
    });

    it('should handle empty buffer', () => {
      const original = Buffer.alloc(0);
      const compressed = deflate(original);
      const decompressed = inflate(compressed);
      expect(decompressed).toEqual(original);
    });

    it('should handle large payload', () => {
      const original = Buffer.alloc(100_000, 'A');
      const compressed = deflate(original);
      expect(compressed.length).toBeLessThan(original.length);
      const decompressed = inflate(compressed);
      expect(decompressed).toEqual(original);
    });

    it('should compress XML-like content efficiently', () => {
      const xml = '<root>' + '<item>value</item>'.repeat(1000) + '</root>';
      const original = Buffer.from(xml);
      const compressed = deflate(original);
      expect(compressed.length).toBeLessThan(original.length / 10);
    });
  });

  describe('base64Encode / base64Decode', () => {
    it('should round-trip data correctly', () => {
      const original = Buffer.from('binary data \x00\x01\x02\xff');
      const encoded = base64Encode(original);
      const decoded = base64Decode(encoded);
      expect(decoded).toEqual(original);
    });

    it('should produce valid base64 string', () => {
      const data = Buffer.from('test');
      const encoded = base64Encode(data);
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('should decode known base64 value', () => {
      const decoded = base64Decode('SGVsbG8=');
      expect(decoded.toString('utf8')).toBe('Hello');
    });
  });

  describe('sha256Digest', () => {
    it('should produce correct hash for known input', () => {
      // SHA-256 of empty string
      const hash = sha256Digest(Buffer.alloc(0));
      expect(hash.toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should produce 32-byte output', () => {
      const hash = sha256Digest(Buffer.from('test'));
      expect(hash.length).toBe(32);
    });

    it('should produce different hashes for different inputs', () => {
      const h1 = sha256Digest(Buffer.from('a'));
      const h2 = sha256Digest(Buffer.from('b'));
      expect(h1).not.toEqual(h2);
    });
  });

  describe('extractCertificateFromPem', () => {
    it('should strip PEM headers and whitespace', () => {
      const pem = '-----BEGIN CERTIFICATE-----\nABCD\nEFGH\n-----END CERTIFICATE-----\n';
      expect(extractCertificateFromPem(pem)).toBe('ABCDEFGH');
    });

    it('should handle multiple newlines and spaces', () => {
      const pem = '-----BEGIN CERTIFICATE-----\n  AB CD \n  EF  \n-----END CERTIFICATE-----';
      expect(extractCertificateFromPem(pem)).toBe('ABCDEF');
    });
  });

  describe('generateTransactionKey', () => {
    it('should return 16-byte buffer', () => {
      const key = generateTransactionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(16);
    });

    it('should generate unique keys', () => {
      const k1 = generateTransactionKey();
      const k2 = generateTransactionKey();
      expect(k1).not.toEqual(k2);
    });
  });

  describe('aesEncrypt / aesDecrypt', () => {
    it('should round-trip data correctly', () => {
      const key = generateTransactionKey();
      const data = Buffer.from('EBICS order data payload');
      const encrypted = aesEncrypt(data, key);
      const decrypted = aesDecrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should produce different ciphertext than plaintext', () => {
      const key = generateTransactionKey();
      const data = Buffer.from('test data');
      const encrypted = aesEncrypt(data, key);
      expect(encrypted).not.toEqual(data);
    });

    it('should produce padded output (multiple of 16 bytes)', () => {
      const key = generateTransactionKey();
      const data = Buffer.from('short');
      const encrypted = aesEncrypt(data, key);
      expect(encrypted.length % 16).toBe(0);
    });

    it('should handle empty buffer', () => {
      const key = generateTransactionKey();
      const data = Buffer.alloc(0);
      const encrypted = aesEncrypt(data, key);
      const decrypted = aesDecrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should handle large data', () => {
      const key = generateTransactionKey();
      const data = Buffer.alloc(1_000_000, 0x42);
      const encrypted = aesEncrypt(data, key);
      const decrypted = aesDecrypt(encrypted, key);
      expect(decrypted).toEqual(data);
    });

    it('should fail to decrypt with wrong key', () => {
      const key1 = generateTransactionKey();
      const key2 = generateTransactionKey();
      const data = Buffer.from('secret');
      const encrypted = aesEncrypt(data, key1);
      expect(() => aesDecrypt(encrypted, key2)).toThrow();
    });
  });

  describe('rsaWrapKey / rsaUnwrapKey', () => {
    it('should round-trip transaction key', () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const txKey = generateTransactionKey();
      const wrapped = rsaWrapKey(txKey, publicKey);
      const unwrapped = rsaUnwrapKey(wrapped, privateKey);
      expect(unwrapped).toEqual(txKey);
    });

    it('should produce 256-byte output for 2048-bit key', () => {
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const txKey = generateTransactionKey();
      const wrapped = rsaWrapKey(txKey, publicKey);
      expect(wrapped.length).toBe(256);
    });

    it('should not recover original key with wrong private key', () => {
      const kp1 = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const kp2 = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const txKey = generateTransactionKey();
      const wrapped = rsaWrapKey(txKey, kp1.publicKey);
      try {
        const unwrapped = rsaUnwrapKey(wrapped, kp2.privateKey);
        expect(unwrapped).not.toEqual(txKey);
      } catch {
        // throws on wrong key — expected
      }
    });
  });

  describe('generateTransactionId', () => {
    it('should return 32-character uppercase hex string', () => {
      const id = generateTransactionId();
      expect(id).toMatch(/^[0-9A-F]{32}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTransactionId()));
      expect(ids.size).toBe(100);
    });
  });
});
