require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const JWT_SECRET =
    process.env.JWT_SECRET || "CHANGE_THIS_SECRET_IN_RENDER";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
*/

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,

        ssl: process.env.DATABASE_URL.includes("localhost")
            ? false
            : {
                rejectUnauthorized: false
            }
    });

    pool.on("error", error => {
        console.error("PostgreSQL pool error:", error);
    });
}

async function query(text, params = []) {
    if (!pool) {
        throw new Error("DATABASE_URL is not configured.");
    }

    return pool.query(text, params);
}

/*
|--------------------------------------------------------------------------
| DATABASE INITIALIZATION
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {
    if (!pool) {
        console.log(
            "DATABASE_URL is not configured."
        );

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
            whatsapp_account_id INTEGER
                REFERENCES whatsapp_accounts(id)
                ON DELETE CASCADE,

            remote_number TEXT,
            direction TEXT,
            message_type TEXT DEFAULT 'text',
            body TEXT,
            media_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS automation_rules (
            id SERIAL PRIMARY KEY,

            whatsapp_account_id INTEGER
                REFERENCES whatsapp_accounts(id)
                ON DELETE CASCADE,

            trigger_text TEXT NOT NULL,
            reply_text TEXT NOT NULL,

            enabled BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS media (
            id SERIAL PRIMARY KEY,

            whatsapp_account_id INTEGER
                REFERENCES whatsapp_accounts(id)
                ON DELETE CASCADE,

            filename TEXT NOT NULL,
            mime_type TEXT,
            storage_url TEXT,

            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    console.log("Database initialized.");
}

/*
|--------------------------------------------------------------------------
| AUTH
|--------------------------------------------------------------------------
*/

function createToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role
        },
        JWT_SECRET,
        {
            expiresIn: "7d"
        }
    );
}

function auth(req, res, next) {
    const header =
        req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: "Authentication required"
        });
    }

    const token = header.substring(7);

    try {
        req.user = jwt.verify(
            token,
            JWT_SECRET
        );

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

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.json({
        ok: true,
        name: "WhatsApp Automation Platform",
        service: "api",
        status: "online",
        timestamp: new Date().toISOString()
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

/*
|--------------------------------------------------------------------------
| AUTH REGISTER
|--------------------------------------------------------------------------
*/

app.post("/api/auth/register", async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        if (!email) {
            return res.status(400).json({
                error: "Email is required"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                error:
                    "Password must contain at least 6 characters"
            });
        }

        const passwordHash =
            await bcrypt.hash(password, 12);

        const result = await query(
            `
            INSERT INTO users
                (email, password_hash)
            VALUES
                ($1, $2)
            RETURNING
                id,
                email,
                role,
                created_at
            `,
            [
                email,
                passwordHash
            ]
        );

        const user = result.rows[0];

        res.status(201).json({
            ok: true,
            user,
            token: createToken(user)
        });

    } catch (error) {
        console.error(
            "Registration error:",
            error
        );

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Email already exists"
            });
        }

        res.status(500).json({
            error: "Registration failed"
        });
    }
});

/*
|--------------------------------------------------------------------------
| LOGIN
|--------------------------------------------------------------------------
*/

app.post("/api/auth/login", async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const email =
            String(req.body.email || "")
                .trim()
                .toLowerCase();

        const password =
            String(req.body.password || "");

        const result = await query(
            `
            SELECT
                id,
                email,
                password_hash,
                role,
                created_at
            FROM users
            WHERE email = $1
            `,
            [email]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                error: "Invalid email or password"
            });
        }

        const user = result.rows[0];

        const valid =
            await bcrypt.compare(
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
            ok: true,
            user,
            token: createToken(user)
        });

    } catch (error) {
        console.error(
            "Login error:",
            error
        );

        res.status(500).json({
            error: "Login failed"
        });
    }
});

/*
|--------------------------------------------------------------------------
| CURRENT USER
|--------------------------------------------------------------------------
*/

app.get("/api/me", auth, (req, res) => {
    res.json({
        ok: true,
        user: req.user
    });
});

/*
|--------------------------------------------------------------------------
| WHATSAPP ACCOUNTS
|--------------------------------------------------------------------------
*/

