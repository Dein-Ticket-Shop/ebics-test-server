import { base64Decode, rsaUnwrapKey, aesDecrypt, inflate } from './crypto.js';

export function decryptUpload(
  segments: string[],
  wrappedTransactionKey: string,
  bankEncPrivateKeyPem: string,
): string {
  const txKey = rsaUnwrapKey(base64Decode(wrappedTransactionKey), bankEncPrivateKeyPem);
  const encrypted = Buffer.concat(segments.map((s) => base64Decode(s)));
  const decrypted = aesDecrypt(encrypted, txKey);
  return inflate(decrypted).toString('utf8');
}
