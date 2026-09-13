import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_CLASSES,
  isAuthorised,
  missingSignatures,
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

  describe('isAuthorised with a minimum of two signatures (chapter 11.2.3)', () => {
    it.each([
      [[], false],
      [['E'], false],
      [['A'], false],
      [['B'], false],
      [['T'], false],
    ] as [SignatureClass[], boolean][])('one signer %j → %s: E alone is not enough', (signers, expected) => {
      expect(isAuthorised(signers, 2)).toBe(expected);
    });

    it('covers every ordered pair of classes: any two bank-technical signatures except B + B', () => {
      for (const first of CLASSES) {
        for (const second of CLASSES) {
          const expected = first !== 'T' && second !== 'T' && !(first === 'B' && second === 'B');
          expect(isAuthorised([first, second], 2), `${first} + ${second}`).toBe(expected);
        }
      }
    });

    it.each([
      [['B', 'B', 'A'], true],
      [['B', 'B', 'E'], true],
      [['B', 'B', 'B'], false],
      [['E', 'T', 'T'], false],
      [['T', 'A', 'B'], true],
    ] as [SignatureClass[], boolean][])('three signers %j → %s', (signers, expected) => {
      expect(isAuthorised(signers, 2)).toBe(expected);
    });
  });

  describe('missingSignatures', () => {
    it.each([
      [1, [], 1],
      [1, ['T'], 1],
      [1, ['E'], 0],
      [1, ['B'], 1],
      [1, ['B', 'B'], 1],
      [2, [], 2],
      [2, ['T'], 2],
      [2, ['E'], 1],
      [2, ['B'], 1],
      [2, ['B', 'B'], 1],
      [2, ['A', 'B'], 0],
    ] as [1 | 2, SignatureClass[], number][])('minimum %s with signers %j → %s further signatures', (minimum, signers, expected) => {
      expect(missingSignatures(signers, minimum)).toBe(expected);
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
        expect(uploadDecision({ signatureFlag, requestEds, signerClasses: [signatureClass] })).toBe(expected);
      },
    );

    it('applies the customer agreements of chapter 3.14', () => {
      const withoutVeu = { veu: false, signingOutsideEbics: true };
      const withoutOutside = { veu: true, signingOutsideEbics: false };
      // Requested VEU without agreement: refused unless the signatures suffice (then requestEDS is ignored)
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses: ['A'], agreements: withoutVeu })).toBe('rejectWithoutVeuAgreement');
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses: ['E'], agreements: withoutVeu })).toBe('execute');
      expect(uploadDecision({ signatureFlag: true, requestEds: false, signerClasses: ['A'], agreements: withoutVeu })).toBe('reject');
      expect(uploadDecision({ signatureFlag: false, requestEds: false, signerClasses: ['T'], agreements: withoutVeu })).toBe('execute');
      // No SignatureFlag without agreement on authorisation outside EBICS: refused
      expect(uploadDecision({ signatureFlag: false, requestEds: false, signerClasses: ['T'], agreements: withoutOutside })).toBe('reject');
      expect(uploadDecision({ signatureFlag: true, requestEds: false, signerClasses: ['E'], agreements: withoutOutside })).toBe('execute');
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses: ['B'], agreements: withoutOutside })).toBe('veu');
    });

    it('applies the agreed minimum of two signatures to signed uploads only', () => {
      expect(uploadDecision({ signatureFlag: true, requestEds: false, signerClasses: ['E'], minimumSignatures: 2 })).toBe('reject');
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses: ['E'], minimumSignatures: 2 })).toBe('veu');
      expect(uploadDecision({ signatureFlag: true, requestEds: false, signerClasses: ['A', 'B'], minimumSignatures: 2 })).toBe('execute');
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses: ['B', 'B'], minimumSignatures: 2 })).toBe('veu');
      expect(uploadDecision({ signatureFlag: false, requestEds: false, signerClasses: ['T'], minimumSignatures: 2 })).toBe('execute');
    });

    it('executes uploads without SignatureFlag once the class is derived with uploadSignatureClass', () => {
      for (const subscriberClass of CLASSES) {
        const signatureClass = uploadSignatureClass(false, subscriberClass);
        expect(uploadDecision({ signatureFlag: false, requestEds: false, signerClasses: [signatureClass] }), subscriberClass).toBe('execute');
      }
    });

    // Several EUs in one upload (chapter 11.2.3): together they authorise like VEU signatures
    it.each([
      [["A", "B"], "execute"],
      [["A", "A"], "execute"],
      [["B", "B"], "veu"],
      [["A", "T"], "veu"],
      [["E", "T"], "execute"],
      [[], "veu"],
    ] as [SignatureClass[], UploadDecision][])("signatureFlag with requestEDS and signer classes %j → %s", (signerClasses, expected) => {
      expect(uploadDecision({ signatureFlag: true, requestEds: true, signerClasses })).toBe(expected);
    });
  });
});