app.get("/api/accounts", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        let result;

        if (req.user.role === "admin") {
            result = await query(`
                SELECT
                    id,
                    user_id,
                    name,
                    phone,
                    status,
                    session_name,
                    created_at
                FROM whatsapp_accounts
                ORDER BY id DESC
            `);
        } else {
            result = await query(
                `
                SELECT
                    id,
                    user_id,
                    name,
                    phone,
                    status,
                    session_name,
                    created_at
                FROM whatsapp_accounts
                WHERE user_id = $1
                ORDER BY id DESC
                `,
                [req.user.id]
            );
        }

        res.json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Unable to load WhatsApp accounts"
        });
    }
});

/*
|--------------------------------------------------------------------------
| CREATE WHATSAPP ACCOUNT
|--------------------------------------------------------------------------
*/

app.post("/api/accounts", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error: "Database is not configured yet"
            });
        }

        const name =
            String(req.body.name || "")
                .trim();

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
            `
            INSERT INTO whatsapp_accounts
                (
                    user_id,
                    name,
                    session_name
                )
            VALUES
                ($1, $2, $3)
            RETURNING *
            `,
            [
                req.user.id,
                name,
                sessionName
            ]
        );

        res.status(201).json(
            result.rows[0]
        );

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Unable to create WhatsApp account"
        });
    }
});

/*
|--------------------------------------------------------------------------
| DELETE WHATSAPP ACCOUNT
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/accounts/:id",
    auth,
    async (req, res) => {
        try {
            if (!pool) {
                return res.status(503).json({
                    error:
                        "Database is not configured yet"
                });
            }

            const accountId =
                Number(req.params.id);

            const result =
                await query(
                    `
                    DELETE FROM whatsapp_accounts
                    WHERE id = $1
                    AND (
                        user_id = $2
                        OR $3 = 'admin'
                    )
                    RETURNING id
                    `,
                    [
                        accountId,
                        req.user.id,
                        req.user.role
                    ]
                );

            if (!result.rows.length) {
                return res.status(404).json({
                    error:
                        "WhatsApp account not found"
                });
            }

            res.json({
                ok: true,
                deleted:
                    result.rows[0].id
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Unable to delete account"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| MESSAGES
|--------------------------------------------------------------------------
*/

app.get("/api/messages", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        let result;

        if (req.user.role === "admin") {
            result = await query(`
                SELECT
                    m.*
                FROM messages m
                ORDER BY m.created_at DESC
                LIMIT 500
            `);
        } else {
            result = await query(
                `
                SELECT
                    m.*
                FROM messages m
                JOIN whatsapp_accounts a
                    ON a.id =
                       m.whatsapp_account_id
                WHERE a.user_id = $1
                ORDER BY m.created_at DESC
                LIMIT 500
                `,
                [req.user.id]
            );
        }

        res.json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Unable to load messages"
        });
    }
});

/*
|--------------------------------------------------------------------------
| AUTOMATION RULES
|--------------------------------------------------------------------------
*/

app.get("/api/rules", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.json([]);
        }

        let result;

        if (req.user.role === "admin") {
            result = await query(`
                SELECT
                    r.*
                FROM automation_rules r
                ORDER BY r.id DESC
            `);
        } else {
            result = await query(
                `
                SELECT
                    r.*
                FROM automation_rules r
                JOIN whatsapp_accounts a
                    ON a.id =
                       r.whatsapp_account_id
                WHERE a.user_id = $1
                ORDER BY r.id DESC
                `,
                [req.user.id]
            );
        }

        res.json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Unable to load automation rules"
        });
    }
});

/*
|--------------------------------------------------------------------------
| CREATE AUTOMATION RULE
|--------------------------------------------------------------------------
*/

app.post("/api/rules", auth, async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({
                error:
                    "Database is not configured yet"
            });
        }

        const accountId =
            Number(
                req.body.whatsapp_account_id
            );

        const triggerText =
            String(
                req.body.trigger_text || ""
            ).trim();

        const replyText =
            String(
                req.body.reply_text || ""
            ).trim();

        if (!accountId) {
            return res.status(400).json({
                error:
                    "whatsapp_account_id is required"
            });
        }

        if (!triggerText) {
            return res.status(400).json({
                error:
                    "trigger_text is required"
            });
        }

        if (!replyText) {
            return res.status(400).json({
                error:
                    "reply_text is required"
            });
        }

        const ownership =
            await query(
                `
                SELECT id
                FROM whatsapp_accounts
                WHERE id = $1
                AND (
                    user_id = $2
                    OR $3 = 'admin'
                )
                `,
                [
                    accountId,
                    req.user.id,
                    req.user.role
                ]
            );

        if (!ownership.rows.length) {
            return res.status(403).json({
                error:
                    "You do not own this WhatsApp account"
            });
        }

        const result =
            await query(
                `
                INSERT INTO automation_rules
                    (
                        whatsapp_account_id,
                        trigger_text,
                        reply_text,
                        enabled
                    )
                VALUES
                    ($1, $2, $3, TRUE)
                RETURNING *
                `,
                [
                    accountId,
                    triggerText,
                    replyText
                ]
            );

        res.status(201).json(
            result.rows[0]
        );

    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Unable to create automation rule"
        });
    }
});

