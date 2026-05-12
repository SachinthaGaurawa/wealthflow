const fs = require('fs');

async function testFilebin() {
    const binId = 'wf' + Date.now();
    const filename = 'Statement.json';
    
    console.log(`Uploading to filebin.net/${binId}/${filename}...`);
    const fileBuf = fs.readFileSync('manifest.json');

    const uRes = await fetch(`https://filebin.net/${binId}/${filename}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: fileBuf
    });
    
    if(uRes.ok) {
        const uData = await uRes.json();
        console.log("Success:", uData.bin.id);
        console.log("URL:", `https://filebin.net/${uData.bin.id}/${filename}`);
    } else {
        console.log("Failed:", uRes.status, await uRes.text());
    }
}

testFilebin().catch(console.error);
