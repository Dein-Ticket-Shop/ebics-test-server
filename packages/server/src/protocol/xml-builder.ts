import { create } from 'xmlbuilder2';
import { EBICS_NS, EBICS_VERSION, EBICS_REVISION } from './constants.js';
import { getReportText, ReturnCode } from './return-codes.js';
import type { HandlerResult } from '../handlers/handler-types.js';

export function buildHevResponse(
  returnCode: string,
  reportText: string,
  versions: Array<{ protocol: string; release: string }>,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H000, 'ebicsHEVResponse');

  const sysReturn = root.ele(EBICS_NS.H000, 'SystemReturnCode');
  sysReturn.ele(EBICS_NS.H000, 'ReturnCode').txt(returnCode);
  sysReturn.ele(EBICS_NS.H000, 'ReportText').txt(reportText);

  for (const v of versions) {
    root
      .ele(EBICS_NS.H000, 'VersionNumber')
      .att('ProtocolVersion', v.protocol)
      .txt(v.release);
  }

  return root.end({ prettyPrint: true });
}

export function buildKeyManagementResponse(
  technicalCode: ReturnCode,
  businessCode: ReturnCode,
  orderData?: { encryptedOrderData: string; transactionKey: string },
  orderId?: string,
): HandlerResult {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'ebicsKeyManagementResponse')
    .att('Version', EBICS_VERSION)
    .att('Revision', EBICS_REVISION);

  const header = root.ele(EBICS_NS.H005, 'header').att('authenticate', 'true');
  header.ele(EBICS_NS.H005, 'static');

  const mutable = header.ele(EBICS_NS.H005, 'mutable');
  if (orderId) {
    mutable.ele(EBICS_NS.H005, 'OrderID').txt(orderId);
  }
  mutable.ele(EBICS_NS.H005, 'ReturnCode').txt(technicalCode);
  mutable.ele(EBICS_NS.H005, 'ReportText').txt(getReportText(technicalCode));

  const body = root.ele(EBICS_NS.H005, 'body');

  if (orderData) {
    const dt = body.ele(EBICS_NS.H005, 'DataTransfer');
    const dei = dt.ele(EBICS_NS.H005, 'DataEncryptionInfo').att('authenticate', 'true');
    dei.ele(EBICS_NS.H005, 'EncryptionPubKeyDigest')
      .att('Version', 'E002')
      .att('Algorithm', 'http://www.w3.org/2001/04/xmlenc#sha256')
      .txt('');
    dei.ele(EBICS_NS.H005, 'TransactionKey').txt(orderData.transactionKey);
    dt.ele(EBICS_NS.H005, 'OrderData').txt(orderData.encryptedOrderData);
  }

  body.ele(EBICS_NS.H005, 'ReturnCode').att('authenticate', 'true').txt(businessCode);
  body.ele(EBICS_NS.H005, 'TimestampBankParameter')
    .att('authenticate', 'true')
    .txt(new Date().toISOString());

  return { responseXml: root.end({ prettyPrint: true }) };
}

export function buildHpbOrderData(
  authCertPem: string,
  authVersion: string,
  encCertPem: string,
  encVersion: string,
  hostId: string,
): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'HPBResponseOrderData');

  const authInfo = root.ele(EBICS_NS.H005, 'AuthenticationPubKeyInfo');
  const authX509 = authInfo.ele(EBICS_NS.XMLDSIG, 'X509Data');
  authX509.ele(EBICS_NS.XMLDSIG, 'X509Certificate').txt(extractCertBase64(authCertPem));
  authInfo.ele(EBICS_NS.H005, 'AuthenticationVersion').txt(authVersion);

  const encInfo = root.ele(EBICS_NS.H005, 'EncryptionPubKeyInfo');
  const encX509 = encInfo.ele(EBICS_NS.XMLDSIG, 'X509Data');
  encX509.ele(EBICS_NS.XMLDSIG, 'X509Certificate').txt(extractCertBase64(encCertPem));
  encInfo.ele(EBICS_NS.H005, 'EncryptionVersion').txt(encVersion);

  root.ele(EBICS_NS.H005, 'HostID').txt(hostId);

  return root.end({ prettyPrint: true });
}

