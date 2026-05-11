// ==================== WealthFlow → PDF Share Upload Proxy ====================
// Server-side proxy that receives a base64-encoded PDF from the browser
// and uploads it to a public file hosting service, bypassing all CORS restrictions.
//
// This runs on Vercel as a serverless function at /api/share-upload
// The browser sends: POST { base64, fileName }
// The server returns: { url, permanent }
//
// Upload targets (tried in order):
//   1. file.io       — instant, direct link, 14-day expiry
//   2. 0x0.st        — permanent, direct link
//   3. tmpfiles.org   — 60-min expiry, direct link

export const config = {
    maxDuration: 15
};

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { base64, fileName } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'Missing base64 data' });

    const buffer = Buffer.from(base64, 'base64');
    const fname = fileName || `WealthFlow_Statement_${Date.now()}.pdf`;
    const errors = [];

    // ── STRATEGY 1: file.io (simple, reliable, 14-day expiry) ──
    try {
        const boundary = '----WFBoundary' + Date.now();
        const bodyParts = [
            `--${boundary}\r\n`,
            `Content-Disposition: form-data; name="file"; filename="${fname}"\r\n`,
            `Content-Type: application/pdf\r\n\r\n`,
        ];
        const headerBuf = Buffer.from(bodyParts.join(''));
        const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([headerBuf, buffer, footerBuf]);

        const resp = await fetchWithTimeout('https://file.io', {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: body
        }, 8000);

        if (resp.ok) {
            const data = await resp.json();
            if (data.success && data.link) {
                return res.status(200).json({ url: data.link, permanent: false, service: 'file.io' });
            }
        }
        errors.push('file.io: status ' + resp.status);
    } catch (e) {
        errors.push('file.io: ' + e.message);
    }

    // ── STRATEGY 2: 0x0.st (permanent, ultra-simple) ──
    try {
        const boundary = '----WFBoundary' + Date.now() + 'b';
        const bodyParts = [
            `--${boundary}\r\n`,
            `Content-Disposition: form-data; name="file"; filename="${fname}"\r\n`,
            `Content-Type: application/pdf\r\n\r\n`,
        ];
        const headerBuf = Buffer.from(bodyParts.join(''));
        const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([headerBuf, buffer, footerBuf]);

        const resp = await fetchWithTimeout('https://0x0.st', {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: body
        }, 8000);

        if (resp.ok) {
            const url = (await resp.text()).trim();
            if (url.startsWith('http')) {
                return res.status(200).json({ url, permanent: true, service: '0x0.st' });
            }
        }
        errors.push('0x0.st: status ' + resp.status);
    } catch (e) {
        errors.push('0x0.st: ' + e.message);
    }

    // ── STRATEGY 3: tmpfiles.org ──
    try {
        const boundary = '----WFBoundary' + Date.now() + 'c';
        const bodyParts = [
            `--${boundary}\r\n`,
            `Content-Disposition: form-data; name="file"; filename="${fname}"\r\n`,
            `Content-Type: application/pdf\r\n\r\n`,
        ];
        const headerBuf = Buffer.from(bodyParts.join(''));
        const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([headerBuf, buffer, footerBuf]);

        const resp = await fetchWithTimeout('https://tmpfiles.org/api/v1/upload', {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: body
        }, 8000);

        if (resp.ok) {
            const data = await resp.json();
            if (data.data && data.data.url) {
                const url = data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                return res.status(200).json({ url, permanent: false, service: 'tmpfiles.org' });
            }
        }
        errors.push('tmpfiles: status ' + resp.status);
    } catch (e) {
        errors.push('tmpfiles: ' + e.message);
    }

    // All failed
    console.error('[share-upload] All services failed:', errors);
    return res.status(502).json({
        error: 'All upload services failed',
        details: errors.join('; ')
    });
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
