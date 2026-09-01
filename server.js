require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");

const { BaileysClient } = require("./services/whatsapp/BaileysClient");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "CHANGE_THIS_JWT_SECRET_BEFORE_PRODUCTION";

const WORKER_ID = process.env.WORKER_ID || "main-bot";
const NODE_ENV = process.env.NODE_ENV || "development";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not configured.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let lastQR = null;
let whatsappReady = false;
let whatsappState = "STARTING";
let whatsappInfo = null;
let whatsappClient = null;
let whatsappStarting = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function getChromeExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          "Google",
          "Chrome",
          "Application",
          "chrome.exe"
        )
      : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {}
  }

  return null;
}

async function query(text, params = []) {
  const client = await pool.connect();

  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(30) DEFAULT 'user',
      balance NUMERIC(14,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(120),
      phone VARCHAR(40),
      session_name VARCHAR(120) UNIQUE,
      status VARCHAR(50) DEFAULT 'STOPPED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      direction VARCHAR(20),
      chat_id VARCHAR(255),
      sender VARCHAR(255),
      recipient VARCHAR(255),
      body TEXT,
      message_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      name VARCHAR(150),
      trigger_type VARCHAR(80),
      trigger_value TEXT,
      action_type VARCHAR(80),
      action_value TEXT,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS media (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
      filename VARCHAR(255),
      mimetype VARCHAR(150),
      data TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  log("Database initialized");
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    });
  }

  const token = header.slice(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token",
    });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Admin access required",
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "WhatsApp Automation API",
    status: "online",
    environment: NODE_ENV,
    whatsapp: whatsappState,
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    server: "online",
    whatsappReady,
    whatsappState,
    whatsappInfo,
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: "Name, email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must contain at least 6 characters",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [normalizedEmail]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        success: false,
        error: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `
      INSERT INTO users (name, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, name, email, role, balance, created_at
      `,
      [name.trim(), normalizedEmail, passwordHash]
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      user,
      token: createToken(user),
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Registration failed",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const result = await query(
      `
      SELECT id, name, email, password_hash, role, balance, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: "Invalid email or password",
      });
    }

    delete user.password_hash;

    res.json({
      success: true,
      user,
      token: createToken(user),
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Login failed",
    });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT id, name, email, role, balance, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    res.json({
      success: true,
      user: result.rows[0],
    });
  } catch (error) {
    console.error("ME ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load profile",
    });
  }
});

app.get("/api/whatsapp/status", authMiddleware, (req, res) => {
  res.json({
    success: true,
    ready: whatsappReady,
    state: whatsappState,
    info: whatsappInfo,
    hasQR: Boolean(lastQR),
  });
});

app.get("/api/whatsapp/qr", authMiddleware, async (req, res) => {
  try {
    if (!lastQR) {
      return res.status(404).json({
        success: false,
        error: "QR code is not currently available",
      });
    }

    const qrDataUrl = await QRCode.toDataURL(lastQR);

    res.json({
      success: true,
      qr: qrDataUrl,
    });
  } catch (error) {
    console.error("QR ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to generate QR code",
    });
  }
});

app.get("/api/whatsapp/info", authMiddleware, (req, res) => {
  res.json({
    success: true,
    ready: whatsappReady,
    state: whatsappState,
    info: whatsappInfo,
    qrAvailable: Boolean(lastQR),
  });
});

app.post("/api/whatsapp/send", authMiddleware, async (req, res) => {
  try {
    if (!whatsappClient || !whatsappReady) {
      return res.status(503).json({
        success: false,
        error: "WhatsApp is not ready",
      });
    }

    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Recipient and message are required",
      });
    }

    let chatId = String(to).trim();

    if (!chatId.includes("@")) {
      chatId = chatId.replace(/[^\d]/g, "") + "@c.us";
    }

    const sent = await whatsappClient.sendMessage(
      chatId,
      String(message)
    );

    try {
      await query(
        `
        INSERT INTO messages
        (direction, chat_id, recipient, body, message_id)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          "outgoing",
          chatId,
          chatId,
          String(message),
          sent?.id?._serialized || null,
        ]
      );
    } catch (dbError) {
      console.error("MESSAGE DATABASE ERROR:", dbError.message);
    }

    res.json({
      success: true,
      messageId: sent?.id?._serialized || null,
    });
  } catch (error) {
    console.error("SEND MESSAGE ERROR:", error);

    res.status(500).json({
      success: false,
      error: error.message || "Failed to send message",
    });
  }
});

