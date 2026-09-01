const express = require("express");

const app = express();

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        service: "vercel-api"
    });
});

app.get("/", (req, res) => {
    res.json({
        name: "WhatsApp Automation Platform",
        status: "online"
    });
});

module.exports = app;
