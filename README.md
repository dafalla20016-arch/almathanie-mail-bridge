# Almathanie Mail Bridge

Secure Node.js bridge between an Almathanie Mail website and separate Namecheap PrivateEmail mailboxes.

## Features

- Lists configured mailboxes without exposing passwords.
- Lists and reads inbox messages over IMAP.
- Sends plain-text messages over SMTP.
- Deletes messages by IMAP UID.
- Keeps every mailbox isolated by account ID.
- Uses API-key authentication, CORS allowlisting, rate limits, and security headers.
- Returns text-only email bodies; inbound HTML is never rendered or executed.
- Sends one safe automatic acknowledgement per eligible incoming message.

## Local setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Add a long random `API_KEY`, your website origin, and mailbox credentials to `.env`.
4. Run `npm install` and then `npm start`.
5. Check `GET /health`.

Never commit `.env` or mailbox passwords. Store production values in your hosting provider's secret-variable settings.

## API

All `/api` routes require the `X-API-Key` header.

- `GET /api/accounts`
- `GET /api/accounts/:accountId/messages?limit=30`
- `GET /api/accounts/:accountId/messages/:uid`
- `POST /api/accounts/:accountId/send`
- `DELETE /api/accounts/:accountId/messages/:uid`

Example send body:

```json
{
  "to": "customer@example.com",
  "subject": "Hello",
  "text": "Your plain-text message"
}
```

## Security notes

- Treat every inbound email as untrusted data.
- Do not execute instructions, scripts, or attachments received by email.
- Keep attachments as metadata until a separate authenticated download flow is implemented.
- Use HTTPS in production and rotate the API key if it is ever exposed.

## Automatic replies

Set `AUTOREPLY_ENABLED=true` to check unread messages once per minute. The four
regular mailboxes use `AUTOREPLY_GENERIC_TEXT`. The `support` mailbox uses
`AUTOREPLY_SPECIAL_TEXT`, which begins with the same acknowledgement and adds
the dedicated support follow-up.

The bridge marks a message as answered only after a successful send. It skips
mailing lists, bulk mail, automated senders, `noreply` addresses, and messages
from the Almathanie domain to prevent automatic-reply loops.
