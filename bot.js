const {
    Client,
    LocalAuth
} = require("whatsapp-web.js");

const qrcode = require("qrcode-terminal");

let lastQR = null;
let isReady = false;
let clientInfo = null;
let connectionState = "STARTING";

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "main-bot"
    }),

    puppeteer: {
        headless: true,

        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-zygote"
        ]
    }
});

/*
|--------------------------------------------------------------------------
| QR CODE
|--------------------------------------------------------------------------
*/

client.on("qr", (qr) => {
    lastQR = qr;
    isReady = false;
    connectionState = "QR_REQUIRED";

    console.log("");
    console.log("==================================================");
    console.log("SCAN THIS QR CODE WITH WHATSAPP");
    console.log("==================================================");
    console.log("");

    qrcode.generate(qr, {
        small: true
    });

    console.log("");
    console.log("Or open http://localhost:3000 in your browser.");
    console.log("");
});

/*
|--------------------------------------------------------------------------
| AUTHENTICATED
|--------------------------------------------------------------------------
*/

client.on("authenticated", () => {
    connectionState = "AUTHENTICATED";
    console.log("WhatsApp authentication successful.");
});

/*
|--------------------------------------------------------------------------
| READY
|--------------------------------------------------------------------------
*/

client.on("ready", () => {
    isReady = true;
    lastQR = null;
    connectionState = "READY";

    clientInfo = {
        pushname: client.info?.pushname || null,
        wid: client.info?.wid?.user || null,
        platform: client.info?.platform || null
    };

    console.log("");
    console.log("==================================================");
    console.log("WHATSAPP BOT IS READY");
    console.log("==================================================");
    console.log("Account:", clientInfo.pushname || "Unknown");
    console.log("Number:", clientInfo.wid || "Unknown");
    console.log("");
});

/*
|--------------------------------------------------------------------------
| AUTH FAILURE
|--------------------------------------------------------------------------
*/

client.on("auth_failure", (message) => {
    isReady = false;
    connectionState = "AUTH_FAILURE";

    console.error("WhatsApp authentication failure:");
    console.error(message);
});

/*
|--------------------------------------------------------------------------
| DISCONNECTED
|--------------------------------------------------------------------------
*/

client.on("disconnected", (reason) => {
    isReady = false;
    connectionState = "DISCONNECTED";

    console.log("WhatsApp disconnected:", reason);
});

/*
|--------------------------------------------------------------------------
| MESSAGE HANDLER
|--------------------------------------------------------------------------
*/

client.on("message", async (message) => {
    try {
        const text = (message.body || "").trim();

        if (!text) {
            return;
        }

        console.log(
            `[MESSAGE] ${message.from}: ${text}`
        );

        /*
        |--------------------------------------------------------------------------
        | Basic commands
        |--------------------------------------------------------------------------
        */

        if (text.toLowerCase() === "!ping") {
            await message.reply("pong");
            return;
        }

        if (text.toLowerCase() === "!help") {
            await message.reply(
                "WhatsApp Bot Commands\n\n" +
                "!ping - Test the bot\n" +
                "!help - Show this help message\n" +
                "!status - Show bot status"
            );
            return;
        }

        if (text.toLowerCase() === "!status") {
            await message.reply(
                isReady
                    ? "Bot is online and connected."
                    : "Bot is currently not ready."
            );
            return;
        }

        /*
        |--------------------------------------------------------------------------
        | Add your own automation here.
        |--------------------------------------------------------------------------
        |
        | Example:
        |
        | if (text.toLowerCase() === "hello") {
        |     await message.reply("Hello! How can I help?");
        | }
        |
        |--------------------------------------------------------------------------
        */
    }
    catch (error) {
        console.error("Message handler error:", error);
    }
});

/*
|--------------------------------------------------------------------------
| CLIENT ERROR
|--------------------------------------------------------------------------
*/

client.on("error", (error) => {
    console.error("WhatsApp client error:", error);
});

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

console.log("Starting WhatsApp client...");

client.initialize();

module.exports = {
    client,

    getStatus: () => ({
        ready: isReady,
        state: connectionState,
        qr: lastQR,
        info: clientInfo
    })
};
