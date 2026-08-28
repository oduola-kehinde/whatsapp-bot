const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

let lastQR = null;
let isReady = false;

// --- Start Express Server inside Electron ---
const server = express();
server.use(cors());
server.use(express.static(__dirname));

server.get('/status', (req,res) => {
  res.json({ qr: lastQR, ready: isReady });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Dashboard running on http://localhost:3000');
});

// --- WhatsApp Bot ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
});

client.on('qr', async (qr) => {
    lastQR = await qrcode.toDataURL(qr);
    console.log('New QR ready - scan in app window');
});

client.on('ready', () => { 
    isReady = true; 
    console.log('✅ Bot is READY'); 
});

client.on('message', async msg => {
    // your bot logic here
    // if (msg.body == '!ping') msg.reply('pong');
});

client.initialize();

// --- Create Window ---
function createWindow() {
  const win = new BrowserWindow({
    width: 450,
    height: 750,
    icon: path.join(__dirname, 'icon.png')
  });
  win.loadURL('http://localhost:3000');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());