app.get("/api/messages", authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 50, 1),
      500
    );

    const result = await query(
      `
      SELECT *
      FROM messages
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      success: true,
      messages: result.rows,
    });
  } catch (error) {
    console.error("MESSAGES ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load messages",
    });
  }
});

app.get("/api/automation/rules", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT *
      FROM automation_rules
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      rules: result.rows,
    });
  } catch (error) {
    console.error("RULES ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load automation rules",
    });
  }
});

app.post("/api/automation/rules", authMiddleware, async (req, res) => {
  try {
    const {
      whatsapp_account_id,
      name,
      trigger_type,
      trigger_value,
      action_type,
      action_value,
      enabled,
    } = req.body;

    if (!name || !trigger_type || !action_type) {
      return res.status(400).json({
        success: false,
        error: "name, trigger_type and action_type are required",
      });
    }

    const result = await query(
      `
      INSERT INTO automation_rules
      (
        user_id,
        whatsapp_account_id,
        name,
        trigger_type,
        trigger_value,
        action_type,
        action_value,
        enabled
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        req.user.id,
        whatsapp_account_id || null,
        name,
        trigger_type,
        trigger_value || null,
        action_type,
        action_value || null,
        enabled !== false,
      ]
    );

    res.status(201).json({
      success: true,
      rule: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE RULE ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to create automation rule",
    });
  }
});

app.put("/api/automation/rules/:id", authMiddleware, async (req, res) => {
  try {
    const ruleId = Number(req.params.id);

    const {
      name,
      trigger_type,
      trigger_value,
      action_type,
      action_value,
      enabled,
    } = req.body;

    const result = await query(
      `
      UPDATE automation_rules
      SET
        name = COALESCE($1, name),
        trigger_type = COALESCE($2, trigger_type),
        trigger_value = COALESCE($3, trigger_value),
        action_type = COALESCE($4, action_type),
        action_value = COALESCE($5, action_value),
        enabled = COALESCE($6, enabled),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
        AND user_id = $8
      RETURNING *
      `,
      [
        name ?? null,
        trigger_type ?? null,
        trigger_value ?? null,
        action_type ?? null,
        action_value ?? null,
        typeof enabled === "boolean" ? enabled : null,
        ruleId,
        req.user.id,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "Automation rule not found",
      });
    }

    res.json({
      success: true,
      rule: result.rows[0],
    });
  } catch (error) {
    console.error("UPDATE RULE ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to update automation rule",
    });
  }
});

app.delete("/api/automation/rules/:id", authMiddleware, async (req, res) => {
  try {
    const ruleId = Number(req.params.id);

    const result = await query(
      `
      DELETE FROM automation_rules
      WHERE id = $1
        AND user_id = $2
      RETURNING id
      `,
      [ruleId, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "Automation rule not found",
      });
    }

    res.json({
      success: true,
      deleted: true,
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error("DELETE RULE ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to delete automation rule",
    });
  }
});

app.get("/api/accounts", authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        name,
        phone,
        session_name,
        status,
        created_at,
        updated_at
      FROM whatsapp_accounts
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [req.user.id]
    );

    res.json({
      success: true,
      accounts: result.rows,
    });
  } catch (error) {
    console.error("ACCOUNTS ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to load WhatsApp accounts",
    });
  }
});

