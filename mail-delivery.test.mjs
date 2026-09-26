import test from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { prepareMessage, deliverMessage, createSendHandler } from "./mail-delivery.js";

const account = { id: "info", email: "info@example.com" };
const body = { to: "Recipient <recipient@example.net>", subject: "خطاب رسمي", text: "مرفق الخطاب" };
const accepted = { accepted: ["recipient@example.net"], rejected: [], response: "250 2.0.0 queued" };

test("400 KB PDF reaches SMTP and Sent unchanged, with authenticated sender and UTF-8 headers", async () => {
  const pdf = Buffer.alloc(400 * 1024, 65);
  let smtpRaw, sentRaw;
  const result = await deliverMessage({ account, body: { ...body, from: "fake@example.net", attachments: [{ filename: "letter.pdf", contentType: "application/pdf", content: pdf.toString("base64") }] },
    transport: { sendMail: async data => { smtpRaw = data.raw; assert.equal(data.envelope.from, account.email); return accepted; } },
    saveSent: async raw => { sentRaw = raw; },
  });
  const parsed = await simpleParser(smtpRaw);
  assert.deepEqual(parsed.attachments[0].content, pdf);
  assert.equal(parsed.subject, body.subject);
  assert.equal(parsed.from.value[0].address, account.email);
  assert.deepEqual(sentRaw, smtpRaw);
  assert.equal(result.deliveryStatus, "accepted");
  assert.equal(result.sentCopySaved, true);
});

test("accepted SMTP stays accepted when the Sent folder fails", async () => {
  const result = await deliverMessage({ account, body, transport: { sendMail: async () => accepted }, saveSent: async () => { throw new Error("IMAP unavailable"); } });
  assert.equal(result.deliveryStatus, "accepted");
  assert.equal(result.sentCopySaved, false);
});

test("partial SMTP acceptance reports the rejected CC, never full success", async () => {
  const result = await deliverMessage({ account, body: { ...body, cc: "blocked@example.net" },
    transport: { sendMail: async () => ({ ...accepted, rejected: ["blocked@example.net"] }) }, saveSent: async () => {} });
  assert.equal(result.deliveryStatus, "partial");
  assert.deepEqual(result.rejected, ["blocked@example.net"]);
});

test("an ID without recipient acceptance does not become success", async () => {
  await assert.rejects(deliverMessage({ account, body, transport: { sendMail: async () => ({ messageId: "fake" }) }, saveSent: async () => {} }), error => error.deliveryStatus === "unknown");
});

test("SMTP timeouts remain unknown, authentication errors are definite failures", async () => {
  for (const [code, status] of [["ETIMEDOUT", "unknown"], ["EAUTH", "failed"]]) {
    await assert.rejects(deliverMessage({ account, body, transport: { sendMail: async () => { throw Object.assign(new Error("mail failure"), { code }); } }, saveSent: async () => {} }), error => error.deliveryStatus === status);
  }
});

test("concurrent retries share one SMTP operation and changed payloads conflict", async () => {
  let calls = 0;
  const send = createSendHandler({ send: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return accepted; } });
  const results = await Promise.all([send(account, body, "same"), send(account, body, "same")]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  await assert.rejects(send(account, { ...body, text: "different" }, "same"), error => error.code === "REQUEST_CONFLICT");
  await send({ ...account, id: "support" }, body, "same");
  assert.equal(calls, 2);
});

test("invalid addresses, file paths and malformed attachment data cannot pass", async () => {
  await assert.rejects(prepareMessage(account, { ...body, to: "missing-address" }), error => error.code === "INVALID_RECIPIENT");
  await assert.rejects(prepareMessage(account, { ...body, attachments: [{ filename: "private.txt", path: "/etc/passwd" }] }), error => error.code === "INVALID_ATTACHMENT");
  await assert.rejects(prepareMessage(account, { ...body, attachments: [{ filename: "file.pdf", content: "invalid!" }] }), error => error.code === "INVALID_ATTACHMENT");
});
