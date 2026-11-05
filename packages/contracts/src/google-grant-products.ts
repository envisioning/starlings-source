/**
 * The Google connector grant's products (docs/CONNECTORS.md). Its
 * own module, with no import, so the starlings-auth Worker reads the list
 * without the contracts index. `index.ts` re-exports it.
 */
export const GOOGLE_GRANT_PRODUCTS = ['gmail', 'drive'] as const;
export type GoogleGrantProduct = (typeof GOOGLE_GRANT_PRODUCTS)[number];
