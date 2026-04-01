# NodeMail — Self-Hosted Webmail

A lightweight, self-hosted webmail application built with **Node.js**, **Express**, **EJS**, and **MongoDB**.

- **Receive** emails via built-in SMTP server (port 25) or external webhook (Mailgun, SendGrid, etc.)
- **Send** emails through any external SMTP provider (Brevo, Mailgun, SES, generic)
- **Full webmail UI** — inbox, sent, drafts, trash, custom folders, starred, search, attachments

---

## Features

- Inbox, Sent, Drafts, Trash, Starred
- Custom user-created folders
- Compose, Reply, Forward with quoted text
- CC / BCC support
- File attachments (upload & download, 25 MB limit)
- Full-text search across subject, body, from, to
- Bulk actions (mark read/unread, star, trash, delete)
- Pagination
- Multiple user accounts with aliases
- Session-based authentication (bcrypt passwords)
- Built-in SMTP server for receiving mail (no Postfix needed)
- Webhook endpoint for external inbound providers
- Dark themed responsive UI

---

## Requirements

- **Node.js** 18+
- **MongoDB** 4.4+
- A **domain** with DNS access (for MX records)
- An **external SMTP provider** for sending (Brevo, Mailgun, SES, etc.)
- **Port 25** open on your server (if using built-in SMTP inbound)

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url> nodemail
cd nodemail
npm install
```

### 2. Configure `.env`

```bash
cp .env .env.backup   # optional
nano .env
```

Fill in your values:

```env
PORT=3000
SESSION_SECRET=generate-a-long-random-string-here
MONGO_URI=mongodb://127.0.0.1:27017/nodemail

# Outbound SMTP (your provider)
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-login
SMTP_PASS=your-smtp-key

# Inbound mode: "smtp" or "webhook"
INBOUND_MODE=smtp
INBOUND_SMTP_PORT=25

# Default admin (created on first run)
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASS=a-strong-password
```

### 3. Run

```bash
# Development
node app.js

# Production (with PM2)
npm install -g pm2
pm2 start app.js --name nodemail
pm2 save
pm2 startup
```

### 4. Open

Visit `http://your-server-ip:3000` and log in with your admin credentials.

---

## DNS Setup (for receiving mail)

### MX Record

Point your domain's MX record to your server:

| Type | Name | Value               | Priority |
|------|------|---------------------|----------|
| MX   | @    | mail.yourdomain.com | 10       |
| A    | mail | YOUR_SERVER_IP      |          |

### SPF Record (for outbound deliverability)

```
TXT  @  "v=spf1 include:_spfcheck.brevo.com ~all"
```

Adjust the `include:` to match your SMTP provider.

### DKIM / DMARC

Set these up through your SMTP provider's dashboard (Brevo, Mailgun, etc.).

---

## Inbound Mode: Webhook

If you prefer not to run an SMTP server on port 25 (e.g., cloud providers block it), use webhook mode:

1. Set `INBOUND_MODE=webhook` in `.env`
2. Configure your email provider to forward inbound mail to:
   ```
   POST https://yourdomain.com/webhook/inbound
   ```

**Mailgun**: Routes → Create Route → Forward to URL
**SendGrid**: Inbound Parse → Add Host & URL

The webhook accepts raw MIME, JSON with `body-mime` field, or form-encoded fields (`from`, `to`, `subject`, `body-plain`, `body-html`).

---

## Adding Users

Currently done via MongoDB directly or a quick script:

```bash
node -e "
  require('dotenv').config();
  const mongoose = require('mongoose');
  const User = require('./models/User');
  mongoose.connect(process.env.MONGO_URI).then(async () => {
    await User.create({
      email: 'user@yourdomain.com',
      password: 'their-password',
      name: 'User Name',
      aliases: ['sales@yourdomain.com']  // optional
    });
    console.log('User created');
    process.exit();
  });
"
```

---

## Nginx Reverse Proxy (Production)

```nginx
server {
    listen 80;
    server_name mail.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 30M;
    }
}
```

Then add SSL with Certbot:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d mail.yourdomain.com
```

---

## Project Structure

```
nodemail/
├── app.js                  # Entry point
├── .env                    # Configuration
├── package.json
├── models/
│   ├── User.js             # User accounts + aliases
│   ├── Email.js            # Emails with attachments
│   └── Folder.js           # Custom folders
├── lib/
│   ├── mailer.js           # Outbound SMTP (Nodemailer)
│   ├── inboundSmtp.js      # Built-in SMTP server
│   └── auth.js             # Auth middleware
├── routes/
│   ├── auth.js             # Login / logout
│   ├── emails.js           # Inbox, read, compose, send, folders, bulk
│   └── webhook.js          # Inbound webhook endpoint
├── views/
│   ├── login.ejs
│   ├── inbox.ejs
│   ├── partials/
│   │   └── sidebar.ejs
│   └── emails/
│       ├── read.ejs
│       └── compose.ejs
├── public/
│   ├── css/style.css
│   └── js/app.js
└── uploads/                # Attachment storage
```

---

## License

MIT
