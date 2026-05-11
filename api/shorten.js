export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        const encoded = encodeURIComponent(url);
        
        // Try is.gd
        try {
            const r1 = await fetch('https://is.gd/create.php?format=json&url=' + encoded);
            const d1 = await r1.json();
            if (d1.shorturl) return res.status(200).json({ shortUrl: d1.shorturl });
        } catch(e) {}

        // Try v.gd
        try {
            const r2 = await fetch('https://v.gd/create.php?format=json&url=' + encoded);
            const d2 = await r2.json();
            if (d2.shorturl) return res.status(200).json({ shortUrl: d2.shorturl });
        } catch(e) {}
        
        // Try TinyURL
        try {
            const r3 = await fetch('https://tinyurl.com/api-create.php?url=' + encoded);
            const text3 = await r3.text();
            if (text3.startsWith('http')) return res.status(200).json({ shortUrl: text3 });
        } catch(e) {}

        // Fallback
        res.status(200).json({ shortUrl: url });
    } catch (error) {
        res.status(500).json({ error: error.message, shortUrl: url });
    }
}
