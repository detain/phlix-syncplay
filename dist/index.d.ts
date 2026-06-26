/**
 * @phlix/syncplay — the single shared, canonical implementation of the Phlix
 * SyncPlay wire protocol + NTP time-sync for JS clients (mobile, windows,
 * tizen). Framework-agnostic; transport and clock are injected.
 *
 * The server (`phlix-server` `src/Session/SyncPlay/*`) is the source of truth;
 * see SPEC.md for the full wire-protocol documentation.
 */
export * from './messages';
export * from './framing';
export * from './time-sync';
export * from './client';
