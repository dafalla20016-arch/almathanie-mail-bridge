import { startPushDispatcher } from "./push-dispatcher.js";
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
const autoReplyEnabled = /^(1|true|yes)$/i.test(process.env.AUTOREPLY_ENABLED || "false");
const autoReplyIntervalMs = Math.max(Number(process.env.AUTOREPLY_INTERVAL_MS) || 60_000, 30_000);
const specialAutoReplyAccount = process.env.AUTOREPLY_SPECIAL_ACCOUNT || "support";
const genericAutoReplyText = process.env.AUTOREPLY_GENERIC_TEXT ||
  "شكراً لتواصلكم مع المثاني. تم استلام رسالتكم بنجاح، وسيقوم الفريق المختص بمراجعتها والرد عليكم في أقرب وقت ممكن.\n\nThank you for contacting Almathanie. Your message has been received and our team will respond as soon as possible.";
const specialAutoReplyText = process.env.AUTOREPLY_SPECIAL_TEXT ||
  `${genericAutoReplyText}\n\nتم تحويل رسالتكم تلقائياً إلى فريق الدعم والمتابعة. يرجى الاحتفاظ بعنوان هذه الرسالة لتسهيل متابعة طلبكم.\n\nYour message has been routed automatically to the support team. Please keep this subject line for follow-up.`;

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

const folderSpecialUse = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  archive: "\\Archive",
  trash: "\\Trash",
};

async function resolveFolder(client, requested = "inbox") {
  const key = String(requested || "inbox").toLowerCase();
  if (key === "inbox") return "INBOX";
  const specialUse = folderSpecialUse[key];
  const folders = await client.list();
  const match = folders.find((folder) => folder.specialUse === specialUse);
  if (match?.path) return match.path;
  const fallbacks = {
    sent: ["Sent", "Sent Items", "INBOX.Sent"],
    archive: ["Archive", "Archives", "INBOX.Archive"],
    trash: ["Trash", "Deleted Items", "INBOX.Trash"],
  };
  const fallback = (fallbacks[key] || []).find((name) => folders.some((folder) => folder.path === name));
  return fallback || "INBOX";
}

async function withMailbox(account, requested, work) {
  const client = imapClient(account);
  await client.connect();
  try {
    const folder = await resolveFolder(client, requested);
    const lock = await client.getMailboxLock(folder);
    try {
      return await work(client, folder);
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
  // ImapFlow envelopes contain arrays; Mailparser uses { text, value }.
  if (Array.isArray(address)) return address.map(addressText).filter(Boolean).join(", ");
  if (typeof address.text === "string" && address.text) return address.text;
  if (Array.isArray(address.value)) return addressText(address.value);
  const email = String(address.address || "").replace(/[\r\n<>]/g, "").trim();
  const name = String(address.name || "").replace(/[\r\n<>]/g, " ").trim();
  return email ? (name ? `${name} <${email}>` : email) : name;
}

function firstAddress(address) {
  return String(address?.value?.[0]?.address || "").trim().toLowerCase();
}

function headerText(parsed, name) {
  const value = parsed.headers?.get(name);
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function canAutoReply(parsed, account) {
  const sender = firstAddress(parsed.from);
  if (!sender || !sender.includes("@")) return false;
  if (sender === account.email.toLowerCase()) return false;
  if (sender.endsWith("@almathanie.com")) return false;
  if (/(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon)([._+-]|@)/i.test(sender)) return false;

  const autoSubmitted = headerText(parsed, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return false;
  if (/^(bulk|list|junk)/i.test(headerText(parsed, "precedence"))) return false;
  if (parsed.headers?.has("list-id")) return false;
  return true;
}

async function processAutoReplies(account) {
  await withInbox(account, async (client) => {
    const unseen = await client.search({ seen: false });
    for (const uid of unseen.slice(-20)) {
      const message = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
      if (!message?.source || message.flags?.has("\\Answered")) continue;

      const parsed = await simpleParser(message.source);
      if (!canAutoReply(parsed, account)) continue;

      const recipient = firstAddress(parsed.replyTo) || firstAddress(parsed.from);
      const subject = String(parsed.subject || "رسالتكم إلى المثاني").slice(0, 280);
      const text = account.id === specialAutoReplyAccount ? specialAutoReplyText : genericAutoReplyText;
      await smtpTransport(account).sendMail({
        from: account.email,
        to: recipient,
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        text,
        inReplyTo: parsed.messageId || undefined,
        references: parsed.messageId ? [parsed.messageId] : undefined,
        headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
      });
      await client.messageFlagsAdd(uid, ["\\Answered"], { uid: true });
    }
  });
}

let autoReplyRunning = false;
async function runAutoReplyCycle() {
  if (!autoReplyEnabled || autoReplyRunning) return;
  autoReplyRunning = true;
  try {
    for (const account of accounts.values()) {
      try {
        await processAutoReplies(account);
      } catch (error) {
        console.error(`Auto-reply failed for ${account.id}:`, error?.message || "Unknown error");
      }
    }
  } finally {
    autoReplyRunning = false;
  }
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  autoReply: autoReplyEnabled,
  specialAutoReplyAccount,
}));
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
  const page = Math.max(Number(req.query.page) || 1, 1);
  const folder = String(req.query.folder || "inbox").toLowerCase();
  try {
    const result = await withMailbox(account, folder, async (client) => {
      const total = client.mailbox.exists;
      if (!total) return { messages: [], hasMore: false, total: 0 };
      const end = Math.max(total - ((page - 1) * limit), 0);
      if (!end) return { messages: [], hasMore: false, total };
      const start = Math.max(1, end - limit + 1);
      const rows = [];
      for await (const message of client.fetch(`${start}:${end}`, {
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
          flagged: message.flags?.has("\\Flagged") || false,
          folder,
        });
      }
      return { messages: rows.reverse(), hasMore: start > 1, total };
    });
    res.json(result);
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
    const folder = String(req.query.folder || "inbox").toLowerCase();
    const result = await withMailbox(account, folder, async (client) => {
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

app.get("/api/accounts/:accountId/messages/:uid/attachments/:index", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const uid = Number(req.params.uid);
  const index = Number(req.params.index);
  const folder = String(req.query.folder || "inbox").toLowerCase();
  if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "Invalid attachment" });
  }
  try {
    const attachment = await withMailbox(account, folder, async (client) => {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!message?.source) return null;
      const parsed = await simpleParser(message.source);
      return parsed.attachments?.[index] || null;
    });
    if (!attachment) return res.status(404).json({ error: "Attachment not found" });
    const filename = String(attachment.filename || "attachment").replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", attachment.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(attachment.content);
  } catch (error) {
    next(error);
  }
});

