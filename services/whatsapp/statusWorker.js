const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const pino = require("pino");

const AUTH_DIR = path.join(__dirname, "..", "..", ".baileys_status_auth");

async function startStatusWorker() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
  } = await import("@whiskeysockets/baileys");

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Status Worker", "Chrome", "1.0.0"],
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("");
      console.log("========================================");
      console.log("STATUS WORKER QR CODE");
      console.log("========================================");

      try {
        await qrcode.toFile(
          path.join(__dirname, "..", "..", "status-worker-qr.png"),
          qr,
          { width: 500 }
        );

        console.log("QR saved to:");
        console.log(path.join(__dirname, "..", "..", "status-worker-qr.png"));
      } catch (err) {
        console.log("Could not save QR:", err.message);
      }

      console.log("Scan this QR with the WhatsApp account");
      console.log("that should automatically view/react to Statuses.");
      console.log("========================================");
      console.log("");
    }

    if (connection === "open") {
      console.log("");
      console.log("========================================");
      console.log("STATUS WORKER CONNECTED");
      console.log("========================================");
      console.log("Status view automation: READY");
      console.log("Status reaction automation: READY");
      console.log("========================================");
      console.log("");
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode;

      console.log("");
      console.log("[STATUS WORKER] DISCONNECTED:", code || "unknown");

      if (code !== DisconnectReason.loggedOut) {
        console.log("[STATUS WORKER] Reconnecting...");
        setTimeout(startStatusWorker, 3000);
      } else {
        console.log("[STATUS WORKER] Logged out. QR pairing required.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!messages || !messages.length) return;

    for (const message of messages) {
      try {
        const key = message?.key;

        if (!key) continue;

        if (key.remoteJid !== "status@broadcast") continue;

        const participant = key.participant;

        console.log("");
        console.log("========================================");
        console.log("[STATUS WORKER] NEW STATUS");
        console.log("[STATUS WORKER] ID:", key.id || "unknown");
        console.log("[STATUS WORKER] OWNER:", participant || "unknown");
        console.log("========================================");

        if (!participant || !key.id) {
          console.log("[STATUS WORKER] Missing Status key/participant.");
          continue;
        }

        /*
         * Mark this exact Status message as read.
         */
        try {
          await sock.readMessages([key]);
          console.log("[STATUS VIEW] READ REQUEST SENT");
        } catch (err) {
          console.log(
            "[STATUS VIEW] FAILED:",
            err?.message || err
          );
        }

        /*
         * React to this exact Status.
         */
        try {
          const reaction = process.env.STATUS_REACTION || "❤️";

          await sock.sendReaction(
            "status@broadcast",
            key,
            reaction,
            {
              statusJidList: [participant]
            }
          );

          console.log(
            "[STATUS REACTION] REQUEST SENT:",
            reaction
          );
        } catch (err) {
          console.log(
            "[STATUS REACTION] FAILED:",
            err?.message || err
          );
        }

        console.log("========================================");
        console.log("");
      } catch (err) {
        console.log(
          "[STATUS WORKER ERROR]",
          err?.message || err
        );
      }
    }
  });

  return sock;
}

startStatusWorker().catch((err) => {
  console.error("");
  console.error("STATUS WORKER FAILED");
  console.error(err);
});
