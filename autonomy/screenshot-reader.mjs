// autonomy/screenshot-reader.mjs moved to ../wf-screenshot-reader.mjs on 2026-11-05.
// Reason: autonomy/ is on .vercelignore, so a Vercel function that imported it
// threw ERR_MODULE_NOT_FOUND in production (test/serverless_bundle_test.js).
// This file keeps every CI tool and test that imports the old path working.
export * from '../wf-screenshot-reader.mjs';
