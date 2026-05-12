// ==================== WealthFlow AI Engine v6.3 ====================
// Triple-engine AI with automatic failover (Gemini · DeepSeek · Groq).
// IMPORTANT: All API keys MUST be configured as Vercel Environment Variables.
// We do NOT keep hardcoded fallbacks — they are a security liability.
//   - WealthFlow_API_Key  (Gemini)
//   - DEEPSEEK_API_KEY    (DeepSeek)
//   - GROQ_API_KEY        (Groq)

export const config = {
    maxDuration: 45 // seconds — increased for richer responses
};

// Helper: fetch with timeout — prevents one slow provider from blocking the chain
async function fetchWithTimeout(url, options, timeoutMs = 18000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req, res) {
    // CORS — allow the public Vercel deployment to be called from anywhere
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { prompt, image, temperature, maxTokens } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Pull keys ONLY from environment — no hardcoded fallbacks
    const geminiKey = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;

    const temp = (typeof temperature === 'number') ? temperature : 0.7;
    const tokens = (typeof maxTokens === 'number') ? maxTokens : 2500;

    // ---------- ENGINE 1: GEMINI (Primary, supports vision) ----------
    async function fetchGemini() {
        if (!geminiKey) throw new Error('Gemini key not configured');
        const model = image ? 'gemini-2.0-flash' : 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

        const parts = [{ text: prompt }];
        if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });

        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: { temperature: temp, maxOutputTokens: tokens },
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Gemini status ${response.status}: ${errText.substring(0, 200)}`);
        }

        const data = await response.json();
        if (data.promptFeedback?.blockReason) throw new Error('Blocked by Google Safety');
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { reply: text, provider: 'gemini' };
        throw new Error('Gemini returned an empty response');
    }

    // ---------- ENGINE 2: DEEPSEEK (Fallback, text-only) ----------
    async function fetchDeepSeek() {
        if (image) throw new Error('DeepSeek skipped (text-only)');
        if (!deepseekKey) throw new Error('DeepSeek key not configured');

        const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${deepseekKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                temperature: temp,
                max_tokens: tokens
            })
        });

        if (!response.ok) throw new Error(`DeepSeek status ${response.status}`);
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('DeepSeek returned empty');
        return { reply: text, provider: 'deepseek' };
    }

    // ---------- ENGINE 3: GROQ (Fallback, ultra-fast) ----------
    async function fetchGroq() {
        if (image) throw new Error('Groq skipped (text-only)');
        if (!groqKey) throw new Error('Groq key not configured');

        const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${groqKey}`
            },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: temp,
                max_tokens: tokens
            })
        });

        if (!response.ok) throw new Error(`Groq status ${response.status}`);
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('Groq returned empty');
        return { reply: text, provider: 'groq' };
    }

    // ---------- EXECUTION CHAIN ----------
    const errorLog = [];
    const engines = [
        { name: 'Gemini', fn: fetchGemini },
        { name: 'DeepSeek', fn: fetchDeepSeek },
        { name: 'Groq', fn: fetchGroq }
    ];

    for (const engine of engines) {
        try {
            console.log(`[AI] Attempting ${engine.name}…`);
            const result = await engine.fn();
            console.log(`[AI] ✓ ${engine.name} succeeded`);
            return res.status(200).json({ reply: result.reply, provider: result.provider });
        } catch (e) {
            console.warn(`[AI] ${engine.name} failed:`, e.message);
            errorLog.push(`${engine.name}: ${e.message}`);
        }
    }

    return res.status(503).json({
        error: 'All AI providers are temporarily unavailable.',
        details: errorLog.join(' | ')
    });
}
