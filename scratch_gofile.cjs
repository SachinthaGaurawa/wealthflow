const fs = require('fs');

async function testGofile() {
    console.log("Fetching GoFile servers...");
    const sRes = await fetch('https://api.gofile.io/servers');
    const sData = await sRes.json();
    const server = sData.data.servers[0].name;
    console.log("Using server:", server);

    console.log("Uploading file...");
    const formData = new FormData();
    const fileBuf = fs.readFileSync('manifest.json');
    const blob = new Blob([fileBuf], { type: 'application/json' });
    formData.append('file', blob, 'manifest.json');

    const uRes = await fetch(`https://${server}.gofile.io/contents/uploadfile`, {
        method: 'POST',
        body: formData
    });
    const uData = await uRes.json();
    console.log(JSON.stringify(uData, null, 2));
}

testGofile().catch(console.error);
