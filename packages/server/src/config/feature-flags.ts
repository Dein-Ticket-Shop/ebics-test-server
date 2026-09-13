/**
 * Test-server behaviour toggles, read from the environment.
 *
 * Every flag is described as data in ENV_FLAGS (variable, label, description, default, allowed values),
 * so the admin UI can list them with their current values (GET /api/config/env-flags). The getters below
 * read the environment at call time, so tests can change a flag per test.
 */

export type EnvFlagValue = boolean | string;
export type EnvFlagType = 'boolean' | 'enum';

export interface EnvFlagDefinition<T extends EnvFlagValue = EnvFlagValue> {
  /** Environment variable that sets the flag */
  env: string;
  type: EnvFlagType;
  /** Short name for the admin UI */
  label: string;
  /** What the flag changes. Inline code is written in backticks. */
  description: string;
  /** Allowed values of enum flags */
  options?: readonly string[];
  /** Value when the variable is unset or not recognised */
  defaultValue: T;
  /** Parses a set variable; undefined when the value is not recognised */
  parse: (raw: string) => T | undefined;
}

export interface EnvFlagState {
  key: string;
  env: string;
  type: EnvFlagType;
  label: string;
  description: string;
  options?: string[];
  defaultValue: EnvFlagValue;
  /** Effective value */
  value: EnvFlagValue;
  /** The variable as set in the environment, null when unset */
  raw: string | null;
  /** The variable is set but its value is not recognised, so the default applies */
  ignored: boolean;
}

function booleanFlag(
  flag: Pick<EnvFlagDefinition, 'env' | 'label' | 'description'> & { defaultValue?: boolean },
): EnvFlagDefinition<boolean> {
  return {
    ...flag,
    type: 'boolean',
    defaultValue: flag.defaultValue ?? false,
    parse: (raw) => (raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : undefined),
  };
}

function enumFlag<T extends string>(
  flag: Pick<EnvFlagDefinition, 'env' | 'label' | 'description'> & { options: readonly T[]; defaultValue: T },
): EnvFlagDefinition<T> {
  return {
    ...flag,
    type: 'enum',
    parse: (raw) => (flag.options.includes(raw as T) ? (raw as T) : undefined),
  };
}

export type HacFormat = 'legacy' | 'pain.002';
export type VopStatus = 'RCVC' | 'RVMC' | 'RVNM' | 'RVNA';

