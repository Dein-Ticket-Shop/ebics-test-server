import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_CLASSES,
  isAuthorised,
  isBankTechnical,
  isSignatureClass,
  uploadDecision,
  uploadSignatureClass,
  type UploadDecision,
} from '../../src/banking/signatures.js';
import type { SignatureClass } from '../../src/store/types.js';

const CLASSES: SignatureClass[] = ['E', 'A', 'B', 'T'];

describe('signature classes (Unterschriftsklassen)', () => {
  describe('isSignatureClass', () => {
    it('SIGNATURE_CLASSES are E, A, B and T', () => {
      expect([...SIGNATURE_CLASSES]).toEqual(CLASSES);
    });

    it.each(CLASSES)('accepts %s', (value) => {
      expect(isSignatureClass(value)).toBe(true);
    });

    it.each([['e'], ['a'], ['b'], ['t'], ['C'], ['X'], [''], ['EA'], [' E'], ['E '], [null], [undefined], [0], [1], [true], [{}], [['E']]])(
      'rejects %j',
      (value) => {
        expect(isSignatureClass(value)).toBe(false);
      },
    );
  });

  describe('isBankTechnical', () => {
    it.each([
      ['E', true],
      ['A', true],
      ['B', true],
      ['T', false],
    ] as const)('%s → %s', (signatureClass, expected) => {
      expect(isBankTechnical(signatureClass)).toBe(expected);
    });
  });

  describe('isAuthorised', () => {
    it('is false without signers', () => {
      expect(isAuthorised([])).toBe(false);
    });

    // A single signature authorises only with class E
    it.each([
      ['E', true],
      ['A', false],
      ['B', false],
      ['T', false],
    ] as const)('one signer %s → %s', (signer, expected) => {
      expect(isAuthorised([signer])).toBe(expected);
    });

    // Two signers: any E, or two bank-technical signatures with at least one A (B + B is not enough, T never counts)
    it.each([
      ['E', 'E', true],
      ['E', 'A', true],
      ['E', 'B', true],
      ['E', 'T', true],
      ['A', 'E', true],
      ['A', 'A', true],
      ['A', 'B', true],
      ['A', 'T', false],
      ['B', 'E', true],
      ['B', 'A', true],
      ['B', 'B', false],
      ['B', 'T', false],
      ['T', 'E', true],
      ['T', 'A', false],
      ['T', 'B', false],
      ['T', 'T', false],
    ] as const)('two signers %s + %s → %s', (first, second, expected) => {
      expect(isAuthorised([first, second])).toBe(expected);
    });

    it('covers every ordered pair of classes', () => {
      for (const first of CLASSES) {
        for (const second of CLASSES) {
          const expected = first === 'E' || second === 'E' || ((first === 'A' || second === 'A') && first !== 'T' && second !== 'T');
          expect(isAuthorised([first, second]), `${first} + ${second}`).toBe(expected);
        }
      }
    });

    it.each([
      [['A', 'A', 'A'], true],
      [['A', 'B', 'B'], true],
      [['B', 'A', 'B'], true],
      [['B', 'B', 'A'], true],
      [['B', 'B', 'E'], true],
      [['B', 'B', 'B'], false],
      [['B', 'B', 'T'], false],
      [['A', 'B', 'T'], true],
      [['B', 'T', 'A'], true],
      [['T', 'T', 'A'], false],
      [['T', 'T', 'B'], false],
      [['T', 'T', 'E'], true],
      [['A', 'T', 'T'], false],
      [['T', 'T', 'T'], false],
    ] as [SignatureClass[], boolean][])('three signers %j → %s', (signers, expected) => {
      expect(isAuthorised(signers)).toBe(expected);
    });

    it('does not change the passed classes', () => {
      const signers: SignatureClass[] = ['T', 'B', 'A'];
      isAuthorised(signers);
      expect(signers).toEqual(['T', 'B', 'A']);
    });
  });

  describe('uploadSignatureClass', () => {
    it.each(CLASSES)('with SignatureFlag the upload signature has the subscriber class %s', (subscriberClass) => {
      expect(uploadSignatureClass(true, subscriberClass)).toBe(subscriberClass);
    });

    it.each(CLASSES)('without SignatureFlag the upload of a class %s subscriber is a transport signature (T)', (subscriberClass) => {
      expect(uploadSignatureClass(false, subscriberClass)).toBe('T');
    });
  });

  describe('uploadDecision', () => {
    // [signatureFlag, requestEds, signatureClass, decision]: every combination
    it.each([
      // No SignatureFlag: authorised outside EBICS and executed, whatever the class
      [false, false, 'E', 'execute'],
      [false, false, 'A', 'execute'],
      [false, false, 'B', 'execute'],
      [false, false, 'T', 'execute'],
      [false, true, 'E', 'execute'],
      [false, true, 'A', 'execute'],
      [false, true, 'B', 'execute'],
      [false, true, 'T', 'execute'],
      // SignatureFlag: a class E signature authorises alone
      [true, false, 'E', 'execute'],
      [true, true, 'E', 'execute'],
      // SignatureFlag without enough rights: VEU with requestEDS, rejected without
      [true, true, 'A', 'veu'],
      [true, true, 'B', 'veu'],
      [true, true, 'T', 'veu'],
      [true, false, 'A', 'reject'],
      [true, false, 'B', 'reject'],
      [true, false, 'T', 'reject'],
    ] as [boolean, boolean, SignatureClass, UploadDecision][])(
      'signatureFlag=%s requestEds=%s class %s → %s',
      (signatureFlag, requestEds, signatureClass, expected) => {
        expect(uploadDecision({ signatureFlag, requestEds, signatureClass })).toBe(expected);
      },
    );

    it('executes uploads without SignatureFlag once the class is derived with uploadSignatureClass', () => {
      for (const subscriberClass of CLASSES) {
        const signatureClass = uploadSignatureClass(false, subscriberClass);
        expect(uploadDecision({ signatureFlag: false, requestEds: false, signatureClass }), subscriberClass).toBe('execute');
      }
    });
  });
});
