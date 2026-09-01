# WhatsApp Automation Platform

This project contains:
- Vercel-compatible web/API
- Persistent WhatsApp worker
- Authentication
- Customer/admin accounts
- WhatsApp account management
- Messages
- Automation rules
- Media records
- PostgreSQL-ready database layer

## Development

npm install

npm run api

# In another terminal:
npm run worker

## Environment

Copy .env.example to .env and configure the values.

## Architecture

Vercel:
- Dashboard
- Authentication API
- REST API

Persistent server:
- whatsapp-web.js
- WhatsApp sessions
- Message processing
- Automation worker

Database:
- PostgreSQL