/*
|--------------------------------------------------------------------------
| UPDATE AUTOMATION RULE
|--------------------------------------------------------------------------
*/

app.patch(
    "/api/rules/:id",
    auth,
    async (req, res) => {
        try {
            if (!pool) {
                return res.status(503).json({
                    error:
                        "Database is not configured yet"
                });
            }

            const ruleId =
                Number(req.params.id);

            const enabled =
                Boolean(req.body.enabled);

            const result =
                await query(
                    `
                    UPDATE automation_rules r
                    SET enabled = $1
                    FROM whatsapp_accounts a
                    WHERE r.id = $2
                    AND r.whatsapp_account_id = a.id
                    AND (
                        a.user_id = $3
                        OR $4 = 'admin'
                    )
                    RETURNING r.*
                    `,
                    [
                        enabled,
                        ruleId,
                        req.user.id,
                        req.user.role
                    ]
                );

            if (!result.rows.length) {
                return res.status(404).json({
                    error:
                        "Automation rule not found"
                });
            }

            res.json(
                result.rows[0]
            );

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Unable to update rule"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| DELETE AUTOMATION RULE
|--------------------------------------------------------------------------
*/

app.delete(
    "/api/rules/:id",
    auth,
    async (req, res) => {
        try {
            if (!pool) {
                return res.status(503).json({
                    error:
                        "Database is not configured yet"
                });
            }

            const ruleId =
                Number(req.params.id);

            const result =
                await query(
                    `
                    DELETE FROM automation_rules r
                    USING whatsapp_accounts a
                    WHERE r.id = $1
                    AND r.whatsapp_account_id = a.id
                    AND (
                        a.user_id = $2
                        OR $3 = 'admin'
                    )
                    RETURNING r.id
                    `,
                    [
                        ruleId,
                        req.user.id,
                        req.user.role
                    ]
                );

            if (!result.rows.length) {
                return res.status(404).json({
                    error:
                        "Automation rule not found"
                });
            }

            res.json({
                ok: true,
                deleted:
                    result.rows[0].id
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Unable to delete rule"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN USERS
|--------------------------------------------------------------------------
*/

app.get(
    "/api/admin/users",
    auth,
    adminOnly,
    async (req, res) => {
        try {
            if (!pool) {
                return res.json([]);
            }

            const result =
                await query(`
                    SELECT
                        id,
                        email,
                        role,
                        created_at
                    FROM users
                    ORDER BY id DESC
                `);

            res.json(
                result.rows
            );

        } catch (error) {
            console.error(error);

            res.status(500).json({
                error:
                    "Unable to load users"
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

async function start() {
    try {
        await initializeDatabase();

        app.listen(
            PORT,
            HOST,
            () => {
                console.log("");
                console.log(
                    "======================================"
                );
                console.log(
                    " WHATSAPP AUTOMATION PLATFORM"
                );
                console.log(
                    " API SERVER"
                );
                console.log(
                    "======================================"
                );
                console.log(
                    "Port:",
                    PORT
                );
                console.log(
                    "Health:",
                    `/health`
                );
                console.log(
                    "======================================"
                );
                console.log("");
            }
        );

    } catch (error) {
        console.error(
            "API startup failed:",
            error
        );

        process.exit(1);
    }
}

start();

process.on(
    "SIGTERM",
    async () => {
        console.log(
            "SIGTERM received."
        );

        if (pool) {
            await pool.end();
        }

        process.exit(0);
    }
);

process.on(
    "SIGINT",
    async () => {
        console.log(
            "SIGINT received."
        );

        if (pool) {
            await pool.end();
        }

        process.exit(0);
    }
);