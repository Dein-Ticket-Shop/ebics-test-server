import {
  XmlDocument,
  XsdValidator,
  XmlBufferInputProvider,
  xmlRegisterInputProvider,
  xmlCleanupInputProvider,
} from 'libxml2-wasm';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function findSchemasDir(): string {
  // Try relative to source file first, then cwd
  const candidates = [
    resolve(__dirname, '../../schemas'),
    resolve(process.cwd(), 'schemas'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'H005'))) return dir;
  }
  throw new Error(`Cannot find schemas directory. Tried: ${candidates.join(', ')}`);
}

const SCHEMAS_DIR = findSchemasDir();

const SCHEMA_ALIASES: Record<string, string> = {
  'ebics_signature.xsd': 'ebics_signature_S002.xsd',
};

function registerAllSchemas(): void {
  const buffers: Record<string, Uint8Array> = {};

  for (const subdir of ['H005', 'H000', 'S002']) {
    const dir = join(SCHEMAS_DIR, subdir);
    for (const file of readdirSync(dir).filter((f: string) => f.endsWith('.xsd'))) {
      const content = readFileSync(join(dir, file));
      buffers[file] = content;
      const alias = SCHEMA_ALIASES[file];
      if (alias) {
        buffers[alias] = content;
      }
    }
  }

  const provider = new XmlBufferInputProvider(buffers);
  xmlRegisterInputProvider(provider);
}

function loadValidator(dir: string, mainFile: string): XsdValidator {
  const content = readFileSync(join(dir, mainFile));
  const schemaDoc = XmlDocument.fromBuffer(content);
  try {
    return XsdValidator.fromDoc(schemaDoc);
  } finally {
    schemaDoc.dispose();
  }
}

const validatorNames = ['hev', 'request', 'response', 'keymgmtRequest', 'keymgmtResponse'] as const;
export type ValidatorName = (typeof validatorNames)[number];

type Validators = Record<ValidatorName, XsdValidator>;

let _validators: Validators | null = null;
let _inputRegistered = false;

export function getValidators(): Validators {
  if (_validators) return _validators;

  if (!_inputRegistered) {
    registerAllSchemas();
    _inputRegistered = true;
  }

  _validators = {
    hev: loadValidator(join(SCHEMAS_DIR, 'H000'), 'ebics_hev.xsd'),
    request: loadValidator(join(SCHEMAS_DIR, 'H005'), 'ebics_H005.xsd'),
    response: loadValidator(join(SCHEMAS_DIR, 'H005'), 'ebics_H005.xsd'),
    keymgmtRequest: loadValidator(join(SCHEMAS_DIR, 'H005'), 'ebics_H005.xsd'),
    keymgmtResponse: loadValidator(join(SCHEMAS_DIR, 'H005'), 'ebics_H005.xsd'),
  };

  return _validators;
}

export function validateXml(xml: string | Buffer, validatorName: ValidatorName): void {
  const validators = getValidators();
  const validator = validators[validatorName];
  const buf = Buffer.isBuffer(xml) ? xml : Buffer.from(xml);
  const doc = XmlDocument.fromBuffer(buf);
  try {
    validator.validate(doc);
  } finally {
    doc.dispose();
  }
}

export function selectRequestValidator(rootElement: string): ValidatorName {
  switch (rootElement) {
    case 'ebicsHEVRequest':
      return 'hev';
    case 'ebicsUnsecuredRequest':
    case 'ebicsNoPubKeyDigestsRequest':
      return 'keymgmtRequest';
    case 'ebicsRequest':
      return 'request';
    default:
      return 'request';
  }
}

export function selectResponseValidator(rootElement: string): ValidatorName {
  switch (rootElement) {
    case 'ebicsHEVResponse':
      return 'hev';
    case 'ebicsKeyManagementResponse':
      return 'keymgmtResponse';
    case 'ebicsResponse':
      return 'response';
    default:
      return 'response';
  }
}

export function disposeValidators(): void {
  if (_validators) {
    for (const v of Object.values(_validators)) {
      v.dispose();
    }
    _validators = null;
  }
  if (_inputRegistered) {
    xmlCleanupInputProvider();
    _inputRegistered = false;
  }
}
