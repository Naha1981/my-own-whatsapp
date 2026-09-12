# NahaLabs WhatsApp Operator — capabilities

This document defines the reusable WhatsApp feature surface for NahaLabs applications.

## Connection methods

Business owners have two supported choices:

1. QR pairing — the dashboard displays a short-lived QR and the owner scans it from WhatsApp → Linked Devices.
2. Phone-number pairing — the owner enters the WhatsApp number in the dashboard, receives a short-lived pairing code, then enters that code in WhatsApp → Linked Devices → Link with phone number instead.

Neither method asks the owner for their WhatsApp password.

Pairing codes are deliberately short-lived and requests are serialized per account. A second code is not generated while one is still active for that account.

## Messages

The Operator supports the common WhatsApp message types exposed by the pinned Baileys transport:

- text
- images with captions
- video with captions
- GIF-style video (`gifPlayback`)
- video notes (`ptv`)
- audio
- voice notes (`ptt`)
- documents, including PDF, DOCX, XLSX and other files when supplied with the correct MIME type
- stickers
- locations
- contact cards / vCards
- polls
- reactions

Outbound rich messages are sent through `POST /send` with a `type` field. Media should normally be supplied as an HTTPS URL so the Operator can stream it instead of forcing the whole file through the dashboard API.

Example image:

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "image",
  "url": "https://files.example.com/menu.jpg",
  "caption": "Our new menu"
}
```

Example PDF:

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "document",
  "url": "https://files.example.com/quote.pdf",
  "fileName": "Quote-1042.pdf",
  "mimetype": "application/pdf"
}
```

Example voice note:

```json
{
  "waAccountId": "uuid",
  "to": "27821234567",
  "type": "audio",
  "url": "https://files.example.com/reply.ogg",
  "mimetype": "audio/ogg; codecs=opus",
  "ptt": true
}
```

Baileys documents URL/stream/buffer media uploads and recommends URL/stream usage to avoid unnecessary memory usage. citeturn601547search0turn601547search1

## Receiving images, voice notes, videos and documents

Inbound `messages.upsert` events are delivered to the application's signed webhook as raw Baileys messages. The message object identifies whether the content is text, image, video, audio, document or sticker.

For actual media bytes, the Operator exposes:

```http
POST /media/download
X-API-Key: <OPERATOR_API_KEY>
Content-Type: application/json
```

```json
{
  "waAccountId": "uuid",
  "message": { "...": "raw inbound WAMessage from the webhook" }
}
```

The endpoint returns the binary media with the detected MIME type and filename when WhatsApp provides one. Baileys can request a media re-upload when the original media is no longer directly available. citeturn601547search0

The application should store important media in its own durable/object storage rather than depending on Render's ephemeral local filesystem.

## Events forwarded to the application

In addition to inbound messages, the Operator forwards these useful events through the same signed webhook:

- `message.reaction`
- `message.receipt`
- `contacts.upsert`
- `contacts.update`
- `presence.update`
- `groups.upsert`
- `groups.update`
- `group-participants.update`
- `call`

This lets an application maintain a CRM/inbox view without importing Baileys.

## WhatsApp calls

The Operator **does not implement a browser/Node voice or video calling bridge**. Baileys exposes incoming call events and a `rejectCall` operation, but a complete media call requires a real-time audio/video stack rather than ordinary message automation. Baileys' documented socket surface includes call rejection, not a general-purpose outbound voice/video call API. citeturn601547search0

For now:

- incoming calls can be detected and forwarded to the application;
- the application can reject an incoming call through `POST /calls/reject`;
- placing or answering a full WhatsApp voice/video call from the NahaLabs dashboard is intentionally not advertised as supported.

Do not build business logic that assumes an outbound WhatsApp call API exists.

## Message-management roadmap

The transport can be extended later for additional WhatsApp operations such as editing/deleting messages, read receipts, chat management, disappearing-message settings and other socket-level features. The current abstraction should keep those features optional and provider-independent at the application domain layer.

## Important operating rule

This is an unofficial WhatsApp Web/Linked Devices transport. Use it only for accounts and automation that are permitted. Do not use it for spam, bulk unsolicited messaging, scraping or evasion of WhatsApp safety systems.
