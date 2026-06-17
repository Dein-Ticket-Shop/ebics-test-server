import { deflate, base64Encode, sha256Digest, generateTransactionKey, aesEncrypt, rsaWrapKey } from './crypto.js';

const SEGMENT_SIZE = 1024 * 1024; // 1 MB

export interface PreparedDownload {
  transactionKey: Buffer;
  wrappedTransactionKey: string;
  segments: string[];
  numSegments: number;
  encKeyDigest: string;
}

export function prepareDownload(
  orderData: string,
  subscriberEncPublicKeyPem: string,
  bankEncCertDer: Buffer,
): PreparedDownload {
  const compressed = deflate(Buffer.from(orderData, 'utf8'));
  const transactionKey = generateTransactionKey();
  const encrypted = aesEncrypt(compressed, transactionKey);

  const segments: string[] = [];
  for (let offset = 0; offset < encrypted.length; offset += SEGMENT_SIZE) {
    segments.push(base64Encode(encrypted.subarray(offset, offset + SEGMENT_SIZE)));
  }
  if (segments.length === 0) {
    segments.push(base64Encode(Buffer.alloc(0)));
  }

  const wrappedKey = rsaWrapKey(transactionKey, subscriberEncPublicKeyPem);
  const encKeyDigest = base64Encode(sha256Digest(bankEncCertDer));

  return {
    transactionKey,
    wrappedTransactionKey: base64Encode(wrappedKey),
    segments,
    numSegments: segments.length,
    encKeyDigest,
  };
}