app.post("/api/accounts/:accountId/send", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const { to, cc, subject, text, replyTo, inReplyTo, references } = req.body || {};
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
      inReplyTo: inReplyTo || undefined,
      references: Array.isArray(references) ? references : undefined,
    });
    const sentSubject = String(subject).replace(/[\r\n]/g, " ").slice(0, 300);
    const sentText = Buffer.from(String(text).slice(0, 100_000), "utf8").toString("base64");
    const sentRaw = [
      `From: ${account.email}`,
      `To: ${String(to).replace(/[\r\n]/g, " ")}`,
      cc ? `Cc: ${String(cc).replace(/[\r\n]/g, " ")}` : "",
      `Subject: ${sentSubject}`,
      `Message-ID: ${info.messageId}`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ].filter(Boolean).join("\r\n") + `\r\n\r\n${sentText}`;
    const sentClient = imapClient(account);
    try {
      await sentClient.connect();
      const sentFolder = await resolveFolder(sentClient, "sent");
      await sentClient.append(sentFolder, sentRaw, ["\\Seen"]);
    } finally {
      await sentClient.logout().catch(() => {});
    }
    res.status(201).json({ ok: true, messageId: info.messageId });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/accounts/:accountId/messages/:uid", async (req, res, next) => {
  const account = getAccount(req, res);
  if (!account) return;
  const uid = Number(req.params.uid);
  const folder = String(req.query.folder || "inbox").toLowerCase();
  const action = String(req.body?.action || "");
  if (!Number.isInteger(uid) || uid < 1) return res.status(400).json({ error: "Invalid message ID" });
  try {
    const client = imapClient(account);
    await client.connect();
    try {
      const source = await resolveFolder(client, folder);
      const destination = action === "archive" || action === "trash"
        ? await resolveFolder(client, action)
        : action === "restore" ? "INBOX" : null;
      const lock = await client.getMailboxLock(source);
      try {
      if (action === "read") await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      else if (action === "unread") await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
      else if (action === "star") await client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
      else if (action === "unstar") await client.messageFlagsRemove(uid, ["\\Flagged"], { uid: true });
      else if (destination) await client.messageMove(uid, destination, { uid: true });
      else throw new Error("Unsupported action");
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    res.json({ ok: true });
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
    const folder = String(req.query.folder || "trash").toLowerCase();
    await withMailbox(account, folder, (client) => client.messageDelete(uid, { uid: true }));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Request failed", error?.message || "Unknown error");
  res.status(500).json({ error: "Request failed" });
});

let pushDispatcher;
process.once("SIGTERM", () => { pushDispatcher?.stop(); process.exit(0); });
process.once("SIGINT", () => { pushDispatcher?.stop(); process.exit(0); });

app.listen(port, () => {
  pushDispatcher = startPushDispatcher();
  console.log(`Almathanie Mail bridge listening on port ${port}`);
  if (autoReplyEnabled) {
    setTimeout(runAutoReplyCycle, 5_000);
    setInterval(runAutoReplyCycle, autoReplyIntervalMs);
  }
});
