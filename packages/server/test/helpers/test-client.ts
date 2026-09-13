import { generateKeyPairSync, createHash, createSign, privateDecrypt, createDecipheriv, createCipheriv, publicEncrypt, randomBytes, constants } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import forge from 'node-forge';
import { DOMParser } from '@xmldom/xmldom';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { canonicalizeSubtree } from '../../src/protocol/xml-signature.js';

export interface TestClientKeys {
  signatureKeyPair: { publicKey: string; privateKey: string };
  authKeyPair: { publicKey: string; privateKey: string };
  encKeyPair: { publicKey: string; privateKey: string };
  signatureCert: string;
  authCert: string;
  encCert: string;
}

export function generateTestClientKeys(): TestClientKeys {
  const signatureKeyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

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

  return {
    signatureKeyPair,
    authKeyPair,
    encKeyPair,
    signatureCert: generateSelfSignedCert(signatureKeyPair.privateKey, signatureKeyPair.publicKey, 'CN=Test Signature'),
    authCert: generateSelfSignedCert(authKeyPair.privateKey, authKeyPair.publicKey, 'CN=Test Auth'),
    encCert: generateSelfSignedCert(encKeyPair.privateKey, encKeyPair.publicKey, 'CN=Test Encryption'),
  };
}

function generateSelfSignedCert(privateKeyPem: string, publicKeyPem: string, subject: string): string {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01';
  const now = new Date();
  cert.validity.notBefore = now;
  const expires = new Date(now);
  expires.setFullYear(expires.getFullYear() + 1);
  cert.validity.notAfter = expires;
  const attrs = [{ name: 'commonName', value: subject.replace('CN=', '') }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function certToBase64(certPem: string): string {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}

export function buildIniRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
): string {
  const orderData = `<?xml version="1.0" encoding="UTF-8"?>
<SignaturePubKeyOrderData xmlns="http://www.ebics.org/S002"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <SignaturePubKeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${certToBase64(keys.signatureCert)}</ds:X509Certificate>
    </ds:X509Data>
    <SignatureVersion>A006</SignatureVersion>
  </SignaturePubKeyInfo>
  <PartnerID>${partnerId}</PartnerID>
  <UserID>${userId}</UserID>
</SignaturePubKeyOrderData>`;

  const compressed = deflateSync(Buffer.from(orderData, 'utf8'));
  const b64 = compressed.toString('base64');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ebicsUnsecuredRequest xmlns="urn:org:ebics:H005" Version="H005" Revision="1">
  <header authenticate="true">
    <static>
      <HostID>${hostId}</HostID>
      <PartnerID>${partnerId}</PartnerID>
      <UserID>${userId}</UserID>
      <OrderDetails>
        <AdminOrderType>INI</AdminOrderType>
      </OrderDetails>
      <SecurityMedium>0000</SecurityMedium>
    </static>
    <mutable/>
  </header>
  <body>
    <DataTransfer>
      <OrderData>${b64}</OrderData>
    </DataTransfer>
  </body>
</ebicsUnsecuredRequest>`;
}

export function buildHiaRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
): string {
  const orderData = `<?xml version="1.0" encoding="UTF-8"?>
<HIARequestOrderData xmlns="urn:org:ebics:H005"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <AuthenticationPubKeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${certToBase64(keys.authCert)}</ds:X509Certificate>
    </ds:X509Data>
    <AuthenticationVersion>X002</AuthenticationVersion>
  </AuthenticationPubKeyInfo>
  <EncryptionPubKeyInfo>
    <ds:X509Data>
      <ds:X509Certificate>${certToBase64(keys.encCert)}</ds:X509Certificate>
    </ds:X509Data>
    <EncryptionVersion>E002</EncryptionVersion>
  </EncryptionPubKeyInfo>
  <PartnerID>${partnerId}</PartnerID>
  <UserID>${userId}</UserID>
</HIARequestOrderData>`;

  const compressed = deflateSync(Buffer.from(orderData, 'utf8'));
  const b64 = compressed.toString('base64');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ebicsUnsecuredRequest xmlns="urn:org:ebics:H005" Version="H005" Revision="1">
  <header authenticate="true">
    <static>
      <HostID>${hostId}</HostID>
      <PartnerID>${partnerId}</PartnerID>
      <UserID>${userId}</UserID>
      <OrderDetails>
        <AdminOrderType>HIA</AdminOrderType>
      </OrderDetails>
      <SecurityMedium>0000</SecurityMedium>
    </static>
    <mutable/>
  </header>
  <body>
    <DataTransfer>
      <OrderData>${b64}</OrderData>
    </DataTransfer>
  </body>
</ebicsUnsecuredRequest>`;
}

export function buildHpbRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
): string {

  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');

  const timestamp = new Date().toISOString();

  // Build XML with AuthSignature placeholder
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsNoPubKeyDigestsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>HPB</AdminOrderType></OrderDetails><SecurityMedium>0000</SecurityMedium></static><mutable/></header><AuthSignature/><body/></ebicsNoPubKeyDigestsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export interface BankCerts {
  authCertPem: string;
  encCertPem: string;
}

function computeCertDigest(certPem: string): string {
  const der = Buffer.from(certToBase64(certPem), 'base64');
  return createHash('sha256').update(der).digest('base64');
}

function generateNonce(): string {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

function signEbicsRequest(xml: string, privateKey: string): string {
  // Digest: inclusive C14N 1.0 of every authenticate="true" subtree in its document context
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  const authNodes: any[] = [];
  function collectAuth(node: any) {
    if (node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('authenticate') === 'true') {
        authNodes.push(node);
      }
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          collectAuth(node.childNodes.item(i));
        }
      }
    }
  }
  collectAuth(doc.documentElement);

  let canonicalized = '';
  for (const n of authNodes) {
    canonicalized += canonicalizeSubtree(n);
  }

  const digest = createHash('sha256').update(canonicalized).digest('base64');

  const signedInfoXml = `<ds:SignedInfo><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#xpointer(//*[@authenticate='true'])"><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const withSignedInfo = xml.replace(
    '<AuthSignature/>',
    `<AuthSignature>${signedInfoXml}<ds:SignatureValue>__SIGNATURE__</ds:SignatureValue></AuthSignature>`,
  );

  // Signature: SignedInfo canonicalized in its document context (inherits the default and ds namespaces)
  const signedDoc = new DOMParser().parseFromString(withSignedInfo, 'text/xml');
  const signedInfo = signedDoc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'SignedInfo').item(0);

  const signer = createSign('RSA-SHA256');
  signer.update(canonicalizeSubtree(signedInfo));
  const signatureValue = signer.sign(privateKey, 'base64');

  return withSignedInfo.replace('__SIGNATURE__', signatureValue);
}

export function buildEbicsDownloadInitRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
  bankCerts: BankCerts,
  orderType: string,
  btdParams?: DownloadParams,
  standardParams?: { dateRange?: DateRange },
): string {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const authDigest = computeCertDigest(bankCerts.authCertPem);
  const encDigest = computeCertDigest(bankCerts.encCertPem);

  let orderParams: string;
  if (orderType === 'BTD' && btdParams) {
    // RestrictedServiceType order: ServiceName, Scope, ServiceOption, Container, MsgName; then DateRange
    const scope = btdParams.scope ? `<Scope>${btdParams.scope}</Scope>` : '';
    const option = btdParams.serviceOption ? `<ServiceOption>${btdParams.serviceOption}</ServiceOption>` : '';
    const container = btdParams.containerType ? `<Container containerType="${btdParams.containerType}"/>` : '';
    orderParams = `<BTDOrderParams xmlns="urn:org:ebics:H005"><Service><ServiceName>${btdParams.serviceName}</ServiceName>${scope}${option}${container}<MsgName>${btdParams.msgName}</MsgName></Service>${dateRangeXml(btdParams.dateRange)}</BTDOrderParams>`;
  } else if (standardParams?.dateRange) {
    orderParams = `<StandardOrderParams xmlns="urn:org:ebics:H005">${dateRangeXml(standardParams.dateRange)}</StandardOrderParams>`;
  } else {
    orderParams = `<StandardOrderParams xmlns="urn:org:ebics:H005"/>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>${orderType}</AdminOrderType>${orderParams}</OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0000</SecurityMedium></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body/></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export function buildEbicsTransferRequest(
  hostId: string,
  keys: TestClientKeys,
  transactionId: string,
  segmentNumber: number,
  lastSegment: boolean,
): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><TransactionID>${transactionId}</TransactionID></static><mutable><TransactionPhase>Transfer</TransactionPhase><SegmentNumber lastSegment="${lastSegment}">${segmentNumber}</SegmentNumber></mutable></header><AuthSignature/><body/></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export function buildEbicsReceiptRequest(
  hostId: string,
  keys: TestClientKeys,
  transactionId: string,
  receiptCode: 0 | 1 = 0,
): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><TransactionID>${transactionId}</TransactionID></static><mutable><TransactionPhase>Receipt</TransactionPhase></mutable></header><AuthSignature/><body><TransferReceipt authenticate="true"><ReceiptCode>${receiptCode}</ReceiptCode></TransferReceipt></body></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export function decryptDownloadResponse(responseXml: string, encPrivateKeyPem: string): { orderData: string; transactionId: string; numSegments: number } {
  const doc = parseXml(responseXml);

  const transactionId = xpathString('//ebics:TransactionID/text()', doc) ?? '';
  const numSegmentsStr = xpathString('//ebics:NumSegments/text()', doc);
  const numSegments = numSegmentsStr ? parseInt(numSegmentsStr, 10) : 1;
  const transactionKeyB64 = xpathString('//ebics:TransactionKey/text()', doc);
  const orderDataB64 = xpathString('//ebics:OrderData/text()', doc);

  if (!transactionKeyB64 || !orderDataB64) {
    throw new Error('Missing TransactionKey or OrderData in response');
  }

  const wrappedKey = Buffer.from(transactionKeyB64, 'base64');
  const transactionKey = privateDecrypt(
    { key: encPrivateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    wrappedKey,
  );

  const iv = Buffer.alloc(16, 0);
  const decipher = createDecipheriv('aes-128-cbc', transactionKey, iv);
  decipher.setAutoPadding(false); // EBICS E002: zero-padded, no PKCS#7
  const encrypted = Buffer.from(orderDataB64, 'base64');
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const orderData = inflateSync(decrypted).toString('utf8');

  return { orderData, transactionId, numSegments };
}

// Upload helpers

const UPLOAD_SEGMENT_SIZE = 1024 * 1024;

export interface EncryptedUpload {
  segments: string[];
  wrappedKey: string;
  numSegments: number;
  dataDigest: string;
  signatureDataB64: string;
}

export function encryptUploadContent(
  content: string,
  bankEncPubKeyPem: string,
  partnerId: string,
  userId: string,
): EncryptedUpload {
  const compressed = deflateSync(Buffer.from(content, 'utf8'));
  const txKey = randomBytes(16);
  const iv = Buffer.alloc(16, 0);

  const cipher = createCipheriv('aes-128-cbc', txKey, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);

  const segments: string[] = [];
  for (let offset = 0; offset < encrypted.length; offset += UPLOAD_SEGMENT_SIZE) {
    segments.push(encrypted.subarray(offset, offset + UPLOAD_SEGMENT_SIZE).toString('base64'));
  }
  if (segments.length === 0) segments.push(Buffer.alloc(0).toString('base64'));

  const wrappedKey = publicEncrypt(
    { key: bankEncPubKeyPem, padding: constants.RSA_PKCS1_PADDING },
    txKey,
  ).toString('base64');

  const dataDigest = createHash('sha256').update(compressed).digest('base64');

  // Build minimal UserSignatureData XML
  const sigXml = `<?xml version="1.0" encoding="UTF-8"?><UserSignatureData xmlns="http://www.ebics.org/S002"><OrderSignatureData><SignatureVersion>A006</SignatureVersion><SignatureValue>${randomBytes(32).toString('base64')}</SignatureValue><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID></OrderSignatureData></UserSignatureData>`;
  const sigCompressed = deflateSync(Buffer.from(sigXml, 'utf8'));
  const sigCipher = createCipheriv('aes-128-cbc', txKey, iv);
  const sigEncrypted = Buffer.concat([sigCipher.update(sigCompressed), sigCipher.final()]);
  const signatureDataB64 = sigEncrypted.toString('base64');

  return { segments, wrappedKey, numSegments: segments.length, dataDigest, signatureDataB64 };
}

export function buildEbicsUploadInitRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
  bankCerts: BankCerts,
  serviceName: string,
  msgName: string,
  enc: EncryptedUpload,
  options: UploadOptions = {},
): string {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const authDigest = computeCertDigest(bankCerts.authCertPem);
  const encDigest = computeCertDigest(bankCerts.encCertPem);

  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>BTU</AdminOrderType><BTUOrderParams xmlns="urn:org:ebics:H005"><Service><ServiceName>${serviceName}</ServiceName>${options.scope ? `<Scope>${options.scope}</Scope>` : ''}${options.serviceOption ? `<ServiceOption>${options.serviceOption}</ServiceOption>` : ''}<MsgName>${msgName}</MsgName></Service>${signatureFlagXml(options)}</BTUOrderParams></OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0000</SecurityMedium><NumSegments>${enc.numSegments}</NumSegments></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body><DataTransfer><DataEncryptionInfo authenticate="true"><EncryptionPubKeyDigest Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</EncryptionPubKeyDigest><TransactionKey>${enc.wrappedKey}</TransactionKey></DataEncryptionInfo><SignatureData authenticate="true">${enc.signatureDataB64}</SignatureData><DataDigest SignatureVersion="A006">${enc.dataDigest}</DataDigest></DataTransfer></body></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export function buildEbicsUploadTransferRequest(
  hostId: string,
  keys: TestClientKeys,
  transactionId: string,
  segmentNumber: number,
  lastSegment: boolean,
  orderData: string,
): string {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><TransactionID>${transactionId}</TransactionID></static><mutable><TransactionPhase>Transfer</TransactionPhase><SegmentNumber lastSegment="${lastSegment}">${segmentNumber}</SegmentNumber></mutable></header><AuthSignature/><body><DataTransfer><OrderData>${orderData}</OrderData></DataTransfer></body></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

export function buildEbicsKeyMgmtUploadInitRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
  bankCerts: BankCerts,
  orderType: string,
  enc: EncryptedUpload,
): string {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const authDigest = computeCertDigest(bankCerts.authCertPem);
  const encDigest = computeCertDigest(bankCerts.encCertPem);

  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>${orderType}</AdminOrderType><StandardOrderParams xmlns="urn:org:ebics:H005"/></OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0000</SecurityMedium><NumSegments>${enc.numSegments}</NumSegments></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body><DataTransfer><DataEncryptionInfo authenticate="true"><EncryptionPubKeyDigest Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</EncryptionPubKeyDigest><TransactionKey>${enc.wrappedKey}</TransactionKey></DataEncryptionInfo><SignatureData authenticate="true">${enc.signatureDataB64}</SignatureData><DataDigest SignatureVersion="A006">${enc.dataDigest}</DataDigest></DataTransfer></body></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

// Reports, containers and payment helpers

export interface DateRange {
  start: string;
  end: string;
}

export interface DownloadParams {
  serviceName: string;
  msgName: string;
  scope?: string;
  serviceOption?: string;
  containerType?: string;
  dateRange?: DateRange;
}

export interface UploadOptions {
  scope?: string;
  serviceOption?: string;
  /** BTUOrderParams/SignatureFlag/@requestEDS; implies the SignatureFlag */
  requestEds?: boolean;
  /** BTUOrderParams/SignatureFlag is sent; defaults to requestEds, so `{ signatureFlag: true }` alone sends it without requestEDS */
  signatureFlag?: boolean;
}

function signatureFlagXml(options: UploadOptions): string {
  if (options.requestEds) return '<SignatureFlag requestEDS="true"/>';
  return options.signatureFlag ? '<SignatureFlag/>' : '';
}

function dateRangeXml(range?: DateRange): string {
  return range ? `<DateRange><Start>${range.start}</Start><End>${range.end}</End></DateRange>` : '';
}

/** Like decryptDownloadResponse, but returns the raw order data bytes (e.g. a ZIP container) */
export function decryptDownloadResponseBytes(
  responseXml: string,
  encPrivateKeyPem: string,
): { data: Buffer; transactionId: string; numSegments: number } {
  const doc = parseXml(responseXml);
  const transactionId = xpathString('//ebics:TransactionID/text()', doc) ?? '';
  const numSegmentsStr = xpathString('//ebics:NumSegments/text()', doc);
  const transactionKeyB64 = xpathString('//ebics:TransactionKey/text()', doc);
  const orderDataB64 = xpathString('//ebics:OrderData/text()', doc);
  if (!transactionKeyB64 || !orderDataB64) {
    throw new Error('Missing TransactionKey or OrderData in response');
  }

  const transactionKey = privateDecrypt(
    { key: encPrivateKeyPem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(transactionKeyB64, 'base64'),
  );
  const decipher = createDecipheriv('aes-128-cbc', transactionKey, Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(orderDataB64, 'base64')), decipher.final()]);

  return {
    data: inflateSync(decrypted),
    transactionId,
    numSegments: numSegmentsStr ? parseInt(numSegmentsStr, 10) : 1,
  };
}

/** OrderID from an EBICS or key management response header, if any */
export function readOrderId(responseXml: string): string | undefined {
  return xpathString('//ebics:header/ebics:mutable/ebics:OrderID/text()', parseXml(responseXml));
}

/** Business return code (body/ReturnCode) of an EBICS response */
export function readBusinessReturnCode(responseXml: string): string | undefined {
  return xpathString('//ebics:body/ebics:ReturnCode/text()', parseXml(responseXml));
}

export interface Pain001Transaction {
  endToEndId: string;
  creditorName: string;
  creditorIban: string;
  /** decimal, e.g. "12.34" */
  amount: string;
  remittance?: string;
}

export interface Pain001Payment {
  pmtInfId: string;
  debtorName: string;
  debtorIban: string;
  transactions: Pain001Transaction[];
}

/** pain.001.001.09 credit transfer (SEPA Instant unless `instant: false`), one PmtInf per payment */
export function buildPain001Document(options: { msgId: string; payments: Pain001Payment[]; instant?: boolean }): string {
  const instant = options.instant ?? true;
  const allTx = options.payments.flatMap((p) => p.transactions);
  const sum = (txs: Pain001Transaction[]) => txs.reduce((total, tx) => total + parseFloat(tx.amount), 0).toFixed(2);

  const pmtInfs = options.payments
    .map(
      (payment) => `<PmtInf>
      <PmtInfId>${payment.pmtInfId}</PmtInfId><PmtMtd>TRF</PmtMtd><BtchBookg>false</BtchBookg>
      <NbOfTxs>${payment.transactions.length}</NbOfTxs><CtrlSum>${sum(payment.transactions)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl>${instant ? '<LclInstrm><Cd>INST</Cd></LclInstrm>' : ''}</PmtTpInf>
      <ReqdExctnDt><Dt>${new Date().toISOString().slice(0, 10)}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${payment.debtorName}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${payment.debtorIban}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BICFI>ETBADE2AXXX</BICFI></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      ${payment.transactions
        .map(
          (tx) => `<CdtTrfTxInf>
        <PmtId><EndToEndId>${tx.endToEndId}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${tx.amount}</InstdAmt></Amt>
        <Cdtr><Nm>${tx.creditorName}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${tx.creditorIban}</IBAN></Id></CdtrAcct>
        ${tx.remittance ? `<RmtInf><Ustrd>${tx.remittance}</Ustrd></RmtInf>` : ''}
      </CdtTrfTxInf>`,
        )
        .join('')}
    </PmtInf>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr><MsgId>${options.msgId}</MsgId><CreDtTm>${new Date().toISOString().slice(0, 19)}</CreDtTm><NbOfTxs>${allTx.length}</NbOfTxs><CtrlSum>${sum(allTx)}</CtrlSum><InitgPty><Nm>Test</Nm></InitgPty></GrpHdr>
    ${pmtInfs}
  </CstmrCdtTrfInitn>
</Document>`;
}

// VEU (distributed electronic signature) helpers

/** The order an HVD/HVT/HVE/HVS request refers to (HVRequestStructure) */
export interface VeuOrderRef {
  partnerId: string;
  orderId: string;
  serviceName: string;
  msgName: string;
  scope?: string;
  serviceOption?: string;
}

function hvRequestStructure(ref: VeuOrderRef): string {
  const scope = ref.scope ? `<Scope>${ref.scope}</Scope>` : '';
  const option = ref.serviceOption ? `<ServiceOption>${ref.serviceOption}</ServiceOption>` : '';
  return `<PartnerID>${ref.partnerId}</PartnerID><Service><ServiceName>${ref.serviceName}</ServiceName>${scope}${option}<MsgName>${ref.msgName}</MsgName></Service><OrderID>${ref.orderId}</OrderID>`;
}

/** HVZOrderParams without service filter: every order waiting for signatures */
export function hvzOrderParams(): string {
  return '<HVZOrderParams xmlns="urn:org:ebics:H005"/>';
}

export function hvdOrderParams(ref: VeuOrderRef): string {
  return `<HVDOrderParams xmlns="urn:org:ebics:H005">${hvRequestStructure(ref)}</HVDOrderParams>`;
}

export function hvtOrderParams(
  ref: VeuOrderRef,
  flags: { completeOrderData: boolean; fetchLimit?: number; fetchOffset?: number },
): string {
  return `<HVTOrderParams xmlns="urn:org:ebics:H005">${hvRequestStructure(ref)}<OrderFlags completeOrderData="${flags.completeOrderData}" fetchLimit="${flags.fetchLimit ?? 100}" fetchOffset="${flags.fetchOffset ?? 0}"/></HVTOrderParams>`;
}

/** Download Initialisation with caller-provided order params XML (e.g. from hvzOrderParams) */
export function buildEbicsOrderParamsDownloadInitRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
  bankCerts: BankCerts,
  orderType: string,
  orderParamsXml: string,
): string {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const authDigest = computeCertDigest(bankCerts.authCertPem);
  const encDigest = computeCertDigest(bankCerts.encCertPem);

  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>${orderType}</AdminOrderType>${orderParamsXml}</OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0000</SecurityMedium></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body/></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

/**
 * Encrypted UserSignatureData naming the signer, like encryptUploadContent but without order data.
 * `compress: false` skips the deflate step, so the bank can decrypt but not inflate the data.
 */
export function encryptSignatureData(
  bankEncPubKeyPem: string,
  signer: { partnerId: string; userId: string },
  options: { compress?: boolean } = {},
): { wrappedKey: string; signatureDataB64: string } {
  const txKey = randomBytes(16);
  const sigXml = `<?xml version="1.0" encoding="UTF-8"?><UserSignatureData xmlns="http://www.ebics.org/S002"><OrderSignatureData><SignatureVersion>A006</SignatureVersion><SignatureValue>${randomBytes(32).toString('base64')}</SignatureValue><PartnerID>${signer.partnerId}</PartnerID><UserID>${signer.userId}</UserID></OrderSignatureData></UserSignatureData>`;
  const cipher = createCipheriv('aes-128-cbc', txKey, Buffer.alloc(16, 0));
  const plain = Buffer.from(sigXml, 'utf8');
  const signatureDataB64 = Buffer.concat([cipher.update(options.compress === false ? plain : deflateSync(plain)), cipher.final()]).toString('base64');
  const wrappedKey = publicEncrypt({ key: bankEncPubKeyPem, padding: constants.RSA_PKCS1_PADDING }, txKey).toString('base64');
  return { wrappedKey, signatureDataB64 };
}

export interface VeuSignatureOptions {
  /** Signer named in the UserSignatureData; defaults to the requesting subscriber */
  signer?: { partnerId: string; userId: string };
  /** DataDigest sent in the body; defaults to random bytes */
  dataDigest?: string;
  /** false sends signature data that is encrypted but not deflated (undecodable for the bank) */
  compressSignatureData?: boolean;
}

/**
 * HVE (sign) or HVS (cancel) request: HV*OrderParams, NumSegments 0 and a body with only
 * DataEncryptionInfo, SignatureData and DataDigest. The signer defaults to the requesting subscriber.
 */
export function buildEbicsVeuSignatureRequest(
  hostId: string,
  partnerId: string,
  userId: string,
  keys: TestClientKeys,
  bankCerts: BankCerts,
  orderType: 'HVE' | 'HVS',
  ref: VeuOrderRef,
  bankEncPubKeyPem: string,
  options: VeuSignatureOptions = {},
): string {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const authDigest = computeCertDigest(bankCerts.authCertPem);
  const encDigest = computeCertDigest(bankCerts.encCertPem);
  const signature = encryptSignatureData(bankEncPubKeyPem, options.signer ?? { partnerId, userId }, { compress: options.compressSignatureData });
  const dataDigest = options.dataDigest ?? randomBytes(32).toString('base64');

  const xml = `<?xml version="1.0" encoding="UTF-8"?><ebicsRequest xmlns="urn:org:ebics:H005" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Version="H005" Revision="1"><header authenticate="true"><static><HostID>${hostId}</HostID><Nonce>${nonce}</Nonce><Timestamp>${timestamp}</Timestamp><PartnerID>${partnerId}</PartnerID><UserID>${userId}</UserID><OrderDetails><AdminOrderType>${orderType}</AdminOrderType><${orderType}OrderParams xmlns="urn:org:ebics:H005">${hvRequestStructure(ref)}</${orderType}OrderParams></OrderDetails><BankPubKeyDigests><Authentication Version="X002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${authDigest}</Authentication><Encryption Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</Encryption></BankPubKeyDigests><SecurityMedium>0200</SecurityMedium><NumSegments>0</NumSegments></static><mutable><TransactionPhase>Initialisation</TransactionPhase></mutable></header><AuthSignature/><body><DataTransfer><DataEncryptionInfo authenticate="true"><EncryptionPubKeyDigest Version="E002" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256">${encDigest}</EncryptionPubKeyDigest><TransactionKey>${signature.wrappedKey}</TransactionKey></DataEncryptionInfo><SignatureData authenticate="true">${signature.signatureDataB64}</SignatureData><DataDigest SignatureVersion="A006">${dataDigest}</DataDigest></DataTransfer></body></ebicsRequest>`;

  return signEbicsRequest(xml, keys.authKeyPair.privateKey);
}

// Direct debit document helper

export interface Pain008Transaction {
  endToEndId: string;
  debtorName: string;
  debtorIban: string;
  /** decimal, e.g. "12.34" */
  amount: string;
  mandateId: string;
  remittance?: string;
}

export interface Pain008Payment {
  pmtInfId: string;
  creditorName: string;
  creditorIban: string;
  /** YYYY-MM-DD, defaults to today */
  collectionDate?: string;
  transactions: Pain008Transaction[];
}

/** pain.008.001.08 SEPA core direct debit, one PmtInf per payment */
export function buildPain008Document(options: { msgId: string; payments: Pain008Payment[] }): string {
  const allTx = options.payments.flatMap((p) => p.transactions);
  const sum = (txs: Pain008Transaction[]) => txs.reduce((total, tx) => total + parseFloat(tx.amount), 0).toFixed(2);
  const today = new Date().toISOString().slice(0, 10);

  const pmtInfs = options.payments
    .map(
      (payment) => `<PmtInf>
      <PmtInfId>${payment.pmtInfId}</PmtInfId><PmtMtd>DD</PmtMtd><BtchBookg>false</BtchBookg>
      <NbOfTxs>${payment.transactions.length}</NbOfTxs><CtrlSum>${sum(payment.transactions)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>CORE</Cd></LclInstrm><SeqTp>RCUR</SeqTp></PmtTpInf>
      <ReqdColltnDt>${payment.collectionDate ?? today}</ReqdColltnDt>
      <Cdtr><Nm>${payment.creditorName}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${payment.creditorIban}</IBAN></Id></CdtrAcct>
      <CdtrAgt><FinInstnId><BICFI>ETBADE2AXXX</BICFI></FinInstnId></CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId><Id><PrvtId><Othr><Id>DE98ZZZ09999999999</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>
      ${payment.transactions
        .map(
          (tx) => `<DrctDbtTxInf>
        <PmtId><EndToEndId>${tx.endToEndId}</EndToEndId></PmtId>
        <InstdAmt Ccy="EUR">${tx.amount}</InstdAmt>
        <DrctDbtTx><MndtRltdInf><MndtId>${tx.mandateId}</MndtId><DtOfSgntr>2024-01-01</DtOfSgntr></MndtRltdInf></DrctDbtTx>
        <DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>
        <Dbtr><Nm>${tx.debtorName}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${tx.debtorIban}</IBAN></Id></DbtrAcct>
        ${tx.remittance ? `<RmtInf><Ustrd>${tx.remittance}</Ustrd></RmtInf>` : ''}
      </DrctDbtTxInf>`,
        )
        .join('')}
    </PmtInf>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08">
  <CstmrDrctDbtInitn>
    <GrpHdr><MsgId>${options.msgId}</MsgId><CreDtTm>${new Date().toISOString().slice(0, 19)}</CreDtTm><NbOfTxs>${allTx.length}</NbOfTxs><CtrlSum>${sum(allTx)}</CtrlSum><InitgPty><Nm>Test</Nm></InitgPty></GrpHdr>
    ${pmtInfs}
  </CstmrDrctDbtInitn>
</Document>`;
}
