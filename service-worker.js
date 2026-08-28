// =============================================================================
// service-worker.js — Transparent Proxy & Entrypoint to sw.js
// -----------------------------------------------------------------------------
// Some PWA scanners and web views probe for /service-worker.js by default.
// This imports and executes the canonical WealthFlow Service Worker (sw.js).
// =============================================================================

importScripts('/sw.js');
