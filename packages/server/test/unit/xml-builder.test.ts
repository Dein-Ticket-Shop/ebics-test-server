import { describe, it, expect } from 'vitest';
import { buildHevResponse, buildKeyManagementResponse, buildHpbOrderData } from '../../src/protocol/xml-builder.js';
import { ReturnCode } from '../../src/protocol/return-codes.js';
import { validateXml } from '../../src/protocol/xml-validator.js';
import { parseXml, xpathString } from '../../src/protocol/xml-parser.js';
import { generateBankKeys } from '../../src/bank/bank-keys.js';

describe('xml-builder', () => {
  describe('buildHevResponse', () => {
    it('should produce valid HEV response XML', () => {
      const xml = buildHevResponse('000000', '[EBICS_OK] OK', [{ protocol: 'H005', release: '03.00' }]);
      expect(() => validateXml(xml, 'hev')).not.toThrow();
    });

    it('should work with empty versions (error case)', () => {
      const xml = buildHevResponse('091011', 'Invalid Host', []);
      expect(() => validateXml(xml, 'hev')).not.toThrow();
      expect(xml).toContain('091011');
      expect(xml).not.toContain('VersionNumber');
    });

    it('should include multiple versions', () => {
      const xml = buildHevResponse('000000', 'OK', [
        { protocol: 'H004', release: '02.50' },
        { protocol: 'H005', release: '03.00' },
      ]);
      expect(xml).toContain('H004');
      expect(xml).toContain('H005');
    });

    it('should contain correct namespace', () => {
      const xml = buildHevResponse('000000', 'OK', []);
      expect(xml).toContain('http://www.ebics.org/H000');
    });
  });

  describe('buildKeyManagementResponse', () => {
    it('should produce valid response without orderData', () => {
      const result = buildKeyManagementResponse(ReturnCode.EBICS_OK, ReturnCode.EBICS_OK);
      expect(result.responseXml).toContain('ebicsKeyManagementResponse');
      expect(result.responseXml).toContain('000000');
      expect(result.responseXml).not.toContain('DataTransfer');
    });

    it('should include DataTransfer when orderData provided', () => {
      const result = buildKeyManagementResponse(
        ReturnCode.EBICS_OK,
        ReturnCode.EBICS_OK,
        { encryptedOrderData: 'AAAA', transactionKey: 'BBBB' },
      );
      expect(result.responseXml).toContain('DataTransfer');
      expect(result.responseXml).toContain('AAAA');
      expect(result.responseXml).toContain('BBBB');
    });

    it('should include OrderID when provided', () => {
      const result = buildKeyManagementResponse(
        ReturnCode.EBICS_OK,
        ReturnCode.EBICS_OK,
        undefined,
        'A001',
      );
      expect(result.responseXml).toContain('A001');
    });

    it('should contain H005 namespace and version', () => {
      const result = buildKeyManagementResponse(ReturnCode.EBICS_OK, ReturnCode.EBICS_OK);
      expect(result.responseXml).toContain('urn:org:ebics:H005');
      expect(result.responseXml).toContain('H005');
    });
  });

  describe('buildHpbOrderData', () => {
    it('should produce XML with auth and enc key info', () => {
      const keys = generateBankKeys('TESTHOST');
      const xml = buildHpbOrderData(
        keys.authenticationCertificate,
        keys.authenticationVersion,
        keys.encryptionCertificate,
        keys.encryptionVersion,
        'TESTHOST',
      );

      expect(xml).toContain('HPBResponseOrderData');
      expect(xml).toContain('AuthenticationPubKeyInfo');
      expect(xml).toContain('EncryptionPubKeyInfo');
      expect(xml).toContain('X002');
      expect(xml).toContain('E002');
      expect(xml).toContain('X509Certificate');
    });

    it('should include hostId', () => {
      const keys = generateBankKeys('MYHOST');
      const xml = buildHpbOrderData(
        keys.authenticationCertificate, 'X002',
        keys.encryptionCertificate, 'E002',
        'MYHOST',
      );
      expect(xml).toContain('MYHOST');
    });
  });
});
