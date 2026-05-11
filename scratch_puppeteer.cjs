const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    await page.goto('http://127.0.0.1:8083', { waitUntil: 'networkidle0' });
    
    const result = await page.evaluate(async () => {
        try {
            const blob = new Blob(['test pdf content'], { type: 'application/pdf' });
            return await window._uploadViaPublicCloud(blob, 'test.pdf');
        } catch (e) {
            return { error: e.message, stack: e.stack };
        }
    });
    
    console.log("RESULT:", result);
    await browser.close();
})();
