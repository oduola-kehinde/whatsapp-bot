const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
require("dotenv").config();

const workerId = process.env.WORKER_ID || "worker-1";

console.log("");
console.log("======================================");
console.log(" WHATSAPP AUTOMATION PLATFORM");
console.log(" WHATSAPP WORKER");
console.log("======================================");
console.log("Worker:", workerId);
console.log("Starting WhatsApp client...");
console.log("");

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: workerId
    }),
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
        ]
    }
});

client.on("qr", qr => {
    console.log("");
    console.log("======================================");
    console.log(" SCAN THIS QR WITH WHATSAPP");
    console.log("======================================");

    qrcode.generate(qr, {
        small: true
    });

    console.log("");
});

client.on("authenticated", () => {
    console.log("WhatsApp authentication successful.");
});

client.on("ready", async () => {
    console.log("");
    console.log("======================================");
    console.log(" WHATSAPP CONNECTED");
    console.log("======================================");

    try {
        const info = client.info;

        console.log("Number:", info?.wid?.user || "unknown");
        console.log("Push name:", info?.pushname || "unknown");
    } catch {}
});

client.on("auth_failure", message => {
    console.error("WhatsApp authentication failure:", message);
});

client.on("disconnected", reason => {
    console.log("WhatsApp disconnected:", reason);
});

client.on("message", async message => {
    console.log(
        "MESSAGE",
        message.from,
        ":",
        message.body
    );

    // Automation rules will be connected to the database here.
    //
    // Example future flow:
    //
    // incoming message
    //       ↓
    // find WhatsApp account
    //       ↓
    // save message
    //       ↓
    // find matching automation rule
    //       ↓
    // send configured reply
});

client.initialize().catch(error => {
    console.error("Worker initialization failed:");
    console.error(error);
});