export const ENV_FLAGS = {
  strictValidation: booleanFlag({
    env: 'EBICS_STRICT_VALIDATION',
    label: 'Strict IBAN/BIC and account validation',
    description:
      'Uploads with a malformed IBAN or BIC are rejected with 090004, like a real bank, which is what makes the ' +
      'test server useful for catching client bugs. Set `false` to book deliberately rough data anyway.',
    defaultValue: true,
  }),
  allowPreActivation: booleanFlag({
    env: 'EBICS_ALLOW_PREACTIVATION',
    label: 'HPB before activation',
    description:
      'HPB (bank key download) is accepted while the subscriber is only INITIALIZED, right after INI and HIA and ' +
      'before the activate step. Handy locally when activating each round is friction. By default HPB requires ' +
      'an activated (READY) subscriber, like real banks. Order processing always requires READY.',
  }),
  hacFormat: enumFlag<HacFormat>({
    env: 'EBICS_HAC_FORMAT',
    label: 'HAC format',
    description:
      'Order data format of HAC downloads. `legacy` is the original test-server `HACResponseOrderData` listing. ' +
      '`pain.002` is the pain.002.001.03 customer protocol real banks send, rendered from the HAC event ledger ' +
      '(see docs/HAC_PLAN.md) and required by clients that parse HAC. The ledger itself is always recorded.',
    options: ['legacy', 'pain.002'],
    defaultValue: 'legacy',
  }),
  vopDefault: enumFlag<VopStatus>({
    env: 'EBICS_VOP_DEFAULT',
    label: 'VoP result for other banks',
    description:
      'Verification of Payee result for creditors whose IBAN is not held at this bank, so their name cannot be ' +
      'checked. Creditors held here are matched against the account owner name instead.',
    options: ['RCVC', 'RVMC', 'RVNM', 'RVNA'],
    defaultValue: 'RCVC',
  }),
  vopConfirmation: booleanFlag({
    env: 'EBICS_VOP_CONFIRMATION',
    label: 'Hold orders until VoP is confirmed',
    description:
      'Credit transfers whose Verification of Payee result is not a full match (`RCVC`) are held in the VEU until ' +
      'someone confirms them with an electronic signature (HVE, the uploader may confirm) or an admin releases ' +
      'them. By default orders are executed regardless of the VoP result.',
  }),
  hacDownloadEvents: booleanFlag({
    env: 'EBICS_HAC_DOWNLOAD_EVENTS',
    label: 'FILE_DOWNLOAD events in HAC',
    description:
      'Every successful download except HAC and PTK appends a `FILE_DOWNLOAD` event with its own OrderID to the ' +
      'HAC ledger, like banks whose customer protocol also lists downloads.',
  }),
  wssOneTimeTokens: booleanFlag({
    env: 'EBICS_WSS_ONE_TIME_TOKEN',
    label: 'One-time WebSocket tokens',
    description:
      'wssparam hands out one-time tokens (OTT `Y`): each token opens a single real-time WebSocket connection. ' +
      'By default tokens (OTT `N`) can reconnect until their VALIDITY ends.',
  }),
  wssReplay: booleanFlag({
    env: 'EBICS_WSS_REPLAY',
    label: 'Replay missed real-time messages',
    description:
      'EBICS-HAA and INFO messages for a customer without an open real-time connection are kept and sent in order ' +
      'when a client of the customer connects; their `TIMESTAMP` stays the time of the first delivery attempt. ' +
      'DK Anlage 2 (chapters 3.1 and 3.2) allows this delayed delivery without requiring it. Messages are kept only ' +
      'while a token issued for the customer has not reached its `VALIDITY`. By default messages without a ' +
      'connection are dropped.',
  }),
} satisfies Record<string, EnvFlagDefinition>;

function read<T extends EnvFlagValue>(flag: EnvFlagDefinition<T>): T {
  const raw = process.env[flag.env];
  return (raw === undefined ? undefined : flag.parse(raw)) ?? flag.defaultValue;
}

/** All flags with their descriptions and current values, for the admin UI */
export function describeEnvFlags(): EnvFlagState[] {
  return Object.entries(ENV_FLAGS).map(([key, flag]: [string, EnvFlagDefinition]) => {
    const raw = process.env[flag.env];
    const parsed = raw === undefined ? undefined : flag.parse(raw);
    return {
      key,
      env: flag.env,
      type: flag.type,
      label: flag.label,
      description: flag.description,
      ...(flag.options ? { options: [...flag.options] } : {}),
      defaultValue: flag.defaultValue,
      value: parsed ?? flag.defaultValue,
      raw: raw ?? null,
      ignored: raw !== undefined && parsed === undefined,
    };
  });
}

export function strictValidation(): boolean {
  return read(ENV_FLAGS.strictValidation);
}

export function allowPreActivation(): boolean {
  return read(ENV_FLAGS.allowPreActivation);
}

export function hacFormat(): HacFormat {
  return read(ENV_FLAGS.hacFormat);
}

export function vopDefaultStatus(): VopStatus {
  return read(ENV_FLAGS.vopDefault);
}

export function vopConfirmationRequired(): boolean {
  return read(ENV_FLAGS.vopConfirmation);
}

export function hacDownloadEvents(): boolean {
  return read(ENV_FLAGS.hacDownloadEvents);
}

export function wssOneTimeTokens(): boolean {
  return read(ENV_FLAGS.wssOneTimeTokens);
}

export function wssReplay(): boolean {
  return read(ENV_FLAGS.wssReplay);
}
