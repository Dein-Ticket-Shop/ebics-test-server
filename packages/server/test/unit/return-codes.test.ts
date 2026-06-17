import { describe, it, expect } from 'vitest';
import { ReturnCode, getReportText } from '../../src/protocol/return-codes.js';

describe('return-codes', () => {
  describe('ReturnCode enum', () => {
    it('should have all values as 6-digit strings', () => {
      for (const value of Object.values(ReturnCode)) {
        expect(value).toMatch(/^\d{6}$/);
      }
    });

    it('should have EBICS_OK as 000000', () => {
      expect(ReturnCode.EBICS_OK).toBe('000000');
    });

    it('should have distinct values for each code', () => {
      const values = Object.values(ReturnCode);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });
  });

  describe('getReportText', () => {
    it('should return text for EBICS_OK', () => {
      const text = getReportText(ReturnCode.EBICS_OK);
      expect(text).toContain('EBICS_OK');
    });

    it('should return text for EBICS_INVALID_HOST_ID', () => {
      const text = getReportText(ReturnCode.EBICS_INVALID_HOST_ID);
      expect(text).toContain('EBICS_INVALID_HOST_ID');
    });

    it('should return text for EBICS_AUTHENTICATION_FAILED', () => {
      const text = getReportText(ReturnCode.EBICS_AUTHENTICATION_FAILED);
      expect(text).toContain('EBICS_AUTHENTICATION_FAILED');
    });

    it('should return fallback for unknown code', () => {
      const text = getReportText('999999' as ReturnCode);
      expect(text).toContain('999999');
    });
  });
});
