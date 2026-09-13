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

/**
 * E002 (EBICS 3.0.2 chapter 11.3.2.1): AES-128-CBC with ICV 0 and padding per ANSI X9.23 / ISO 10126-2. There are
 * always 1 to 16 padding bytes: zeros and a last byte with the padding length, so block-aligned data gets a full block.
 */
export function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const padLength = 16 - (data.length % 16);
  const padding = Buffer.alloc(padLength, 0);
  padding[padLength - 1] = padLength;
  return Buffer.concat([cipher.update(Buffer.concat([data, padding])), cipher.final()]);
}

/**
 * Decrypts E002 data and removes the ANSI X9.23 / ISO 10126-2 padding: the last byte is the padding length, which
 * also holds for PKCS#7 padding. Data whose last byte is no valid padding length (0 or above 16) is returned
 * unchanged; order data is deflate-compressed and its stream delimits itself.
 */
export function aesDecrypt(data: Buffer, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  const padLength = decrypted.length > 0 ? decrypted[decrypted.length - 1]! : 0;
  return padLength >= 1 && padLength <= 16 ? decrypted.subarray(0, decrypted.length - padLength) : decrypted;
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