app.post("/api/accounts", authMiddleware, async (req, res) => {
  try {
    const {
      name,
      phone,
      session_name,
    } = req.body;

    if (!session_name) {
      return res.status(400).json({
        success: false,
        error: "session_name is required",
      });
    }

    const result = await query(
      `
      INSERT INTO whatsapp_accounts
      (user_id, name, phone, session_name, status)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        req.user.id,
        name || null,
        phone || null,
        session_name,
        "STOPPED",
      ]
    );

    res.status(201).json({
      success: true,
      account: result.rows[0],
    });
  } catch (error) {
    console.error("CREATE ACCOUNT ERROR:", error);

    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        error: "Session name already exists",
      });
    }

    res.status(500).json({
      success: false,
      error: "Unable to create WhatsApp account",
    });
  }
});

app.delete("/api/accounts/:id", authMiddleware, async (req, res) => {
  try {
    const accountId = Number(req.params.id);

    const result = await query(
      `
      DELETE FROM whatsapp_accounts
      WHERE id = $1
        AND user_id = $2
      RETURNING id
      `,
      [accountId, req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        error: "WhatsApp account not found",
      });
    }

    res.json({
      success: true,
      deleted: true,
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error("DELETE ACCOUNT ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to delete WhatsApp account",
    });
  }
});

async function runAutomationRules(message) {
  try {
    if (!message) return;

    const body = String(message.body || "").trim();

    if (!body) return;

    const result = await query(
      `
      SELECT *
      FROM automation_rules
      WHERE enabled = TRUE
      ORDER BY id ASC
      `
    );

    for (const rule of result.rows) {
      let matched = false;

      const triggerType = String(rule.trigger_type || "").toLowerCase();
      const triggerValue = String(rule.trigger_value || "");

      if (triggerType === "keyword") {
        matched = body.toLowerCase().includes(
          triggerValue.toLowerCase()
        );
      }

      if (triggerType === "exact") {
        matched = body.toLowerCase() ===
          triggerValue.toLowerCase();
      }

      if (triggerType === "starts_with") {
        matched = body.toLowerCase().startsWith(
          triggerValue.toLowerCase()
        );
      }

      if (!matched) continue;

      const actionType = String(
        rule.action_type || ""
      ).toLowerCase();

      const actionValue = String(
        rule.action_value || ""
      );

      if (
        actionType === "reply" &&
        typeof message.reply === "function"
      ) {
        await message.reply(actionValue);
      }

      if (
        actionType === "send" &&
        whatsappClient &&
        whatsappReady
      ) {
        await whatsappClient.sendMessage(
          message.from,
          actionValue
        );
      }

      log(
        "[AUTOMATION]",
        "Rule",
        rule.id,
        "executed for",
        message.from
      );
    }
  } catch (error) {
    console.error(
      "[AUTOMATION ERROR]",
      error.message || error
    );
  }
}

function setupWhatsAppEvents(client) {
  client.on("qr", (qr) => {
    lastQR = qr;
    whatsappReady = false;
    whatsappState = "QR";

    console.log("");
    console.log("========================================");
    console.log("WHATSAPP QR CODE");
    console.log("========================================");

    qrcodeTerminal.generate(qr, {
      small: true,
    });

    console.log("Scan the QR code with WhatsApp.");
    console.log("========================================");
    console.log("");
  });

  client.on("authenticated", () => {
    whatsappState = "AUTHENTICATED";
    log("WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    whatsappReady = false;
    whatsappState = "AUTH_FAILURE";

    console.error(
      "WHATSAPP AUTH FAILURE:",
      message
    );
  });

  client.on("ready", () => {
    whatsappReady = true;
    whatsappState = "READY";
    lastQR = null;

    try {
      whatsappInfo = client.info
        ? {
            wid: client.info.wid?._serialized || null,
            pushname: client.info.pushname || null,
            platform: client.info.platform || null,
          }
        : null;
    } catch (_) {
      whatsappInfo = null;
    }

    console.log("");
    console.log("========================================");
    console.log("WHATSAPP READY");
    console.log("========================================");

    if (whatsappInfo) {
      console.log(
        "Account:",
        whatsappInfo.wid || "unknown"
      );

      console.log(
        "Name:",
        whatsappInfo.pushname || "unknown"
      );

      console.log(
        "Platform:",
        whatsappInfo.platform || "unknown"
      );
    }

    console.log("========================================");
    console.log("");
  });

  client.on("change_state", (state) => {
    whatsappState = String(state || "UNKNOWN");

    log(
      "[WHATSAPP STATE]",
      whatsappState
    );
  });

  client.on("disconnected", (reason) => {
    whatsappReady = false;
    whatsappState = "DISCONNECTED";

    log(
      "WHATSAPP DISCONNECTED:",
      reason
    );

    whatsappInfo = null;
  });


/* STATUS_AUTO_VIEW_REACTION_V3 */

async function autoViewAndReactToStatus(message) {
  try {
    if (!message) return;

    const isStatus =
      message.isStatus === true ||
      message.from === "status@broadcast" ||
      message.id?.remote === "status@broadcast";

    if (!isStatus) return;

    const id = message.id || {};

    const statusKey = {
      fromMe: Boolean(id.fromMe),
      remote: id.remote || "status@broadcast",
      id: id.id || id.$2 || null,
      participant: id.participant || message.author || null
    };

    console.log('');
    console.log('========== STATUS V3 ==========' );
    console.log('[STATUS V3] KEY:', JSON.stringify(statusKey));
    console.log('[STATUS V3] OWNER:', statusKey.participant || 'unknown');

    if (!statusKey.id || !statusKey.participant) {
      console.log('[STATUS V3] Missing Status key/participant');
      return;
    }

    const page = whatsappClient && whatsappClient.pupPage;

    if (!page) {
      console.log('[STATUS V3] WhatsApp page unavailable');
      return;
    }

    const result = await page.evaluate(async (key, reaction) => {
      try {
        const collections = window.require('WAWebCollections');
        let msg = null;

        try {
          if (collections.Msg && typeof collections.Msg.get === 'function') {
            const serialized = String(key.fromMe) + '_' + String(key.remote) + '_' + String(key.id) + '_' + String(key.participant);
            msg = collections.Msg.get(serialized);
          }
        } catch {}

        if (!msg) {
          try {
            const serialized = String(key.fromMe) + '_' + String(key.remote) + '_' + String(key.id) + '_' + String(key.participant);
            if (collections.Msg && typeof collections.Msg.getMessagesById === 'function') {
              const found = await collections.Msg.getMessagesById([serialized]);
              msg = found && found.messages && found.messages[0];
            }
          } catch {}
        }

        if (!msg) {
          return { ok: false, step: 'find-message', error: 'Status message not found' };
        }

        let reacted = false;

        try {
          const action = window.require('WAWebSendReactionMsgAction');
          if (action && typeof action.sendReactionToMsg === 'function') {
            await action.sendReactionToMsg(msg, reaction);
            reacted = true;
          }
        } catch (e) {
          return { ok: false, step: 'reaction', error: e && e.message ? e.message : String(e) };
        }

        return { ok: true, reacted: reacted };
      } catch (e) {
        return { ok: false, step: 'internal', error: e && e.message ? e.message : String(e) };
      }
    }, statusKey, process.env.STATUS_REACTION || '❤️');

    console.log('[STATUS V3 RESULT]', JSON.stringify(result));
    console.log('================================');
  } catch (error) {
    console.error('[STATUS V3 ERROR]', error && error.message ? error.message : error);
  }
}

client.on("message", async (message) => {
    try {
      if (!message) return;

      await autoViewAndReactToStatus(message);

      const from = message.from || "";
      const body = message.body || "";

      console.log(
        "[MESSAGE]",
        from,
        ":",
        body
      );

      try {
        await query(
          `
          INSERT INTO messages
          (direction, chat_id, sender, body, message_id)
          VALUES ($1,$2,$3,$4,$5)
          `,
          [
            "incoming",
            from,
            message.author || from,
            body,
            message.id?._serialized || null,
          ]
        );
      } catch (dbError) {
        console.error(
          "INCOMING MESSAGE DATABASE ERROR:",
          dbError.message
        );
      }

      if (body.trim().toLowerCase() === "!ping") {
        await message.reply("pong");
        return;
      }

      if (body.trim().toLowerCase() === "!status") {
        await message.reply(
          whatsappReady
            ? "WhatsApp bot is online and ready."
            : "WhatsApp bot is not ready."
        );
        return;
      }

      if (body.trim().toLowerCase() === "!help") {
        await message.reply(
          "Available commands:\n" +
          "!ping - test the bot\n" +
          "!status - check bot status\n" +
          "!help - show this message"
        );
        return;
      }

      await runAutomationRules(message);
    } catch (error) {
      console.error(
        "[MESSAGE HANDLER ERROR]",
        error.message || error
      );
    }
  });

  client.on("message_create", async (message) => {
    try {
      if (!message) return;

      const from = message.from || "";
      const body = message.body || "";

      console.log(
        "[MESSAGE_CREATE]",
        from,
        ":",
        body
      );
    } catch (error) {
      console.error(
        "[MESSAGE_CREATE ERROR]",
        error.message || error
      );
    }
  });
}


async function updateMainAccountStatus(status) {
  try {
    const result = await pool.query(
      "SELECT id FROM whatsapp_accounts ORDER BY id ASC LIMIT 1"
    );

    if (!result.rows.length) return;

    await pool.query(
      "UPDATE whatsapp_accounts SET status=$1, phone=$2 WHERE id=$3",
      [status, whatsappInfo?.phone || null, result.rows[0].id]
    );
  } catch (error) {
    console.error("Account status update error:", error.message);
  }
}
function createWhatsAppClient() {
    const client = new BaileysClient({
        authDir:
            process.env.WHATSAPP_BAILEYS_SESSION_PATH ||
            path.join(__dirname, ".baileys_auth")
    });

    client.on("qr", qr => {
        lastQR = qr;
        whatsappReady = false;
        whatsappState = "QR_REQUIRED";

        console.log("");
        console.log("======================================");
        console.log("SCAN THIS QR CODE WITH WHATSAPP");
        console.log("======================================");

        qrcodeTerminal.generate(qr, {
            small: true
        });

        console.log("");
    });

    client.on("authenticated", () => {
        whatsappState = "AUTHENTICATED";
        console.log("WhatsApp authentication successful.");
    });

    client.on("ready", async info => {
        whatsappReady = true;
        lastQR = null;
        whatsappState = "READY";

        const rawId = String(info?.id || "");

        whatsappInfo = {
            pushname: info?.name || null,
            phone: rawId
                .split(":")[0]
                .replace("@s.whatsapp.net", "")
                .replace("@lid", ""),
            platform: "Baileys"
        };

        console.log("");
        console.log("======================================");
        console.log("       WHATSAPP CONNECTED - BAILEYS");
        console.log("======================================");
        console.log("Number:", whatsappInfo.phone || "unknown");
        console.log("Name:", whatsappInfo.pushname || "unknown");
        console.log("======================================");
        console.log("");

        try {
            await updateMainAccountStatus("connected");
        } catch (error) {
            console.error(
                "Account status update error:",
                error.message
            );
        }
    });

    client.on("disconnected", async reason => {
        whatsappReady = false;
        whatsappState = "DISCONNECTED";
        lastQR = null;

        console.log(
            "WhatsApp disconnected:",
            reason
        );

        try {
            await updateMainAccountStatus("disconnected");
        } catch (error) {
            console.error(
                "Account status update error:",
                error.message
            );
        }
    });

    client.on("message", async message => {
        try {
            if (message.isStatus) {
                console.log(
                    "[STATUS] Received from:",
                    message.author || message.from
                );
                return;
            }

            const text =
                String(message.body || "").trim();

            if (!text) return;

            console.log(
                "[MESSAGE] " +
                message.from +
                ": " +
                text
            );

            const command =
                text.toLowerCase();

            if (command === "!ping") {
                await message.reply("pong");
                return;
            }

            if (command === "!help") {
                await message.reply(
                    "WhatsApp Bot Commands\n\n" +
                    "!ping - Test the bot\n" +
                    "!help - Show commands\n" +
                    "!status - Show connection status"
                );
                return;
            }

            if (command === "!status") {
                await message.reply(
                    whatsappReady
                        ? "Bot is online and connected."
                        : "Bot is currently offline."
                );
                return;
            }

            try {
                const accountId =
                    await getMainAccountId();

                if (pool && accountId) {
                    await db(
                        `
                        INSERT INTO messages
                        (
                            whatsapp_account_id,
                            remote_number,
                            direction,
                            message_type,
                            body
                        )
                        VALUES ($1,$2,$3,$4,$5)
                        `,
                        [
                            accountId,
                            message.from,
                            "incoming",
                            "text",
                            text
                        ]
                    );
                }
            } catch (error) {
                console.error(
                    "Incoming message database error:",
                    error.message
                );
            }
        } catch (error) {
            console.error(
                "Message handler error:",
                error
            );
        }
    });

    client.on("error", error => {
        console.error(
            "WhatsApp client error:",
            error
        );
    });

    return client;
}

async function startWhatsApp() {
  if (whatsappStarting) {
    log("WhatsApp startup already in progress");
    return;
  }

  if (whatsappClient && whatsappReady) {
    log("WhatsApp is already ready");
    return;
  }

  whatsappStarting = true;
  whatsappState = "STARTING";

  try {
    if (!whatsappClient) {
      whatsappClient = createWhatsAppClient();
    }

    log("Initializing WhatsApp client...");

    await whatsappClient.initialize();

    log("WhatsApp initialization completed");
  } catch (error) {
    whatsappReady = false;
    whatsappState = "ERROR";

    console.error("");
    console.error(
      "========================================"
    );
    console.error(
      "WHATSAPP INITIALIZATION FAILED"
    );
    console.error(
      "========================================"
    );
    console.error(
      error?.stack || error
    );
    console.error(
      "========================================"
    );
    console.error("");
  } finally {
    whatsappStarting = false;
  }
}

app.post(
  "/api/whatsapp/restart",
  authMiddleware,
  async (req, res) => {
    try {
      if (whatsappClient) {
        try {
          await whatsappClient.destroy();
        } catch (error) {
          console.error(
            "DESTROY ERROR:",
            error.message
          );
        }
      }

      whatsappClient = null;
      whatsappReady = false;
      whatsappState = "RESTARTING";
      whatsappInfo = null;
      lastQR = null;

      setTimeout(() => {
        startWhatsApp().catch((error) => {
          console.error(
            "RESTART START ERROR:",
            error
          );
        });
      }, 1000);

      res.json({
        success: true,
        message: "WhatsApp restart initiated",
      });
    } catch (error) {
      console.error(
        "RESTART ERROR:",
        error
      );

      res.status(500).json({
        success: false,
        error: error.message ||
          "Unable to restart WhatsApp",
      });
    }
  }
);

app.get("/api/admin/users", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await query(
      `
      SELECT
        id,
        name,
        email,
        role,
        balance,
        created_at
      FROM users
      ORDER BY id DESC
      `
    );

    res.json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    console.error(
      "ADMIN USERS ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Unable to load users",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  });
});

app.use((error, req, res, next) => {
  console.error(
    "EXPRESS ERROR:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
});

async function shutdown(signal) {
  console.log("");
  console.log(
    `${signal} received. Shutting down...`
  );

  try {
    if (whatsappClient) {
      try {
        await whatsappClient.destroy();
      } catch (error) {
        console.error(
          "WhatsApp shutdown error:",
          error.message
        );
      }
    }

    await pool.end();

    console.log("Shutdown complete.");
    process.exitCode = 0;
  } catch (error) {
    console.error(
      "Shutdown error:",
      error
    );

    process.exitCode = 1;
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, HOST, () => {
      console.log("");
      console.log("========================================");
      console.log("WHATSAPP AUTOMATION SERVER");
      console.log("========================================");
      console.log(
        `Server: http://localhost:${PORT}`
      );
      console.log(
        `Environment: ${NODE_ENV}`
      );
      console.log(
        `Worker ID: ${WORKER_ID}`
      );
      console.log("========================================");
      console.log("");
    });

    startWhatsApp().catch((error) => {
      console.error(
        "BACKGROUND WHATSAPP START ERROR:",
        error
      );
    });
  } catch (error) {
    console.error(
      "SERVER START FAILED:",
      error
    );
  }
}

startServer();




