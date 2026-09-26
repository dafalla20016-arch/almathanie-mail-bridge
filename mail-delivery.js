import { submitTracked } from "./resend-delivery.js";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser/index.js";

export const DELIVERY_VERSION = "2026-09-26.2";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class DeliveryError extends Error {
  constructor(code, message, status = 400, deliveryStatus = "failed") {
    super(message);
    Object.assign(this, { code, status, deliveryStatus });
  }
}

function recipients(value, required = false) {
  if ((!value || !String(value).trim()) && !required) return [];
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new DeliveryError("INVALID_RECIPIENT", "Invalid recipient address");
  }
  const list = addressparser(value.replace(/;/g, ","), { flatten: true });
  if (!list.length || list.length > 30 || list.some(item => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item.address))) {
    throw new DeliveryError("INVALID_RECIPIENT", "Invalid recipient address");
  }
  return list;
}

export async function prepareMessage(account, body) {
  if (typeof body.subject !== "string" || !body.subject.trim() || typeof body.text !== "string" || !body.text.trim()) {
    throw new DeliveryError("INVALID_MESSAGE", "Subject and text are required");
  }
  if (body.subject.length > 300 || body.text.length > 100_000 || (body.html != null && (typeof body.html !== "string" || body.html.length > 1_500_000))) {
    throw new DeliveryError("MESSAGE_TOO_LARGE", "Message exceeds the supported size", 413);
  }
  const to = recipients(body.to, true);
  const cc = recipients(body.cc);
  const attachments = body.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 50) throw new DeliveryError("INVALID_ATTACHMENT", "Invalid attachments");
  let bytes = 0;
  const files = attachments.map(file => {
    if (!file || typeof file.filename !== "string" || !file.filename.trim() || typeof file.content !== "string" || (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content) || file.content.length % 4 !== 0)) {
      throw new DeliveryError("INVALID_ATTACHMENT", "Invalid attachment data");
    }
    if (/\.(exe|com|bat|cmd|scr|msi|ps1|vbs|js|jar|apk|dmg|sh)$/i.test(file.filename)) throw new DeliveryError("INVALID_ATTACHMENT", "Unsupported attachment type", 415);
    const content = Buffer.from(file.content, "base64");
    bytes += content.length;
    if (bytes > MAX_ATTACHMENT_BYTES) throw new DeliveryError("MESSAGE_TOO_LARGE", "Attachments exceed 25 MB", 413);
    return {
      filename: file.filename.replace(/[\r\n]/g, " ").slice(0, 180),
      content,
      contentType: typeof file.contentType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType : "application/octet-stream",
      ...(typeof file.cid === "string" && /^[\w.@-]{1,100}$/.test(file.cid) ? { cid: file.cid, contentDisposition: "inline" } : {}),
    };
  });
  const safeMessageId = value => typeof value === "string" && /^<[^\s<>]+@[^\s<>]+>$/.test(value) ? value : undefined;
  const references = (Array.isArray(body.references) ? body.references : [body.references]).map(safeMessageId).filter(Boolean);
  const headers = {};
  // Preserve only the automatic-reply loop prevention headers, never arbitrary sender headers.
  for (const name of ["Auto-Submitted", "X-Auto-Response-Suppress", "Precedence"]) {
    const value = body.headers?.[name];
    if (typeof value === "string" && !/[\r\n]/.test(value)) headers[name] = value.slice(0, 100);
  }
  const messageId = `<${crypto.randomUUID()}@${account.email.split("@")[1]}>`;
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const composed = await composer.sendMail({
    from: account.email, to, cc, subject: body.subject.replace(/[\r\n]/g, " "), text: body.text,
    ...(body.html ? { html: body.html } : {}), attachments: files, messageId, headers,
    inReplyTo: safeMessageId(body.inReplyTo), references,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return { raw: composed.message, envelope: composed.envelope, messageId };
}

export async function deliverMessage({ account, body, transport, saveSent }) {
  const prepared = await prepareMessage(account, body);
  let info;
  try {
    if (body.provider === "resend" && !/^[a-f0-9]{64}$/.test(body.trackingKey || "")) throw new DeliveryError("INVALID_MESSAGE", "Invalid tracking key");
    info = body.provider === "resend"
      ? await submitTracked({ prepared, account, body, apiKey: process.env.RESEND_MAIL_API_KEY })
      : await transport.sendMail({
      envelope: prepared.envelope, raw: prepared.raw,
      dsn: { id: prepared.messageId, return: "headers", notify: ["failure", "delay"] },
      disableFileAccess: true, disableUrlAccess: true,
    });
  } catch (error) {
    const definite = error?.code === "EAUTH" || error?.code === "EENVELOPE" || Number(error?.responseCode) >= 400;
    throw new DeliveryError(error?.code === "EAUTH" ? "SMTP_AUTH_FAILED" : definite ? "SMTP_REJECTED" : "SMTP_OUTCOME_UNKNOWN",
      error?.code === "EAUTH" ? "Mailbox authentication failed" : definite ? "Mail server rejected the request" : "Could not confirm mail server acceptance",
      502, definite ? "failed" : "unknown");
  }
  const address = value => String(typeof value === "string" ? value : value?.address || "").toLowerCase();
  const accepted = Array.isArray(info.accepted) ? info.accepted.map(address).filter(Boolean) : [];
  const rejected = Array.isArray(info.rejected) ? info.rejected.map(address).filter(Boolean) : [];
  if (!accepted.length || !/^2\d\d(?:[ -]|$)/.test(String(info.response || ""))) {
    throw new DeliveryError("SMTP_OUTCOME_UNKNOWN", "Mail server acceptance is unconfirmed", 502, "unknown");
  }
  const missing = prepared.envelope.to.map(address).filter(item => !accepted.includes(item));
  const notAccepted = [...new Set([...rejected, ...missing])];
  const result = {
    ok: true, deliveryVersion: DELIVERY_VERSION,
    deliveryStatus: notAccepted.length ? "partial" : "accepted",
    messageId: prepared.messageId, accepted, rejected: notAccepted,
    ...(info.providerId ? { provider: "resend", providerId: info.providerId } : {}),
    smtpCode: Number(String(info.response).slice(0, 3)), sentCopySaved: false,
  };
  // SMTP acceptance is final for this attempt. A failure to save its IMAP copy
  // must not report sending failure and cause another delivery.
  try { await saveSent(prepared.raw); result.sentCopySaved = true; }
  catch { result.warning = "SENT_COPY_FAILED"; }
  return result;
}

export function createSendHandler({ send, maxEntries = 1000, ttlMs = 86_400_000 }) {
  const requests = new Map();
  return async (account, body, key) => {
    if (!key) return send(account, body);
    if (typeof key !== "string" || key.length > 200 || /[\r\n]/.test(key)) throw new DeliveryError("INVALID_REQUEST_ID", "Invalid request ID");
    const now = Date.now();
    for (const [id, entry] of requests) if (entry.done && entry.expires <= now) requests.delete(id);
    const id = `${account.id}:${key}`;
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = requests.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DeliveryError("REQUEST_CONFLICT", "Request ID reused with different content", 409);
      return existing.promise;
    }
    if (requests.size >= maxEntries) throw new DeliveryError("SEND_BUSY", "Sending is busy; try later", 503);
    const entry = { fingerprint, done: false, expires: now + ttlMs };
    entry.promise = Promise.resolve().then(() => send(account, body)).finally(() => { entry.done = true; entry.expires = Date.now() + ttlMs; });
    requests.set(id, entry);
    return entry.promise;
  };
}