export interface EbicsResponseOptions {
  technicalCode: ReturnCode;
  businessCode: ReturnCode;
  transactionId?: string;
  numSegments?: number;
  transactionPhase: 'Initialisation' | 'Transfer' | 'Receipt';
  segmentNumber?: number;
  lastSegment?: boolean;
  dataTransfer?: {
    encKeyDigest: string;
    transactionKey: string;
    orderData: string;
  };
}

export function buildEbicsResponse(options: EbicsResponseOptions): HandlerResult {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(EBICS_NS.H005, 'ebicsResponse')
    .att('Version', EBICS_VERSION)
    .att('Revision', EBICS_REVISION);

  const header = root.ele(EBICS_NS.H005, 'header').att('authenticate', 'true');

  const staticHeader = header.ele(EBICS_NS.H005, 'static');
  if (options.transactionId) {
    staticHeader.ele(EBICS_NS.H005, 'TransactionID').txt(options.transactionId);
  }
  if (options.numSegments !== undefined) {
    staticHeader.ele(EBICS_NS.H005, 'NumSegments').txt(String(options.numSegments));
  }

  const mutable = header.ele(EBICS_NS.H005, 'mutable');
  mutable.ele(EBICS_NS.H005, 'TransactionPhase').txt(options.transactionPhase);
  if (options.segmentNumber !== undefined) {
    mutable.ele(EBICS_NS.H005, 'SegmentNumber')
      .att('lastSegment', String(options.lastSegment ?? false))
      .txt(String(options.segmentNumber));
  }
  mutable.ele(EBICS_NS.H005, 'ReturnCode').txt(options.technicalCode);
  mutable.ele(EBICS_NS.H005, 'ReportText').txt(getReportText(options.technicalCode));

  const authSig = root.ele(EBICS_NS.H005, 'AuthSignature');
  const signedInfo = authSig.ele(EBICS_NS.XMLDSIG, 'SignedInfo');
  signedInfo.ele(EBICS_NS.XMLDSIG, 'CanonicalizationMethod')
    .att('Algorithm', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315');
  signedInfo.ele(EBICS_NS.XMLDSIG, 'SignatureMethod')
    .att('Algorithm', 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
  const ref = signedInfo.ele(EBICS_NS.XMLDSIG, 'Reference').att('URI', '#xpointer(//*[@authenticate="true"])');
  ref.ele(EBICS_NS.XMLDSIG, 'Transforms')
    .ele(EBICS_NS.XMLDSIG, 'Transform')
    .att('Algorithm', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315');
  ref.ele(EBICS_NS.XMLDSIG, 'DigestMethod')
    .att('Algorithm', 'http://www.w3.org/2001/04/xmlenc#sha256');
  ref.ele(EBICS_NS.XMLDSIG, 'DigestValue').txt('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  authSig.ele(EBICS_NS.XMLDSIG, 'SignatureValue').txt('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

  const body = root.ele(EBICS_NS.H005, 'body');

  if (options.dataTransfer) {
    const dt = body.ele(EBICS_NS.H005, 'DataTransfer');
    const dei = dt.ele(EBICS_NS.H005, 'DataEncryptionInfo').att('authenticate', 'true');
    dei.ele(EBICS_NS.H005, 'EncryptionPubKeyDigest')
      .att('Version', 'E002')
      .att('Algorithm', 'http://www.w3.org/2001/04/xmlenc#sha256')
      .txt(options.dataTransfer.encKeyDigest);
    dei.ele(EBICS_NS.H005, 'TransactionKey').txt(options.dataTransfer.transactionKey);
    dt.ele(EBICS_NS.H005, 'OrderData').txt(options.dataTransfer.orderData);
  }

  body.ele(EBICS_NS.H005, 'ReturnCode').att('authenticate', 'true').txt(options.businessCode);
  if (options.transactionPhase === 'Initialisation') {
    body.ele(EBICS_NS.H005, 'TimestampBankParameter')
      .att('authenticate', 'true')
      .txt(new Date().toISOString());
  }

  return { responseXml: root.end({ prettyPrint: true }) };
}

function extractCertBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
}
