# WhatsApp setup (Phase 2b)

This guide connects EvolveSales to the official **WhatsApp Business Platform (Cloud API)** with
Meta's free **test number**, and exposes only the webhook to the internet with **ngrok**. It covers
prerequisites P6 and P7 in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

You do every step that involves a Meta or ngrok login, a token or a secret yourself. Put secrets
only in your local `.env` and never paste them into chat, code or issues.

## 1. Meta app and test number (P6)

1. Sign in at <https://developers.facebook.com> and create a developer account if needed.
2. **My Apps → Create app** → use case _Other_ → type **Business**, then link or create a (free)
   Meta Business portfolio.
3. In the app, **Add product → WhatsApp → Set up**. Meta creates a WhatsApp Business Account and a
   **test phone number**.
4. Open **WhatsApp → API Setup**:
   - Copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
   - Copy the **WhatsApp Business Account ID** → `WHATSAPP_WABA_ID`.
   - Copy the test number itself (international format, e.g. `+15551234567`) →
     `WHATSAPP_DISPLAY_NUMBER`.
   - Under **To**, add and verify up to 5 recipient phones: yours (sales user) and the admin's or
     approver's. The test number can message only these phones.
5. **App secret:** **App settings → Basic → App secret → Show** → `WHATSAPP_APP_SECRET`. The API
   uses it to verify the `X-Hub-Signature-256` of every webhook call.
6. **Permanent access token:** the token shown on API Setup expires after 24 hours. For a lasting
   one:
   - Go to **business.facebook.com → Settings → Users → System users → Add**, with the Admin role.
   - **Assign assets:** add your app with full control, and your WhatsApp account.
   - **Generate token:** choose the app and the permissions `whatsapp_business_messaging` and
     `whatsapp_business_management`, with no expiry.
   - Put the token in `WHATSAPP_ACCESS_TOKEN`.
7. Choose any long random string for `WHATSAPP_VERIFY_TOKEN`. You will type the same value into
   Meta's webhook form in step 3.

Then in `.env`:

```dotenv
WHATSAPP_ENABLED=true
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_WABA_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_DISPLAY_NUMBER=+15551234567
```

## 2. Public webhook address with ngrok (P7)

1. Create a free account at <https://ngrok.com>, install the agent and run
   `ngrok config add-authtoken <token>`. The token is shown in the ngrok dashboard.
2. Dashboard → **Domains** → claim your one free **static domain**, e.g.
   `evolvesales-dev.ngrok-free.app`. Put it in `NGROK_DOMAIN` for reference.
3. With the API running (`pnpm dev:api`), start the tunnel from the repository root:

   ```bash
   ngrok http 3000 --url https://evolvesales-dev.ngrok-free.app --traffic-policy-file tools/ngrok/whatsapp-only.yml
   ```

   The policy file lets only `GET` and `POST /api/v1/webhooks/whatsapp` through. Every other path,
   such as login, invoices or Swagger, gets a 404 at ngrok and never reaches your machine. You can
   check this: `https://<domain>/api/v1/health` must return 404.

## 3. Register the webhook in Meta

1. In the app: **WhatsApp → Configuration → Webhook → Edit**.
   - **Callback URL:** `https://<your-domain>/api/v1/webhooks/whatsapp`
   - **Verify token:** the value of `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save.** The API echoes Meta's challenge only if the token matches.
2. **Webhook fields → messages → Subscribe.**

## 4. Message templates (for messages after 24 hours)

WhatsApp lets a business send free-form messages only within 24 hours of the user's last message.
After that, it may only send templates that Meta has approved. Linking a phone, chatting and
approving within the window need **no** templates. Notifications sent later use these three.

Create them under **WhatsApp Manager → Message templates → Create template**, with category
**Utility** and language **English (US)** (`WHATSAPP_TEMPLATE_LANGUAGE=en_US`). The names and the
order of the variables must match exactly:

| Name                      | Body                                                                                  | Buttons                                             |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `cr_awaiting_approval`    | `EvolveSales: {{1}} needs your approval. Requested by {{2}}. Tap a button to decide.` | 3 × **Quick reply**: `Approve`, `Reject`, `Clarify` |
| `cr_status_changed`       | `EvolveSales update: {{1}}. Details: {{2}}. Reply here to continue.`                  | none                                                |
| `cr_clarification_needed` | `EvolveSales: {{1}} needs more information: {{2}}. Reply here to answer.`             | none                                                |

Meta asks for sample values; any text works. Utility templates are usually approved within minutes.
Until they are approved, notifications sent outside the window fail visibly: the
`outbound_messages` row shows `FAILED` with Meta's error. The web bell still shows them.

## 5. Try it

1. Run `pnpm dev:api`, `pnpm dev:orchestrator`, `pnpm dev:web` and the ngrok command.
2. **Link your phone:** sign in to the web app as `sales@evolvesales.local` → account menu →
   **Profile and WhatsApp**. Enter your verified number and press **Get link code**. Then send
   `LINK 123456`, with the code shown, from that phone to the test number.
3. **Data question:** ask _"Who were my top 3 customers this month?"_. The answer uses the
   read-only data tools as the sales user.
4. **Change request:** ask for a change, pick the screen from the list, check the summary card and
   tap **Submit request**. The request shows up in the web app's **Change requests** with channel
   `WHATSAPP` in its history.
5. **Approval with PIN:** link the approver's phone the same way and set an **Approval PIN** on
   their Profile page.
   - Until the analysis agent is built (Phase 3), no request reaches _Awaiting approval_, so this
     step is checked after Phase 3.
   - Then the approver receives a card: **Approve** → PIN → _APPROVED_.
   - Send `pending` to list cards again.

Commands: `help`, `new`, `status`, `pending` (approvers), `cancel` (stops a PIN, reason or questions
prompt).

## Security notes

- Unknown numbers get one fixed reply and never reach the AI model.
- Only numbers verified through the link code are recognised. **Unlink** on the Profile page
  disables the number at once, including approval cards already sent to it.
- Each approval card's buttons are HMAC-signed, single-use and expire after 24 hours. A card is
  refused if the plan changed after it was sent.
- PINs are stored as argon2 hashes. A typed PIN is overwritten in the stored webhook copy and never
  reaches the AI model. Five wrong PINs lock WhatsApp approvals for 30 minutes and notify the user.
- A PIN you type stays visible in that phone's own chat history; this is a known MVP limitation
  (§19.3).
- Replies to user-initiated conversations are free. Templates sent outside the 24-hour window are
  billed per message by Meta, subject to the test number's allowances.
