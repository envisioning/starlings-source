// The wire contract lives in the shared workspace package so the web client
// compiles against the same shapes. This shim keeps Worker-internal imports
// (`./contracts`) stable.
export * from '@starlings/contracts';
