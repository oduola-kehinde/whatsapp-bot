const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
let lastQR = null;
let isReady = false;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
});

client.on('qr', async (qr) => {
    lastQR = await qrcode.toDataURL(qr);
    console.log('QR updated');
});
client.on('ready', () => { isReady = true; console.log('READY'); });
client.initialize();

// for phone app
app.get('/status', (req,res) => res.json({ qr: lastQR, ready: isReady }));
app.listen(3000, '0.0.0.0', () => console.log('Dashboard on http://localhost:3000'));