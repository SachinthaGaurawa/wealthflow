/* statement-subscriptions.mjs — the email worker's name for wealthflow-sub-identity.js: which subscription (or bill) does a statement payment belong to?
 * The rule lives in ONE file the page loads too (window.WFSubIdentity), so the manual upload and the email worker cannot drift apart. */
export * from './wealthflow-sub-identity.js';
export { default } from './wealthflow-sub-identity.js';
