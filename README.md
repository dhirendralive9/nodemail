# NodeMail

Self-hosted webmail application built with Node.js, Express, EJS, and MongoDB. Send, receive, and manage email across multiple domains with a full-featured web interface and mail client (IMAP/SMTP) support.

## Features

**Email**
- Inbox, Sent, Drafts, Trash, Spam, Starred, custom folders
- Rich text compose with Quill editor (bold, italic, links, images, code blocks)
- Reply, Forward with quoted text and auto-selected From address
- CC, BCC, file attachments (25 MB)
- Full-text search across subject, body, sender, recipient
- Bulk actions (mark read/unread, star, trash, delete)
- Mailbox badge showing which address received each email

**Domains & Mailboxes**
- Multi-domain support — host unlimited domains on one server
- Per-mailbox settings page with forwarding, user assignment, catch-all
- Smart local delivery — emails between local domains skip external SMTP
- DNS setup guide with auto-generated records for each domain
- Auto-provision Nginx + SSL for autoconfig/autodiscover subdomains
- DNS verification (MX, SPF, DMARC) with one-click checking

**Mail Client Support (Thunderbird, Outlook, iOS, Android)**
- Built-in SMTP relay (port 587) with TLS for sending from mail clients
- Dovecot IMAP integration for reading from mail clients
- Autoconfig (Thunderbird) and Autodiscover (Outlook) XML endpoints
- SRV records guide for iOS/Android auto-detection
- Client setup page with per-app instructions and copy buttons

**Security**
- SPF, DKIM, DMARC verification on inbound email (via mailauth)
- Configurable spam policy: reject, flag to spam folder, or allow
- IP-based rate limiting and auto-ban (configurable thresholds)
- Login logging with full audit trail (IP, user agent, success/fail, reason)
- Security dashboard with stats and filterable log viewer
- Optional Cloudflare Turnstile on login page
- TLS on both SMTP servers using Let's Encrypt certs
- Helmet security headers, bcrypt passwords, session auth

**Multi-User**
- Multiple user accounts with independent inboxes
- Mailbox-to-user assignment (many-to-many)
- Users can send from any assigned mailbox
- Admin can access all mailboxes
- Profile page for name and password changes
- User management page for admins

## Requirements

- **Debian/Ubuntu** server (tested on Debian 12)
- **Node.js 20 LTS**
- **MongoDB 4.4+**
- **Domain** with DNS access
- **Port 25** open (most dedicated servers; blocked on AWS/GCP/Azure)
- **SMTP provider** for outbound email (Brevo, Mailgun, SendGrid, SES, etc.)

## Quick Start

```bash
# Clone
git clone https://github.com/your-repo/nodemail.git
cd nodemail

# Configure
cp .env.example .env
nano .env   # Fill in MongoDB URI, SMTP credentials, admin account, hostname

# Install & run everything
sudo bash scripts/install.sh
```

The install script sets up Node dependencies, PM2, Dovecot IMAP, Maildir sync cron, and firewall ports in one command.

## Manual Setup

```bash
# Install dependencies
npm install

# Start the app
node app.js

# Or with PM2 (production)
pm2 start app.js --name nodemail --cwd /root/nodemail
pm2 save && pm2 startup
```

## Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name nodemail.yourdomain.com;

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

Then: `certbot --nginx -d nodemail.yourdomain.com`

## DNS Records

For each domain you add, configure these records. The web UI at `/domains/{id}/guide` generates these for you automatically.

| Type | Name | Value | Notes |
|------|------|-------|-------|
| A | mail | YOUR_SERVER_IP | DNS only (not proxied) |
| MX | @ | mail.yourdomain.com | Priority 10 |
| TXT | @ | v=spf1 include:spf.brevo.com ip4:YOUR_IP ~all | Adjust for your SMTP provider |
| TXT | _dmarc | v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com | |
| CNAME | autoconfig | nodemail.yourdomain.com | DNS only |
| CNAME | autodiscover | nodemail.yourdomain.com | DNS only |
| SRV | _imaps._tcp | 0 1 993 mail.yourdomain.com | For iOS/Android |
| SRV | _submission._tcp | 0 1 587 mail.yourdomain.com | For iOS/Android |

