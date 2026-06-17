import { createHash, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export function deflate(data: Buffer): Buffer {
  return deflateSync(data);
}

export function inflate(data: Buffer): Buffer {
  return inflateSync(data);
}

export function sha256Digest(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function base64Encode(data: Buffer): string {
  return data.toString('base64');
}

export function base64Decode(data: string): Buffer {
  return Buffer.from(data, 'base64');
}

export function extractCertificateFromPem(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}

export function generateTransactionKey(): Buffer {
  return randomBytes(16);
}

export function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function rsaWrapKey(transactionKey: Buffer, recipientPublicKeyPem: string): Buffer {
  return publicEncrypt(
    { key: recipientPublicKeyPem, padding: constants.RSA_PKCS1_PADDING },
    transactionKey,
  );
}

export function rsaUnwrapKey(wrappedKey: Buffer, privateKeyPem: string): Buffer {
  return privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    wrappedKey,
  );
}

export function generateTransactionId(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}
