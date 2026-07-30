---
name: email-policy
description: Transactional and notification email - build templates with React Email (react.email) instead of hand-written HTML tables or string concatenation, render them server-side, send through the provider SDK behind a single send module, and apply deliverability (SPF/DKIM/DMARC, bounce and complaint suppression, unsubscribe headers), plain-text alternatives, idempotent background sending, and link safety. Use when sending, templating, styling, previewing, or testing any email from a backend, API route, cron job, worker, or CLI - signup and verification, password reset, receipts, alerts, digests, or any provider integration (Resend, Postmark, SendGrid, AWS SES, Mailgun, Nodemailer/SMTP).
---

# Email Policy (Transactional & Notification Mail)

## Activation Scope

- Apply whenever code sends an email or builds an email body: verification, password reset, invites, receipts, alerts, digests, notifications, or any email-provider integration.
- Owns templating, rendering, sending, and deliverability. Layering, retries, and queues stay with backend-policy; secrets, tokens, and link safety with security-policy; recipient and payload schemas with validation-policy; package choice with dependency-policy.

---

## Never Hand-Write Email HTML

Email clients are roughly two decades behind browsers: the Outlook desktop engine renders with Word, Gmail rewrites and strips `<style>`, external CSS never loads, and flexbox/grid are unavailable. HTML assembled by hand or from template strings looks correct in a browser preview and breaks in the actual inbox - and string-concatenated user values in markup are an injection surface.

- Do NOT: build bodies with template literals or Handlebars-into-tables, copy a random table skeleton off a blog, or reuse an app React component as an email.
- Do NOT judge an email by a browser screenshot - a browser is the one client that renders everything.
- DO: use a compiler that targets email HTML. In JavaScript/TypeScript that is React Email.

---

## React Email (default for JS/TS)

https://react.email - MIT, maintained by the Resend team. React components that compile to email-safe HTML, tested across Gmail, Apple Mail, Outlook, Yahoo! Mail, HEY, and Superhuman.

### Packages

- `@react-email/components` - the component set (peer: React 18 or 19): `Html`, `Head`, `Body`, `Container`, `Section`, `Row`, `Column`, `Heading`, `Text`, `Link`, `Button`, `Img`, `Hr`, `Preview`, `Font`, `Markdown`, `CodeBlock`, `CodeInline`, `Tailwind`.
- `@react-email/render` - the runtime renderer: `render()`, `pretty()`, `toPlainText()`. This is the only piece production needs, so it belongs in `dependencies`.
- `react-email` - the local preview server (`email dev`, bin `email`) that also re-exports `render`. It pulls in esbuild, socket.io, tailwindcss, prismjs, and chokidar: keep it a **devDependency**. Do not add it to production dependencies just to import `render` (dependency-policy, anti-overengineering-policy).

### Render, then send

```tsx
import { render } from "@react-email/render";
import { WelcomeEmail } from "@/emails/welcome";

const html = await render(<WelcomeEmail name={user.name} verifyUrl={url} />);
const text = await render(<WelcomeEmail name={user.name} verifyUrl={url} />, { plainText: true });
```

- `render()` is asynchronous - await it. Options: `plainText`, `pretty`, `htmlToTextOptions`. `toPlainText(html)` converts an already-rendered body, and `data-skip-in-text="true"` drops an element from the text version only.
- Templates live in one folder (`emails/`), one file per template, props typed. They are ordinary React components, so the reuse rules in frontend-policy apply: one shared layout/branding wrapper composed by every template, never a copied header per email.
- Style with the `<Tailwind>` wrapper when the project already uses Tailwind, otherwise inline `style` props. Never link an external stylesheet or a CDN webfont - clients strip or block them (use `<Font>` with a fallback stack).
- Always include `<Preview>`; without it the inbox preview line shows whatever stray text comes first.
- Host images on an absolute HTTPS URL and always set `alt` - most clients block images by default, so an email whose meaning lives only in an image arrives empty.
- Preview with `email dev` (or a rendered fixture) before shipping.

### Boundaries

- Non-React backends: use MJML or the provider's own template system, under the same doctrine - never hand-rolled tables.
- Marketing and campaign email belongs in the marketing platform, not in application code. This policy covers transactional and notification mail.

---

## Sending

- One module owns sending (e.g. `lib/email/send.ts`): it takes `{to, subject, template, props}`, renders HTML plus text, calls the provider, and returns a typed result. Feature code never imports the provider SDK directly - that keeps the provider swappable and concentrates logging, suppression, and idempotency in one place (backend-policy).
- Prefer the provider's official SDK or HTTP API over raw SMTP when one exists; React Email documents integrations for Resend, Postmark, SendGrid, AWS SES, Mailgun, MailerSend, Plunk, Scaleway, Azure Communication Email, and Nodemailer.
- API keys come from the environment or a secret store, server-side only - never in a client bundle, never committed (security-policy).
- Always send HTML **and** a plain-text alternative. Text-only clients, accessibility tooling, and spam filters all read it.
- Validate the recipient address and the template payload against a schema before rendering (validation-policy).
- Never block the user's response on the provider. Enqueue the send and return; a slow or failing mail provider must not fail the request. Where the project has no queue, send after the response with a timeout and log the failure instead of propagating it - unless the email IS the operation the user asked for.
- Make sends idempotent: derive a key from the event (user id + template + event id) so a retried job or a double-submitted request does not send twice, and pass the provider's idempotency key when it offers one. Retries are bounded with backoff (backend-policy).

---

## Content & Link Safety

- Never put a password, a secret, an API key, a full session token, or sensitive personal data in an email body. Mail sits in plaintext in most mailboxes and is forwarded freely. Send a short-lived, single-use link instead, and expire it on use.
- Build action links from a server-side base URL constant, never from the request `Host` header - header poisoning turns a password-reset email into account takeover.
- Validate any redirect or callback target against an allowlist before embedding it.
- React escapes text by default; the remaining risks are attributes and raw HTML. Validate every `href`/`src` against an `http`/`https` scheme allowlist, and never feed unsanitized user input to `<Markdown>` or a dangerouslySetInnerHTML equivalent (security-policy).

---

## Deliverability

- Send from a verified domain with SPF, DKIM, and DMARC configured. An unauthenticated domain lands in spam no matter how good the content is.
- Use a real, monitored `Reply-To`. Avoid `noreply@` for mail a human may reasonably answer.
- Consume the provider's bounce and complaint webhooks: suppress hard bounces and spam complaints permanently in your own store, and check that suppression list before every send. Ignoring it burns domain reputation for every other email you send.
- Any bulk or recurring email (digest, newsletter, activity summary) needs a working unsubscribe: `List-Unsubscribe` and `List-Unsubscribe-Post` headers plus a visible link, honored immediately and without a login. Genuine transactional mail (receipt, password reset, security alert) is exempt - do not use that exemption to smuggle marketing.
- Respect the provider's rate limits and daily quota; queue and pace bulk sends rather than bursting into a 429.
- Do not enable open/click tracking by default. It is a privacy decision with GDPR/RGPD consequences, not a sensible default.

---

## Testing & Observability

- Test templates by rendering them, not by sending: assert on the rendered HTML and text (subject line, required links present, no unresolved placeholder, correct locale). Deterministic and offline (testing-policy).
- Never send real mail from tests or local development. Use the provider's sandbox or test key, or a local catcher (Mailpit, Mailhog, Ethereal).
- Log every attempt with template id, provider message id, and outcome - never the body, the token, or the link. Alert on bounce and complaint rates, not just on send errors.