## Architecture

```
                    ┌─────────────────┐
                    │   Cloudflare    │
                    │   (optional)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Port 443       Port 25       Port 587/993
         (HTTPS)       (Inbound)     (Mail Clients)
              │              │              │
         ┌────┴────┐   ┌────┴────┐   ┌────┴────────┐
         │  Nginx  │   │ Inbound │   │ SMTP Relay   │
         │  Proxy  │   │  SMTP   │   │ + Dovecot    │
         └────┬────┘   └────┬────┘   └────┬────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────┴────────┐
                    │    NodeMail     │
                    │  Express App   │
                    │   Port 3000    │
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │    MongoDB      │
                    └─────────────────┘
```

## Project Structure

```
nodemail/
├── app.js                      # Express app entry point
├── .env.example                # Configuration template
├── package.json
│
├── models/
│   ├── User.js                 # Login accounts
│   ├── Email.js                # Email messages + attachments
│   ├── Mailbox.js              # Email addresses (send/receive)
│   ├── Domain.js               # Managed domains
│   ├── Folder.js               # Custom folders
│   └── LoginLog.js             # Login audit trail
│
├── lib/
│   ├── mailer.js               # Outbound SMTP (Nodemailer)
│   ├── inboundSmtp.js          # Inbound SMTP server (port 25)
│   ├── outboundSmtp.js         # SMTP relay for mail clients (port 587)
│   ├── spamFilter.js           # SPF/DKIM/DMARC verification
│   ├── smartForward.js         # Local vs external forwarding
│   ├── ipban.js                # IP rate limiting + ban
│   ├── autoProvision.js        # Auto Nginx + SSL for domains
│   └── auth.js                 # Auth middleware
│
├── routes/
│   ├── auth.js                 # Login, logout, Turnstile, Dovecot auth API
│   ├── emails.js               # Inbox, read, compose, send, folders, bulk
│   ├── settings.js             # Domains, mailboxes, users, profile, security
│   ├── autoconfig.js           # Thunderbird/Outlook auto-detection XML
│   └── webhook.js              # Inbound email webhook (Mailgun/SendGrid)
│
├── views/
│   ├── login.ejs
│   ├── inbox.ejs
│   ├── partials/sidebar.ejs
│   ├── emails/
│   │   ├── compose.ejs         # Rich text editor (Quill)
│   │   └── read.ejs            # Email viewer with auth badges
│   └── settings/
│       ├── domains.ejs
│       ├── domain-guide.ejs    # DNS setup guide
│       ├── domain-verify.ejs   # DNS verification results
│       ├── mailboxes.ejs       # Mailbox list
│       ├── mailbox-settings.ejs # Individual mailbox config
│       ├── users.ejs
│       ├── profile.ejs
│       ├── security.ejs        # Login logs + ban config
│       └── client-setup.ejs    # Mail client connection info
│
├── scripts/
│   ├── install.sh              # One-command installer
│   └── sync-maildir.js         # MongoDB → Maildir sync for Dovecot
│
├── public/
│   ├── css/style.css           # Industrial minimalist dark UI
│   └── js/app.js
│
└── uploads/                    # Attachment storage
```

## Mail Client Setup

Users can view connection settings at `/client-setup` in the web UI.

| Setting | IMAP (Incoming) | SMTP (Outgoing) |
|---------|----------------|-----------------|
| Server | mail.yourdomain.com | mail.yourdomain.com |
| Port | 993 | 587 |
| Security | SSL/TLS | STARTTLS |
| Username | Full email address | Full email address |
| Password | NodeMail password | NodeMail password |

## Environment Variables

See `.env.example` for all options with documentation.

## License

MIT
