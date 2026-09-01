const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-me";

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes("localhost")
            ? false
            : { rejectUnauthorized: false }
    });
}

async function query(text, params = []) {
    if (!pool) {
        throw new Error("DATABASE_URL is not configured.");
    }

    return pool.query(text, params);
}

async function initializeDatabase() {
    if (!pool) {
        console.log("DATABASE_URL not configured. API will run without database.");
        return;
    }

    await query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'customer',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS whatsapp_accounts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            phone TEXT,
            status TEXT NOT NULL DEFAULT 'disconnected',
            session_name TEXT UNIQUE NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
            remote_number TEXT,
            direction TEXT,
            message_type TEXT DEFAULT 'text',
            body TEXT,
            media_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS automation_rules (
            id SERIAL PRIMARY KEY,
            whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
            trigger_text TEXT NOT NULL,
            reply_text TEXT NOT NULL,
            enabled BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS media (
            id SERIAL PRIMARY KEY,
            whatsapp_account_id INTEGER REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            mime_type TEXT,
            storage_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    console.log("Database initialized.");
}

function createToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role
        },
        JWT_SECRET,
        { expiresIn: "7d" }
    );
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    const token = header.substring(7);

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== "admin") {
        return res.status(403).json({
            error: "Administrator access required"
        });
    }

    next();
}

app.get("/", (req, res) => {
    res.json({
        name: "WhatsApp Automation Platform",
        status: "online"
    });
});

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        service: "api",
        database: Boolean(pool),
        timestamp: new Date().toISOString()
    });
});

app.post("/api/auth/register", async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!email || password.length < 6) {
            return res.status(400).json({
                error: "Email and password of at least 6 characters are required"
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await query(
            `INSERT INTO users(email,password_hash)
             VALUES($1,$2)
             RETURNING id,email,role,created_at`,
            [email, passwordHash]
        );

        const user = result.rows[0];

        res.status(201).json({
            user,
            token: createToken(user)
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({
                error: "Email already exists"
            });
        }

        console.error(error);

        res.status(500).json({
            error: "Registration failed"
        });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        const result = await query(
            `SELECT id,email,password_hash,role,created_at
             FROM users
             WHERE email=$1`,
            [email]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        const user = result.rows[0];

        const valid = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!valid) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        delete user.password_hash;

        res.json({
            user,
            token: createToken(user)
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Login failed"
        });
    }
});

app.get("/api/me", auth, (req, res) => {
    res.json({
        user: req.user
    });
});

app.get("/api/accounts", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        const result = req.user.role === "admin"
            ? await query(`
                SELECT id,user_id,name,phone,status,session_name,created_at
                FROM whatsapp_accounts
                ORDER BY id DESC
            `)
            : await query(`
                SELECT id,user_id,name,phone,status,session_name,created_at
                FROM whatsapp_accounts
                WHERE user_id=$1
                ORDER BY id DESC
            `, [req.user.id]);

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Unable to load WhatsApp accounts"
        });
    }
});

app.post("/api/accounts", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const name = String(req.body.name || "").trim();

        if (!name) {
            return res.status(400).json({
                error: "Account name is required"
            });
        }

        const sessionName =
            "wa-" +
            req.user.id +
            "-" +
            Date.now();

        const result = await query(
            `INSERT INTO whatsapp_accounts
             (user_id,name,session_name)
             VALUES($1,$2,$3)
             RETURNING *`,
            [req.user.id, name, sessionName]
        );

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Unable to create WhatsApp account"
        });
    }
});

app.get("/api/messages", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        const result = req.user.role === "admin"
            ? await query(`
                SELECT m.*
                FROM messages m
                ORDER BY m.created_at DESC
                LIMIT 500
            `)
            : await query(`
                SELECT m.*
                FROM messages m
                JOIN whatsapp_accounts a
                  ON a.id=m.whatsapp_account_id
                WHERE a.user_id=$1
                ORDER BY m.created_at DESC
                LIMIT 500
            `, [req.user.id]);

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Unable to load messages"
        });
    }
});

app.get("/api/rules", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        const result = req.user.role === "admin"
            ? await query(`
                SELECT r.*
                FROM automation_rules r
                ORDER BY r.id DESC
            `)
            : await query(`
                SELECT r.*
                FROM automation_rules r
                JOIN whatsapp_accounts a
                  ON a.id=r.whatsapp_account_id
                WHERE a.user_id=$1
                ORDER BY r.id DESC
            `, [req.user.id]);

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Unable to load automation rules"
        });
    }
});

app.get("/api/admin/users", auth, adminOnly, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        const result = await query(`
            SELECT id,email,role,created_at
            FROM users
            ORDER BY id DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Unable to load users"
        });
    }
});

initializeDatabase()
    .catch(error => {
        console.error("Database initialization failed:", error.message);
    });

app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("======================================");
    console.log(" WHATSAPP AUTOMATION PLATFORM");
    console.log(" API SERVER");
    console.log("======================================");
    console.log("Port:", PORT);
    console.log("Health: http://localhost:" + PORT + "/health");
    console.log("======================================");
});
