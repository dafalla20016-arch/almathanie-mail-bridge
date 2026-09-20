import crypto from "node:crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function loadAccounts() {
  const mailboxIds = (process.env.MAILBOX_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (mailboxIds.length > 0) {
    const accounts = new Map();
    for (const id of mailboxIds) {
      if (!/^[a-z0-9_-]+$/i.test(id) || accounts.has(id)) {
        throw new Error("Mailbox IDs must be unique and URL-safe");
      }
      const prefix = `MAILBOX_${id.toUpperCase().replace(/-/g, "_")}`;
      const email = process.env[`${prefix}_EMAIL`];
      const password = process.env[`${prefix}_PASSWORD`];
      if (!email || !password) {
        throw new Error(`Missing email or password for mailbox ${id}`);
      }
      accounts.set(id, {
        id,
        label: process.env[`${prefix}_LABEL`] || id,
        email,
        password,
      });
    }
    return accounts;
  }

  let raw;
  try {
    raw = JSON.parse(process.env.MAIL_ACCOUNTS_JSON || "[]");
  } catch {
    throw new Error("MAIL_ACCOUNTS_JSON must be valid JSON");
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("MAIL_ACCOUNTS_JSON must contain at least one mailbox");
  }

  const accounts = new Map();
  for (const item of raw) {
    if (!item?.id || !item?.email || !item?.password) {
      throw new Error("Every mailbox requires id, email, and password");
    }
    if (!/^[a-z0-9_-]+$/i.test(item.id) || accounts.has(item.id)) {
      throw new Error("Mailbox IDs must be unique and URL-safe");
    }
    accounts.set(item.id, {
      id: item.id,
      label: item.label || item.id,
      email: item.email,
      password: item.password,
    });
  }
  return accounts;
}

const accounts = loadAccounts();

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-API-Key"],
  }),
);
app.use(express.json({ limit: "64kb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  }),
);

function safeEqual(received, expected) {
  const left = Buffer.from(String(received || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireApiKey(req, res, next) {
  if (!process.env.API_KEY || !safeEqual(req.get("X-API-Key"), process.env.API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function getAccount(req, res) {
  const account = accounts.get(req.params.accountId);
  if (!account) res.status(404).json({ error: "Mailbox not found" });
  return account;
}

function imapClient(account) {
  return new ImapFlow({
    host: process.env.IMAP_HOST || "mail.privateemail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });
}

function smtpTransport(account) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "mail.privateemail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: account.email, pass: account.password },
  });
}

async function withInbox(account, work) {
  const client = imapClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await work(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function addressText(address) {
  if (!address) return "";
  if (typeof address === "string") return address;
  return address.text || "";
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", requireApiKey);

app.get("/api/accounts", (_req, res) => {
  res.json(
    [...accounts.values()].map(({ id, label, email }) => ({ id, label, email })),
  );
});

app.get("/api/accounts/:accountId/messages", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;

  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  try {
    const messages = await withInbox(account, async (client) => {
      const total = client.mailbox.exists;
      if (!total) return [];
      const start = Math.max(1, total - limit + 1);
      const rows = [];
      for await (const message of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        size: true,
      })) {
        rows.push({
          uid: message.uid,
          subject: message.envelope?.subject || "(No subject)",
          from: addressText(message.envelope?.from),
          to: addressText(message.envelope?.to),
          date: message.internalDate,
          size: message.size,
          seen: message.flags?.has("\\Seen") || false,
        });
      }
      return rows.reverse();
    });
    res.json(messages);
  } catch (error) {
    next(error);
  }
});

app.get("/api/accounts/:accountId/messages/:uid", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const uid = Number(req.params.uid);
  if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: "Invalid message ID" });

  try {
    const result = await withInbox(account, async (client) => {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!message?.source) return null;
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      const parsed = await simpleParser(message.source);
      return {
        uid,
        messageId: parsed.messageId || null,
        subject: parsed.subject || "(No subject)",
        from: addressText(parsed.from),
        to: addressText(parsed.to),
        cc: addressText(parsed.cc),
        date: parsed.date || null,
        text: parsed.text || "",
        attachments: (parsed.attachments || []).map((file) => ({
          filename: file.filename || "attachment",
          contentType: file.contentType,
          size: file.size,
        })),
      };
    });
    if (!result) return res.status(404).json({ error: "Message not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/accounts/:accountId/send", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const { to, cc, subject, text, replyTo } = req.body || {};
  if (!to || !subject || !text) {
    return res.status(400).json({ error: "to, subject, and text are required" });
  }

  try {
    const info = await smtpTransport(account).sendMail({
      from: account.email,
      to,
      cc: cc || undefined,
      replyTo: replyTo || undefined,
      subject: String(subject).slice(0, 300),
      text: String(text).slice(0, 100_000),
    });
    res.status(201).json({ ok: true, messageId: info.messageId });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/accounts/:accountId/messages/:uid", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const uid = Number(req.params.uid);
  if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: "Invalid message ID" });

  try {
    await withInbox(account, (client) => client.messageDelete(uid, { uid: true }));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Request failed", error?.message || "Unknown error");
  res.status(500).json({ error: "Request failed" });
});

app.listen(port, () => {
  console.log(`Almathanie Mail bridge listening on port ${port}`);
});
