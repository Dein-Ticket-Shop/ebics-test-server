/**
 * Test-server behaviour toggles, read from the environment.
 *
 * Real EBICS banks gate every key-download and order request behind subscriber
 * *activation*: the subscriber must reach the READY state (operator confirms the
 * INI letter, then activates) before the bank will serve anything. Order processing
 * is already gated on READY in the dispatcher; HPB is the one step that can be
 * relaxed for convenience.
 */

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === 'true' || value === '1';
}

/**
 * When true, HPB (bank public-key download) is accepted while the subscriber is still
 * merely INITIALIZED — i.e. right after INI + HIA, *before* the activate step. This
 * mimics a lenient setup and is handy for local testing where clicking "activate" each
 * round is friction.
 *
 * Default (false) is the realistic behaviour: HPB requires a fully activated (READY)
 * subscriber, just like real banks.
 *
 * Enable with `EBICS_ALLOW_PREACTIVATION=true`.
 */
export function allowPreActivation(): boolean {
  return envFlag('EBICS_ALLOW_PREACTIVATION');
}

export type HacFormat = 'legacy' | 'pain.002';

/**
 * Order data format of HAC (customer acknowledgement) downloads.
 *
 * - `legacy` (default): the original test-server `HACResponseOrderData` listing.
 * - `pain.002`: the pain.002.001.03 customer protocol real banks send, rendered
 *   from the HAC event ledger (see docs/HAC_PLAN.md). Required by clients that
 *   parse HAC.
 *
 * The event ledger itself is always recorded; this flag only selects the output.
 *
 * Enable with `EBICS_HAC_FORMAT=pain.002`.
 */
export function hacFormat(): HacFormat {
  return process.env['EBICS_HAC_FORMAT'] === 'pain.002' ? 'pain.002' : 'legacy';
}

/**
 * When true, credit transfer uploads that request a distributed electronic
 * signature (`BTUOrderParams/SignatureFlag/@requestEDS="true"`) are held in the
 * VEU until an admin releases, cancels or rejects them — like a real bank that
 * waits for the second signature. Nothing is booked while an order is held.
 *
 * Default (false) keeps the original behaviour: every upload is executed and
 * booked immediately.
 *
 * Enable with `EBICS_EDS_HOLD=true`.
 */
export function edsHold(): boolean {
  return envFlag('EBICS_EDS_HOLD');
}

export type VopStatus = 'RCVC' | 'RVMC' | 'RVNM' | 'RVNA';
const VOP_STATUSES: readonly VopStatus[] = ['RCVC', 'RVMC', 'RVNM', 'RVNA'];

/**
 * Verification of Payee result for creditors whose IBAN is not held at this bank
 * (their name cannot be checked locally). Creditors held here are matched against
 * the account owner's name instead.
 *
 * Default `RCVC` (match). Set `EBICS_VOP_DEFAULT` to `RVMC`, `RVNM` or `RVNA`.
 */
export function vopDefaultStatus(): VopStatus {
  const value = process.env['EBICS_VOP_DEFAULT'] as VopStatus | undefined;
  return value && VOP_STATUSES.includes(value) ? value : 'RCVC';
}

/**
 * When true, BTD and administrative downloads (except HAC and PTK themselves) append a FILE_DOWNLOAD
 * event to the HAC ledger, like banks whose customer protocol also lists downloads.
 *
 * Enable with `EBICS_HAC_DOWNLOAD_EVENTS=true`.
 */
export function hacDownloadEvents(): boolean {
  return envFlag('EBICS_HAC_DOWNLOAD_EVENTS');
}

/**
 * When true, credit transfers whose Verification of Payee result is not a full match (RCVC) are held
 * in the VEU until someone confirms them with an electronic signature (HVE) or an admin releases
 * them. Default (false): orders are executed regardless of the VoP result.
 *
 * Enable with `EBICS_VOP_CONFIRMATION=true`.
 */
export function vopConfirmationRequired(): boolean {
  return envFlag('EBICS_VOP_CONFIRMATION');
}

/**
 * When true, wssparam hands out one-time tokens (OTT "Y"): each token opens a single WebSocket connection.
 * Default (false): tokens (OTT "N") can reconnect until their VALIDITY ends.
 *
 * Enable with `EBICS_WSS_ONE_TIME_TOKEN=true`.
 */
export function wssOneTimeTokens(): boolean {
  return envFlag('EBICS_WSS_ONE_TIME_TOKEN');
}
