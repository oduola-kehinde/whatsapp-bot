const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

class BaileysClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.sock = null;
    this.baileys = null;
    this.started = false;
    this.stopping = false;
    this.authDir = options.authDir || path.join(process.cwd(), ".baileys_auth");
    this.reconnectTimer = null;
    this.statusSeen = new Set();
    this.logger = pino({ level: "silent" });
  }

  async loadBaileys() {
    if (!this.baileys) {
      this.baileys = await import("@whiskeysockets/baileys");
    }
    return this.baileys;
  }

  normalizeJid(value) {
    const raw = String(value || "").trim();

    if (!raw) return "";

    if (
      raw.endsWith("@s.whatsapp.net") ||
      raw.endsWith("@g.us") ||
      raw.endsWith("@broadcast") ||
      raw === "status@broadcast"
    ) {
      return raw;
    }

    const number = raw.replace(/[^\d]/g, "");
    return number ? `${number}@s.whatsapp.net` : "";
  }

  getMessageText(message) {
    const content = message?.message;
    if (!content) return "";

    return String(
      content.conversation ||
      content.extendedTextMessage?.text ||
      content.imageMessage?.caption ||
      content.videoMessage?.caption ||
      content.documentMessage?.caption ||
      content.buttonsResponseMessage?.selectedDisplayText ||
      content.listResponseMessage?.title ||
      content.templateButtonReplyMessage?.selectedDisplayText ||
      ""
    ).trim();
  }

  wrapMessage(message) {
    const key = message?.key || {};
    const remoteJid = key.remoteJid || "";

    return {
      raw: message,
      id: key,
      from: remoteJid,
      to: this.sock?.user?.id || "",
      author: key.participant || remoteJid,
      body: this.getMessageText(message),
      isStatus: remoteJid === "status@broadcast",

      async reply(text) {
        if (!remoteJid || remoteJid === "status@broadcast") return null;

        return this._client.sock.sendMessage(
          remoteJid,
          { text: String(text) },
          { quoted: message }
        );
      },

      async react(reaction) {
        if (!key?.id) return null;

        const participant = key.participant;
        const statusJidList = participant ? [participant] : [];

        if (typeof this._client.sock.sendReaction === "function") {
          return this._client.sock.sendReaction(
            "status@broadcast",
            key,
            String(reaction || "❤️"),
            { statusJidList }
          );
        }

        return this._client.sock.sendMessage(
          "status@broadcast",
          {
            react: {
              text: String(reaction || "❤️"),
              key
            }
          },
          { statusJidList }
        );
      }
    };
  }

  async resolveStatusOwner(jid) {
    if (!jid) return null;
    if (!String(jid).endsWith('@lid')) return jid;
    try {
      const mapping = this.sock?.signalRepository?.lidMapping;
      if (mapping && typeof mapping.getPNForLID === 'function') {
        const pn = await mapping.getPNForLID(jid);
        if (pn) {
          console.log('[STATUS] LID -> PN:', jid, '=>', pn);
          return pn;
        }
      }
    } catch (error) {
      console.log('[STATUS] LID mapping error:', error?.message || error);
    }
    return jid;
  }

  async resolveStatusOwners(key) {
    if (!key) return [];
    const owners = [];
    const add = (jid) => {
      if (!jid) return;
      if (!owners.includes(jid)) owners.push(jid);
    };

    add(key?.participantAlt);
    add(key?.participant);

    const lid = key?.participant || key?.participantAlt;

    if (lid && String(lid).endsWith("@lid")) {
      try {
        const mapping = this.sock?.signalRepository?.lidMapping;

        if (mapping && typeof mapping.getPNForLID === "function") {
          const pn = await mapping.getPNForLID(lid);

          if (pn) {
            console.log("[STATUS] LID -> PN:", lid, "=>", pn);
            add(pn);
          }
        }
      } catch (error) {
        console.log("[STATUS] LID mapping error:", error?.message || error);
      }
    }

    return owners;
  }

  async handleStatus(message) {
    const key = message?.key;

    if (!key?.id || key.remoteJid !== "status@broadcast") return;

    const uniqueKey = JSON.stringify({
      remoteJid: key.remoteJid,
      id: key.id,
      participant: key.participant || null,
      participantAlt: key.participantAlt || null
    });

    if (this.statusSeen.has(uniqueKey)) return;

    console.log("");
    console.log("========== STATUS AUTO ==========");
    console.log("[STATUS] ID:", key.id);
    console.log("[STATUS] PARTICIPANT:", key.participant || "none");
    console.log("[STATUS] PARTICIPANT ALT:", key.participantAlt || "none");

    const owners = await this.resolveStatusOwners(key);

    console.log("[STATUS] OWNER CANDIDATES:", JSON.stringify(owners));

    let viewed = false;

    try {
      if (typeof this.sock.readMessages === "function") {
        const readKeys = [{ ...key }];

        if (key.participantAlt) {
          readKeys.push({
            ...key,
            participant: key.participantAlt
          });
        }

        await this.sock.readMessages(readKeys);

        viewed = true;

        console.log(
          "[STATUS VIEW] READ RECEIPT SENT:",
          readKeys.length,
          "KEY(S)"
        );
      }
    } catch (error) {
      console.error("[STATUS VIEW ERROR]", error?.message || error);
    }

    const reaction = String.fromCodePoint(0x2764, 0xFE0F);
    let liked = false;

    for (const owner of owners) {
      if (liked) break;

      const options = {
        statusJidList: [owner]
      };

      try {
        console.log("[STATUS LIKE] TRYING OWNER:", owner);

        if (typeof this.sock.sendMessage === "function") {
          const result = await this.sock.sendMessage(
            "status@broadcast",
            {
              react: {
                text: reaction,
                key
              }
            },
            options
          );

          console.log(
            "[STATUS LIKE] sendMessage RESULT:",
            JSON.stringify(result || {})
          );

          liked = true;

          console.log(
            "[STATUS LIKE] SUCCESS:",
            reaction,
            "OWNER:",
            owner
          );
        }
      } catch (error) {
        console.error(
          "[STATUS LIKE] sendMessage ERROR:",
          owner,
          error?.message || error
        );
      }

      if (!liked && typeof this.sock.sendReaction === "function") {
        try {
          console.log("[STATUS LIKE] TRYING sendReaction:", owner);

          const result = await this.sock.sendReaction(
            "status@broadcast",
            key,
            reaction,
            options
          );

          console.log(
            "[STATUS LIKE] sendReaction RESULT:",
            JSON.stringify(result || {})
          );

          liked = true;

          console.log(
            "[STATUS LIKE] SUCCESS:",
            reaction,
            "OWNER:",
            owner
          );
        } catch (error) {
          console.error(
            "[STATUS LIKE] sendReaction ERROR:",
            owner,
            error?.message || error
          );
        }
      }
    }

    if (viewed || liked) {
      this.statusSeen.add(uniqueKey);
    }

    console.log(
      "[STATUS RESULT]",
      JSON.stringify({
        viewed,
        liked,
        owners
      })
    );

    console.log("================================");
    console.log("");
  }

  async initialize() {
    if (this.started) return;

    this.started = true;
    this.stopping = false;

    fs.mkdirSync(this.authDir, { recursive: true });

    const baileys = await this.loadBaileys();

    const makeWASocket =
      baileys.default ||
      baileys.makeWASocket;

    const {
      useMultiFileAuthState,
      DisconnectReason,
      Browsers
    } = baileys;

    const { state, saveCreds } =
      await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      logger: this.logger,
      browser: Browsers?.windows?.("Chrome") || ["Windows", "Chrome", "1.0.0"],
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        console.log("");
        console.log("========== WHATSAPP QR ==========");
        qrcode.generate(qr, { small: true });
        console.log("=================================");
        console.log("");

        this.emit("qr", qr);
      }

      if (connection === "connecting") {
        this.emit("change_state", "CONNECTING");
      }

      if (connection === "open") {
        const user = this.sock.user || {};

        console.log("");
        console.log("========================================");
        console.log("           WHATSAPP READY");
        console.log("========================================");
        console.log("ID:", user.id || "unknown");
        console.log("NAME:", user.name || "unknown");
        console.log("========================================");
        console.log("");

        this.emit("authenticated");
        this.emit("ready", {
          id: user.id,
          name: user.name,
          verifiedName: user.verifiedName
        });

        this.emit("change_state", "CONNECTED");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason?.loggedOut;

        console.log(
          "WhatsApp connection closed.",
          "statusCode:",
          statusCode,
          "loggedOut:",
          loggedOut
        );

        this.emit("disconnected", loggedOut ? "LOGGED_OUT" : "CONNECTION_CLOSED");
        this.emit("change_state", loggedOut ? "LOGGED_OUT" : "DISCONNECTED");

        if (!loggedOut && !this.stopping) {
          clearTimeout(this.reconnectTimer);

          this.reconnectTimer = setTimeout(() => {
            this.reconnect().catch((error) => {
              console.error(
                "Baileys reconnect error:",
                error?.message || error
              );
            });
          }, 3000);
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages || []) {
        if (!message?.key?.remoteJid) continue;

        if (message.key.remoteJid === "status@broadcast") {
          await this.handleStatus(message);
        }

        const wrapped = this.wrapMessage(message);
        wrapped._client = this;

        this.emit("message", wrapped);
      }
    });

    this.sock.ev.on("error", (error) => {
      console.error("Baileys socket error:", error);
      this.emit("error", error);
    });
  }

  async reconnect() {
    if (this.stopping) return;

    this.started = false;

    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners();
        this.sock.end?.(new Error("reconnecting"));
      }
    } catch {}

    this.sock = null;

    await this.initialize();
  }

  async destroy() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);

    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners();
        this.sock.end?.(undefined);
      }
    } catch {}

    this.sock = null;
    this.started = false;
  }

  async isRegisteredUser(number) {
    if (!this.sock) return false;

    const jid = this.normalizeJid(number);

    if (!jid) return false;

    try {
      const result = await this.sock.onWhatsApp(jid);

      return Boolean(
        Array.isArray(result) &&
        result[0] &&
        result[0].exists
      );
    } catch (error) {
      console.error(
        "isRegisteredUser error:",
        error?.message || error
      );

      return false;
    }
  }

  async sendMessage(jid, text) {
    if (!this.sock) {
      throw new Error("WhatsApp socket is not connected");
    }

    const normalized = this.normalizeJid(jid);

    if (!normalized) {
      throw new Error("Invalid WhatsApp number");
    }

    return this.sock.sendMessage(
      normalized,
      { text: String(text || "") }
    );
  }
}

module.exports = {
  BaileysClient
};


