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
