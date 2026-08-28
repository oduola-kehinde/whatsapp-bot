const express = require('express');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3000;

let lastQR = null;
let isReady = false;

app.get('/', async (req,res)=>{
  res.send(
  <html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  body{font-family:Arial;text-align:center;background:#f0f2f5;padding:20px}
  #qr{width:280px;height:280px;background:white;margin:20px auto;display:flex;align-items:center;justify-content:center;border-radius:15px}
  </style></head><body>
  <h2>WhatsApp Bot Dashboard</h2>
  <div id="qr">${isReady ? '<h1>Bot Ready</h1>' : lastQR ? '<img style="width:100%" src="'+lastQR+'">' : 'Waiting for QR... refresh in 5 sec'}</div>
  <div id="status">${isReady ? 'Connected' : 'Scan QR'}</div>
  <script>setTimeout(()=>location.reload(),5000)</script>
  </body></html>
  );
});

app.get('/status', (req,res)=> res.json({qr:lastQR, ready:isReady}));

app.listen(PORT, ()=> console.log('Server on '+PORT));

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
});

client.on('qr', async (qr) => {
    lastQR = await qrcode.toDataURL(qr);
    console.log('QR READY');
});
client.on('ready', () => { isReady = true; console.log('BOT READY'); });
client.on('message', async msg => {
    // your bot logic
});
client.initialize();