# wa-poc: Attendance Business Agent

A prototype of the **Attendance Business Agent**: staff chat with Claude over WhatsApp to carry out simple
transactions on another application, for example applying for leave.

- Business users describe each transaction, its allowed reasons and the
  process for each reason in **free text** on an admin page. No JSON, no code.
- Claude guides the user through the steps, reads uploaded evidence (an MC
  photo, a screenshot of a supervisor's approval) and records what it learns
  in a draft.
- Nothing is submitted until the backend shows a summary and the user
  replies **YES**. That check is in code, not left to the model.
- Every request is sent to the target application through **one fixed API
  call**. A mock target app is built in so you can watch records and the API
  log change live.

Everything runs on Cloudflare's free tier, and there is a browser chat page,
**Mock WhatsApp**, so you can try the whole thing without a phone or a Meta account.

The full requirements, including the changes made since the original build
prompt, are in [docs/requirements.md](docs/requirements.md).

## Contents

1. [The four pages](#the-four-pages)
2. [Run it on your computer](#run-it-on-your-computer)
3. [How it works](#how-it-works)
4. [Deploy to Cloudflare](#deploy-to-cloudflare)
5. [Secrets and settings](#secrets-and-settings)
6. [Connect a real WhatsApp number](#connect-a-real-whatsapp-number)
7. [WhatsApp through Twilio](#whatsapp-through-twilio)
8. [Telegram](#telegram)
9. [Test users](#test-users)
10. [Demo script](#demo-script)
11. [Synthetic test images](#synthetic-test-images)
12. [Choosing the Claude model](#choosing-the-claude-model)
13. [Logs and tests](#logs-and-tests)
14. [Privacy and retention](#privacy-and-retention)
15. [Limits to know about](#limits-to-know-about)
16. [Next steps and backlog](#next-steps-and-backlog)

## The four pages

All of them ask for a login: any username, and the `ADMIN_PASSWORD` you set.

| Page | What it is |
|---|---|
| `/mock-wa` | **Mock WhatsApp**: a phone-style chat with the Attendance Business Agent. Pick who you are, send text, photos and PDFs. |
| `/mock-app` | **Mock target app**: users, leave records and the API call log, refreshing every 3 seconds. |
| `/admin` | Knowledge base (for business users), Technical settings, Drafts, Conversations, Test users and Demo reset buttons. |
| `/evidence/<id>` | An uploaded file. Only reachable with the admin login. |

The live app is at <https://wa-poc.chooweic.workers.dev>.

`/webhook` (Meta), `/twilio/webhook` (Twilio) and `/telegram/webhook`
(Telegram) are the only public addresses. Every request to them must carry
Meta's or Twilio's signature, or Telegram's secret header.

### Screenshots

From a local run. The assistant's replies in these came from a scripted
stand-in used to check the wiring, not from the real Claude model.

| | |
|---|---|
| Confirmation summary sent by the backend | [1-chat-confirmation-summary.png](docs/screenshots/1-chat-confirmation-summary.png) |
| After replying YES | [2-chat-submitted.png](docs/screenshots/2-chat-submitted.png) |
| Mock target app: users, record, API log | [3-mock-target-app.png](docs/screenshots/3-mock-target-app.png) |
| Admin: knowledge base | [4-admin-knowledge-base.png](docs/screenshots/4-admin-knowledge-base.png) |
| Admin: a draft with fields, checklist and evidence | [5-admin-draft.png](docs/screenshots/5-admin-draft.png) |
| Admin: test users, on a phone | [6-admin-test-users-phone.png](docs/screenshots/6-admin-test-users-phone.png) |

## Run it on your computer

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npm install
```

Installs the tools (Wrangler, TypeScript, the Claude SDK).

```bash
cp .dev.vars.example .dev.vars
```

Creates your local secrets file. Open `.dev.vars` and set `ANTHROPIC_API_KEY`
(from <https://platform.claude.com>) and an `ADMIN_PASSWORD` of your choice.
The file is git-ignored, so it is never committed.

```bash
npm run db:migrate:local
```

Creates the tables and the demo knowledge base in a local database on your
disk (inside `.wrangler/`). Nothing is created in your Cloudflare account.

```bash
npm run dev
```

Starts the app at <http://localhost:8787>. Open <http://localhost:8787/mock-wa>,
log in, and say hello. Open <http://localhost:8787/mock-app> in a second window
to watch the mock target app.

The local version includes the queue, the database and file storage, all
simulated on your machine by Wrangler.

## How it works

```
 WhatsApp (Meta)   ──► /webhook ──────────┐
 WhatsApp (Twilio) ──► /twilio/webhook ───┤
 Telegram          ──► /telegram/webhook ─┼─► store message ─► Queue ─► orchestrator ─► reply
 /mock-wa page     ──► /mock-wa/api ──────┘                              │
                                                                       ├─ commands: /reset, /cancel
                                                                       ├─ "YES" on a draft awaiting confirmation ─► submit
                                                                       └─ otherwise: Claude turn with tools
                                                                                         │
                                               TargetAppClient.submit(payload) ◄─────────┘ (never called by Claude)
                                                        │
                                           mock target app (D1 tables, API log)
```

### One pipeline, four channels

Sending and receiving sit behind a `MessagingChannel` interface with four
implementations, which can all be on at once:

- `MetaWhatsAppChannel`: WhatsApp through Meta's Cloud API (webhook, Graph API
  send, media download).
- `TwilioWhatsAppChannel`: WhatsApp through Twilio, as an alternative while a
  Meta business account is being sorted out (see
  [WhatsApp through Twilio](#whatsapp-through-twilio)).
- `TelegramChannel`: a Telegram bot (see [Telegram](#telegram)).
- `MockWaChannel`: the `/mock-wa` page. Files go straight to R2 and replies
  are stored in `mock_wa_messages` for the page to poll.

Everything after that is the same code: queue, orchestrator, Claude, drafts,
checklist, confirmation gate and target app. Tests check that the same message
through Meta, Twilio, Telegram or Mock WhatsApp gives Claude an identical request.

### Background processing: Cloudflare Queues

A Claude turn with several tool calls and an image takes longer than a webhook
should wait, and Meta resends a webhook that is not answered quickly. So the
webhook only verifies the signature, stores the message, puts a job on a queue
and returns 200. The queue consumer (the same Worker) does the slow part.

Why Queues and not the alternatives:

- **Queues** are on the free plan (10,000 operations a day; one message uses
  about three), a consumer may run for up to 15 minutes, and delivery is
  retried.
- **`ctx.waitUntil`** keeps a request alive a little after the response, but
  has no retries and a short time limit. If the turn is cut off, the message
  is lost.
- **Workflows** would also work, but need step-by-step code that this size of
  project does not need.

The consumer takes one message at a time (`max_batch_size: 1`,
`max_concurrency: 1` in `wrangler.jsonc`), so two quick messages from one user
cannot race on the same draft.

### The confirmation gate

Claude has no tool that submits. `request_confirmation` only moves the draft
to `awaiting_confirmation`, and the code refuses it unless:

- a valid, active reason is set,
- the required fields are present, valid and marked confirmed,
- the evidence the reason requires is attached,
- a checklist exists and every step is `done` or `not_applicable` (with a note).

The backend then sends the summary itself, built from the stored draft. The
request is submitted only when the user's own next message is `yes`
(any capitalisation, spaces trimmed) while the draft is still
`awaiting_confirmation`. The gate is checked again at that moment, in case the
KB changed in between. Any change to the draft after the summary sends it back
to `collecting`.

Draft statuses: `collecting` → `awaiting_confirmation` → `submitted` | `failed` | `cancelled`.

### The knowledge base has two layers

- **Business content** (KB tab): articles, transaction types and reasons, all
  free text, plus two simple controls per reason that the code enforces:
  evidence required / optional / none, and an optional maximum number of days.
- **Technical settings** (Technical tab): JSON Schemas for the data each
  request collects. Seeded for the demo; business users never open it.

There are no keyword lists or phrase tables. Claude matches what the user says
to a reason by reading the process guides.

The KB is read from the database on every message, so an edit takes effect on
the next message with no redeploy.

### Keeping token costs down

- **Prompt caching.** The request starts with the tool definitions, the fixed
  instructions and the rendered KB, marked cacheable for 1 hour (WhatsApp
  replies arrive minutes apart). That part is byte-identical between requests
  until someone edits the KB. Time, user, draft, history and files come after it.
- **Images are sent once.** A photo or PDF goes to Claude only on the turn it
  arrives. Claude records what it shows, and later turns get that text.
- **Short history.** Only the last 20 messages are sent; the draft is the memory.
- **Modest effort.** `CLAUDE_EFFORT` is `medium` in `wrangler.jsonc` (the code's own default is `low`).

Each Claude call logs its token usage (never message content). If
`cache_read_input_tokens` stays at 0 across messages a few minutes apart,
something in the cached part is changing.

### Project layout

```
migrations/            database schema and the demo KB
samples/               synthetic test documents
src/
  index.ts             routes and the queue consumer
  webhook.ts           Meta webhook: handshake, signature, parsing
  whatsapp-client.ts   Graph API: send, typing indicator, media download
  twilio-webhook.ts    Twilio webhook: signature, parsing
  twilio-client.ts     Twilio API: send, typing indicator, media download
  telegram-webhook.ts  Telegram webhook: secret check, share-your-number step, parsing
  telegram-client.ts   Telegram Bot API: send, typing, file download, webhook setup
  telegram-links.ts    which phone number each Telegram account belongs to
  channels/            MessagingChannel + the Meta, Twilio, Telegram and Mock WhatsApp implementations
  pipeline.ts          store → queue → process, shared by all channels
  sender.ts            the one place that decides who the sender is
  orchestrator.ts      commands, the YES gate, the Claude tool loop, submission
  claude/              API client, prompt and KB rendering, tools
  validation.ts        schema checks, limits, the confirmation gate
  kb-repo.ts drafts-repo.ts conversations-repo.ts   database access
  media.ts             evidence checks and R2 storage
  summary.ts           the backend's confirmation and result messages
  target/              TargetAppClient, the generic payload, mock and HTTP clients
  mock-app/            the mock target app's API, demo data and test users
  ui/                  admin pages, Mock WhatsApp, mock target app dashboard
test/                  Vitest tests
```

## Deploy to Cloudflare

These commands create things in **your Cloudflare account**. Run them yourself,
one at a time. Everything used here is on the free plan, but enabling R2 asks
for a payment card even though the free allowance is not charged.

```bash
npx wrangler login
```

Opens a browser to connect Wrangler to your Cloudflare account.

```bash
npx wrangler d1 create wa-poc-db
```

Creates the database. It prints a `database_id`. Copy it into `wrangler.jsonc`,
replacing `00000000-0000-0000-0000-000000000000`.

```bash
npx wrangler r2 bucket create wa-poc-evidence
```

Creates the private file store for evidence.

```bash
npx wrangler queues create wa-poc-inbound
```

Creates the queue used for background processing.

```bash
npm run db:migrate:remote
```

Creates the tables and the demo KB in the real database.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Stores your Claude API key as an encrypted secret. It asks you to paste the value.

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Stores the password for the admin pages. Use a long one: this is all that
protects the admin pages and the evidence files.

```bash
npm run deploy
```

Uploads the Worker and prints its address, for example
`https://wa-poc.<your-subdomain>.workers.dev`. Open `/mock-wa` on it.

To deploy from any device without a laptop, connect the GitHub repository in
the Cloudflare dashboard (Workers & Pages → your Worker → Settings → Builds).
Cloudflare then deploys on every push. You still create the database, bucket,
queue and secrets once, either with the commands above or in the dashboard.

## Secrets and settings

Locally these go in `.dev.vars`. In production set them with
`npx wrangler secret put NAME`. Nothing is hard-coded.

| Name | Needed | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key |
| `ADMIN_PASSWORD` | yes | Login for `/admin`, `/mock-wa`, `/mock-app`, `/evidence` |
| `CLAUDE_MODEL` | no | Set to `claude-haiku-5-5` in `wrangler.jsonc`; the code's default is `claude-opus-5-5` |
| `CLAUDE_EFFORT` | no | Set to `medium` in `wrangler.jsonc`; `low` or `high` also accepted |
| `CLAUDE_MAX_TOKENS` | no | Default `4000`. Includes Claude's thinking, so do not set it very low. |
| `WHATSAPP_ACCESS_TOKEN` | for real WhatsApp | Token used to send messages and download media |
| `WHATSAPP_PHONE_NUMBER_ID` | for real WhatsApp | The ID of the sending number (not the number itself) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | for real WhatsApp | Kept for reference; not used by the code yet |
| `WHATSAPP_APP_SECRET` | for real WhatsApp | Verifies the webhook signature |
| `WHATSAPP_VERIFY_TOKEN` | for real WhatsApp | Any text you choose; used once when registering the webhook |
| `ALLOWED_WHATSAPP_NUMBERS` | for real WhatsApp (Meta or Twilio) | Comma-separated numbers that may use the bot, e.g. `6591234567` |
| `TWILIO_ACCOUNT_SID` | for Twilio | Your Twilio Account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | for Twilio | Your Twilio Auth Token; also verifies the webhook signature |
| `TWILIO_WHATSAPP_FROM` | optional | Fallback sender, e.g. `whatsapp:+14155238886`. Normally replies go out from the number the user wrote to, taken from each message. |

| `TELEGRAM_BOT_TOKEN` | for Telegram | The token @BotFather gives you for your bot |
| `TELEGRAM_WEBHOOK_SECRET` | optional | The secret Telegram sends with each update. Derived from the bot token if not set. |

Each channel is off until its settings are added: `WHATSAPP_*` for Meta,
`TWILIO_*` for Twilio, `TELEGRAM_BOT_TOKEN` for Telegram. `/mock-wa` works on
its own either way. `/admin` → **Channels** shows which are on.
`ALLOWED_WHATSAPP_NUMBERS` applies to Meta, Twilio and Telegram (despite the
name); any number can be used on `/mock-wa`.

Other settings, in `wrangler.jsonc` under `vars`: `APP_TIMEZONE` (default
`Asia/Singapore`, used for "today" and deadlines) and `TARGET_APP_MODE`
(`mock`). Optional: `HISTORY_MESSAGES` (20), `MAX_UPLOAD_MB` (5),
`WHATSAPP_API_VERSION` (`v25.0`), `CLAUDE_STRICT_TOOLS` (`on`).

## Connect a real WhatsApp number

Do this after everything works on `/mock-wa`. Meta's screens change often, so
names may differ slightly.

1. At <https://developers.facebook.com>, create an app of type **Business**
   and add the **WhatsApp** product. Meta gives you a free **test number**.
2. On **WhatsApp → API Setup**, note the **Phone number ID** and the
   **WhatsApp Business Account ID**, and copy the **access token**. The token
   shown there is temporary (about a day). For longer use, create a System
   User token in Meta Business settings.
3. On the same page, under **To**, add your own phone as a test recipient and
   confirm the code Meta sends you. The test number can only message
   recipients added here.
4. On **App settings → Basic**, copy the **App secret**.
5. Set the secrets (each command asks for the value):

   ```bash
   npx wrangler secret put WHATSAPP_ACCESS_TOKEN
   ```

   ```bash
   npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
   ```

   ```bash
   npx wrangler secret put WHATSAPP_BUSINESS_ACCOUNT_ID
   ```

   ```bash
   npx wrangler secret put WHATSAPP_APP_SECRET
   ```

   ```bash
   npx wrangler secret put WHATSAPP_VERIFY_TOKEN
   ```

   ```bash
   npx wrangler secret put ALLOWED_WHATSAPP_NUMBERS
   ```

   For the verify token, make up any text. For the allowed numbers, enter your
   phone in international format without `+`, for example `6591234567`.
6. On **WhatsApp → Configuration**, set the webhook **Callback URL** to
   `https://<your-worker-address>/webhook` and the **Verify token** to the text
   you chose, then click **Verify and save**.
7. Under **Webhook fields**, subscribe to **messages**.
8. Add your phone number as a test user (see [Test users](#test-users)), so
   your requests are accepted. Alternatively, **Admin → Demo → Reset demo
   data** adds every number in `ALLOWED_WHATSAPP_NUMBERS` as "My test phone".
9. Send a WhatsApp message to the test number from your phone.

If nothing comes back, see [Logs and tests](#logs-and-tests). The usual causes
are an expired access token, a phone not added as a test recipient, or a number
missing from `ALLOWED_WHATSAPP_NUMBERS` (such messages are ignored silently).

## WhatsApp through Twilio

An alternative way in, for while the Meta business account is not ready. Users
still use WhatsApp; Twilio sits between them and this app. It runs alongside
the Meta channel, and either or both can be on.

For testing, Twilio's **WhatsApp Sandbox** needs no Meta business account:

1. Create a Twilio account at <https://www.twilio.com> (a trial includes some
   credit; Twilio charges per message).
2. In the Twilio console, open **Messaging → Try it out → Send a WhatsApp
   message**. Note the **sandbox number** and the **join code**, and from your
   phone send `join <your code>` to the sandbox number on WhatsApp.
3. On the console home page, copy the **Account SID** and **Auth Token**.
4. In Cloudflare, under **wa-poc → Settings → Variables and Secrets**, add as
   type **Secret**: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. Make sure
   your phone number is in `ALLOWED_WHATSAPP_NUMBERS`. The app replies from
   whichever number the user wrote to, so the sender number doesn't need to be
   set; `TWILIO_WHATSAPP_FROM` is only a fallback.
5. Back on the sandbox page, open **Sandbox settings** and set **When a message
   comes in** to `https://wa-poc.chooweic.workers.dev/twilio/webhook`, method
   **POST**. Type the address exactly like that: the signature covers the exact
   address, so an extra `/` at the end makes every message fail with 403.
6. Add your number as a test user (see [Test users](#test-users)) and send
   `hi` to the sandbox number.

Things to know about the sandbox:

- It is a shared Twilio number with no business profile, for testing only.
- Each tester must send the join message, and membership lapses after **3 days**:
  send `join <your code>` again.
- Replies are only allowed within 24 hours of the user's last message, as on
  every WhatsApp channel.
- A conversation through Twilio is separate from one through Meta or Mock
  WhatsApp, even for the same phone number. `/admin` labels it "WhatsApp via
  Twilio".
- Twilio allows 1,600 characters per message, so long replies are split into
  more messages than on Meta.
- The typing indicator uses Twilio's WhatsApp typing API, which is in public
  beta. If it fails, the reply still goes out.

For real users, register your own WhatsApp sender with Twilio (this still goes
through Meta's business checks), then change `TWILIO_WHATSAPP_FROM`.

**Trial accounts can't be used.** On a Twilio trial, WhatsApp messages can only
be Twilio's own ready-made templates. Every reply from the agent is refused
with error 21654 ("ContentSid Required"), whether it is sent through the API
or as a TwiML reply (both were tried). Upgrade the account to use this channel.

## Telegram

A Telegram bot is a free, quick way to test on a real phone: no business
verification, no templates and no 24-hour reply window.

**Set up (about 5 minutes):**

1. In Telegram, open a chat with **@BotFather**, send `/newbot`, and choose a
   name and a username for the bot (the username must end in `bot`).
   BotFather replies with a **token** like `123456789:AA...`.
2. In Cloudflare, under **wa-poc → Settings → Variables and Secrets**, add the
   token as a secret named `TELEGRAM_BOT_TOKEN`.
3. Open `/admin` → **Channels** and click **Connect Telegram**. This tells
   Telegram to send the bot's messages to
   `https://wa-poc.chooweic.workers.dev/telegram/webhook` (with a secret, so
   nobody else can post to it) and sets the bot's command menu. The card then
   shows the bot's name and "Connected".
4. Make sure your phone number is in `ALLOWED_WHATSAPP_NUMBERS` and is a test
   user (see [Test users](#test-users)).
5. Open the bot in Telegram (the link is on the Channels card), press
   **Start**, and tap **Share my phone number** when asked.

**Why the bot asks for your phone number:** Telegram never tells a bot a
user's phone number, but this app uses the phone number as the user's ID (for
the allowlist, test users and the request sent to the target app). So the bot
asks once, using Telegram's own "share my phone number" button. Telegram then
sends the number together with the account it belongs to, and the app only
accepts it if it is the sender's own. The link is stored, so it's asked only
once. `/admin` → Channels lists linked accounts and can unlink one.

Things to know:

- Only one-to-one chats are answered; the bot ignores groups and edited messages.
- Photos and PDFs work as on WhatsApp. Telegram lets bots download files up to
  20 MB; this app's own limit (5 MB) still applies.
- `*bold*` in the agent's replies is shown as bold.
- A Telegram conversation is separate from WhatsApp and Mock WhatsApp ones,
  even for the same phone number. `/admin` labels it "Telegram".
- **Privacy:** ordinary Telegram chats are not end-to-end encrypted (Telegram's
  servers can read them), unlike WhatsApp. Fine for this prototype with
  synthetic documents; think about it before real medical certificates go
  through it.
- If the app's address ever changes, click **Connect Telegram** again.

## Test users

The mock target app only accepts requests from phone numbers it knows. In this
prototype a user *is* their WhatsApp number; there is no employee ID.

To add one, open **`/admin` → Test users** (it works on a phone too):

1. Enter the **WhatsApp number** in international format, digits only, for
   example `6591234567` (spaces and a leading `+` are removed for you).
2. Enter a **name**.
3. Click **Add user**.

In the list below the form you can change a user's name and click **Save**, or
**Remove** them. Saving a number that already exists renames it.

There are no leave balances to set: they belong to the HR system, which is
outside this prototype (see [Leave balances](#leave-balances)).

- **On Mock WhatsApp** the new user appears in the "You are" list once you
  reload the page. You can also pick "Other number…" to chat as any number,
  but its requests are rejected at submission unless it is a test user.
- **On a real phone** the number must also be in `ALLOWED_WHATSAPP_NUMBERS`
  and added as a test recipient in Meta (see
  [Connect a real WhatsApp number](#connect-a-real-whatsapp-number)).

Three demo users are built in: Aisha Rahman (`6590000001`), Tan Wei Ming
(`6590000002`) and Priya Nair (`6590000003`). **Admin → Demo → Reset demo
data** deletes the mock target app's records and API log and makes sure these
three exist. Users you added are kept.

### Leave balances

This app does not keep leave balances or quotas, and it does not refuse a
request for lack of balance: that is the HR system's job, and the HR system is
out of scope. Where an approved transaction would change a quota (medical
leave, an off day, no pay leave), the mock target app instead logs a
**simulated** call, `POST hr-system /leave-quota/adjustments (simulated)`,
showing what it would send. Nothing is sent anywhere. Requests filed under
"Others" or a new reason are `pending_review` and trigger no quota call.

## Demo script

Works the same on `/mock-wa` and on a real phone. Keep `/mock-app` open beside
the chat. Use **Aisha Rahman** (`6590000001`) unless stated. The sample files
are in `samples/`; see the next section about their dates.

**1. Medical leave with an MC**

1. Say: `I was sick yesterday`.
2. Attach `samples/sample-mc.png` and send it.
3. Answer the questions (did you tell your supervisor on the day, and so on).
4. A summary arrives with the details, the checklist and the evidence. Reply `YES`.
5. Watch `/mock-app`: a record appears as `approved`, and the API log shows
   the full request and response, followed by the simulated HR quota call
   for 1 day of medical leave.

Try `samples/sample-mc-unsigned.png` to see Claude point out the missing signature.

**2. Off granted by supervisor**

1. Say: `My supervisor gave me Friday off`.
2. Send `samples/sample-approval-off.png`. Claude checks the screenshot shows
   the supervisor's name, the date and a clear approval, and that the date
   matches.
3. Reply `YES`. The log shows a simulated HR quota call for an off day.

**3. A reason that fits none of the specific ones**

1. Say: `I need a day off next Wednesday to move house`.
2. Claude lists the allowed reasons and asks whether one applies. Say none does.
3. Claude offers "Others" and confirms your reason in your own words. You may
   send any supporting document; it is stored and described, not judged.
4. Reply `YES`. The record shows as `pending_review`, with no HR quota call.

**4. A reason added mid-demo**

1. On `/admin`, under Leave application, click **+ Add a reason**. Label:
   `Childcare leave`. Guide: `For looking after your sick child. Tell your
   supervisor by WhatsApp before your shift. No document is needed.` Evidence:
   None. Maximum days: 2. Save.
2. Back in the chat, say: `My son is ill, I need to stay home with him tomorrow`.
3. Claude accepts the new reason straight away. After `YES`, the record appears
   as `pending_review`, because the mock target app has no special handling for
   a reason it has never seen. No redeploy at any point.

**5. No supervisor approval yet**

1. As **Tan Wei Ming** (`6590000002`), say: `I want to take no pay leave from 1 to 3 December`.
2. When asked, say you have not asked your supervisor yet.
3. Claude explains who to ask and how, from the guide, and leaves the request open.
4. Send `samples/sample-approval-nopay.png`. Claude checks it, finishes the
   checklist and sends the summary. Reply `YES`.

   Try `samples/sample-approval-vague.png` first to see a reply that is not an
   approval being turned down.

**6. A business user edits a guide**

1. Ask: `How long do I have to send my MC?` Claude says within 2 working days.
2. On `/admin`, edit **Medical leave** and change "within 2 working days" to
   "within 5 working days". Save.
3. Ask again. The answer changes on the very next message.

Other things worth showing: `/cancel` and `/reset` buttons; an unknown number
(choose "Other number…" on `/mock-wa`), which the mock target app rejects at
submission with a plain-language message; a medical leave request for more
than 14 days, which the code refuses because of the reason's maximum days.

## Synthetic test images

Use only made-up documents with this prototype. Never upload a real MC or a
real chat.

`samples/` contains ready-made PNGs and the two HTML pages they were made from:

- `fake-mc.html`: a fictional clinic's MC with a "SAMPLE · NOT A REAL MC" watermark.
- `fake-approval-chat.html`: a generic chat showing a supervisor's approval.

The dates in the ready-made PNGs are fixed (23 to 27 November 2026 and 1 to 3
December 2026), so they go stale against rules like "within 2 working days".
To make fresh ones, open the HTML file in any browser, set the details in the
address bar, and take a screenshot:

```
samples/fake-mc.html?name=Aisha%20Rahman&from=2026-11-23&to=2026-11-24
samples/fake-approval-chat.html?supervisor=Mr%20Goh&date=2026-11-27&kind=off
samples/fake-approval-chat.html?date=2026-12-01&to=2026-12-03&kind=nopay
```

With no parameters, the MC is dated yesterday and the approval is for three
days from now. Add `sign=0` for an MC with no signature, or `approve=0` for a
supervisor reply that is not an approval. On a phone, open the page, take a
screenshot and crop it.

## Choosing the Claude model

The model and effort are set in `wrangler.jsonc` under `vars`, currently
`claude-haiku-5-5` at `medium` effort. To change them, edit those two lines
and run `npm run deploy`. The options are `claude-opus-5-5` (the most capable,
and the code's default if `CLAUDE_MODEL` is removed), `claude-sonnet-5-5` and
`claude-haiku-5-5`. Locally, a value in `.dev.vars` overrides the one in
`wrangler.jsonc`.

Do not also add `CLAUDE_MODEL` or `CLAUDE_EFFORT` as secrets in the Cloudflare
dashboard: a secret and a variable with the same name conflict, and the deploy
fails. A plain-text variable added in the dashboard is removed by the next
`npm run deploy`, so `wrangler.jsonc` is the place to change them.

Before switching for real use, re-run the demo script and look closely at the
two things that depend most on the model:

- **Reason matching.** Does it still ask when the reason is ambiguous, list
  the reasons when nothing fits, and hold back "Others" until you confirm that
  none applies?
- **Evidence reading.** Does it read names and dates correctly from the
  samples, and catch the unsigned MC and the vague approval?

Raise `CLAUDE_EFFORT` to `high` if a model is careless at `medium`. Cached
prompts are per model, so the first message after a switch pays for a new cache.

## Logs and tests

```bash
npx wrangler tail
```

Streams live logs from the deployed Worker. You will see one `claude_usage`
line per Claude call (token counts only), rejected senders, and any errors.
Message text, file contents and base64 are never logged.

```bash
npm test
```

Runs the Vitest suite on your computer, with no network and no Claude calls.
It covers signature verification, message parsing, the draft state machine and
confirmation gate (including that nothing is submitted without the user's
YES), reason validation, schema validation, the generic payload, the mock API,
and that both channels produce the same orchestrator input.

```bash
npm run typecheck
```

Checks the TypeScript types.

## Privacy and retention

This kind of system handles sensitive documents. In this prototype:

- Use synthetic data only.
- Evidence is stored in a private R2 bucket and is only served through
  `/evidence/<id>`, which needs the admin login.
- File contents and base64 are never written to logs.
- Uploaded files and message text are sent to the Claude API for processing.
  Check Anthropic's data-retention terms for your account before real use.

**Retention.** Nothing is deleted automatically. Messages, drafts and evidence
files stay until you remove them: `/admin` → Demo → "Clear conversations,
drafts and files" deletes all of them, including the R2 objects. Files from
cancelled or abandoned requests also stay; a clean-up job is on the backlog.
Before real use, decide how long each kind of record must be kept and add
automatic deletion.

## Limits to know about

- **CPU time on the free plan.** Workers Free allows 10 ms of CPU per
  invocation. Waiting for Claude or the database does not count, but encoding
  an image for Claude does, and it is repeated on each round of a tool loop.
  Uploads are capped at 5 MB for this reason. If turns with photos fail in
  production with a CPU-limit error in `wrangler tail`, the options are the
  Workers Paid plan, a lower `MAX_UPLOAD_MB`, or sending files to Claude by
  reference (Files API) instead of inline.
- **Queue allowance.** 10,000 operations a day on the free plan, about 3,000
  messages.
- **Meta's test number** only messages recipients you have added, and its
  default access token is temporary.
- **The typing indicator** on real WhatsApp disappears after about 25 seconds,
  so it may vanish before a long turn finishes.
- **One conversation per channel.** The same phone number on `/mock-wa`, on
  WhatsApp through Meta, on WhatsApp through Twilio and on Telegram has a
  separate conversation and draft on each.
- **Telegram's typing indicator** lasts about 5 seconds, so on longer turns it
  disappears before the reply arrives.

## Next steps and backlog

**Plug in the real target API.** Write the real endpoint's details into
`HttpTargetAppClient` in `src/target/client.ts` (it already posts the generic
payload with the draft ID as `Idempotency-Key`), then set
`TARGET_APP_MODE=http`, `TARGET_APP_URL` and `TARGET_APP_API_KEY`. Map the real
API's error codes to plain-language messages in `src/summary.ts`.

**Move to a real WhatsApp number.** Register your own number in Meta Business,
complete business verification, create a permanent System User token, and
replace the test number's IDs. Free-form replies are only allowed within 24
hours of the user's last message; anything later needs an approved template.

**Retrieval for a larger KB.** The whole KB is sent (cached) on every turn,
which is right for a small KB. See item 3 below for when it grows.

Planned, and deliberately not built yet:

1. **Authorisation by phone number.** Map the sender's number to an identity
   in the target application and check what they may do (which transaction
   types, only their own record). Refuse unknown or unauthorised numbers
   politely and log every decision. `src/sender.ts` is the single place this
   goes.
2. **Clean up evidence from requests that were never submitted.** A scheduled
   job (Cloudflare Cron Trigger) that deletes R2 files and evidence rows for
   drafts that are `cancelled`, or idle in `collecting` /
   `awaiting_confirmation` for a configurable number of days. Log each
   deletion and never touch evidence linked to submitted or pending-review
   records.
3. **Load long KB articles only when needed.** Past roughly 20,000 tokens,
   always send a compact index (types, reasons with their guides and evidence
   rules) and give Claude a `get_kb_article(id)` tool for full policy text.
4. **Measure token usage and cost.** Store the usage fields per message and
   per draft, and show cost per message, per completed transaction and the
   cache hit rate on `/admin`, with a warning when cache reads stay at 0.
