#!/bin/bash
#
# NodeMail — Full Installation Script
#
# Usage: bash scripts/install.sh
#
# This script:
#   1. Installs Node.js dependencies
#   2. Creates .env from template if missing
#   3. Sets up PM2 process manager
#   4. Configures Dovecot IMAP with virtual users
#   5. Sets up the Maildir sync cron job
#   6. Opens firewall ports
#
# Requirements:
#   - Debian/Ubuntu server
#   - Root access
#   - Node.js 18+ installed
#   - MongoDB running
#   - Let's Encrypt cert for your mail hostname
#
# Run from the nodemail directory:
#   cd /root/nodemail && bash scripts/install.sh
#

set -e

NODEMAIL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$NODEMAIL_DIR"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         NodeMail — Installation          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Directory: $NODEMAIL_DIR"
echo ""

# ─── 1. Node dependencies ───
echo "[1/7] Installing Node.js dependencies..."
npm install --production 2>/dev/null
echo "  Done"

# ─── 2. Environment file ───
if [ ! -f .env ]; then
  echo "[2/7] Creating .env from template..."
  cp .env.example .env
  echo "  Created .env — EDIT THIS FILE before starting!"
  echo "  nano $NODEMAIL_DIR/.env"
  NEEDS_CONFIG=1
else
  echo "[2/7] .env already exists, skipping"
  NEEDS_CONFIG=0
fi

# Source env for later steps
set -a
source .env 2>/dev/null || true
set +a

MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.localhost}"
VMAIL_DIR="${VMAIL_DIR:-/var/vmail}"

# ─── 3. PM2 setup ───
echo "[3/7] Setting up PM2..."
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2 2>/dev/null
fi
# Stop existing if running
pm2 delete nodemail 2>/dev/null || true
pm2 start app.js --name nodemail --cwd "$NODEMAIL_DIR"
pm2 save 2>/dev/null
pm2 startup 2>/dev/null || true
echo "  Done"

# ─── 4. Dovecot IMAP ───
echo "[4/7] Setting up Dovecot IMAP server..."

# Install Dovecot
if ! command -v dovecot &> /dev/null; then
  apt install -y dovecot-imapd > /dev/null 2>&1
  echo "  Dovecot installed"
else
  echo "  Dovecot already installed"
fi

# Create vmail user
if ! id vmail > /dev/null 2>&1; then
  groupadd -g 5000 vmail 2>/dev/null || true
  useradd -u 5000 -g vmail -s /usr/sbin/nologin -d "$VMAIL_DIR" -m vmail 2>/dev/null || true
  echo "  Created vmail user"
fi
mkdir -p "$VMAIL_DIR"
chown -R vmail:vmail "$VMAIL_DIR"

# Allow dovecot auth to access nodemail directory
chmod 755 /root 2>/dev/null || true

# Create auth wrapper script
cat > /usr/local/bin/nodemail-auth-wrap.sh << 'AUTHEOF'
#!/bin/bash
TMPF=$(mktemp)
cat <&3 > "$TMPF"
USERNAME=$(tr '\0' '\n' < "$TMPF" | sed -n '1p')
PASSWORD=$(tr '\0' '\n' < "$TMPF" | sed -n '2p')
rm -f "$TMPF"

if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
  exit 1
fi

APP_PORT="${NODEMAIL_PORT:-3000}"
RESULT=$(curl -s -X POST "http://127.0.0.1:${APP_PORT}/auth/dovecot" \
  -H "Content-Type: application/json" \
  --data-raw "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
  --max-time 5 2>/dev/null)

if echo "$RESULT" | grep -q '"status":"ok"'; then
  USERDB_HOME=$(echo "$RESULT" | grep -o '"home":"[^"]*"' | cut -d'"' -f4)
  USERDB_MAIL=$(echo "$RESULT" | grep -o '"mail":"[^"]*"' | cut -d'"' -f4)

  mkdir -p "$USERDB_HOME/Maildir/"{new,cur,tmp} 2>/dev/null
  chown -R 5000:5000 "$USERDB_HOME" 2>/dev/null

  export userdb_uid=5000
  export userdb_gid=5000
  export userdb_home="$USERDB_HOME"
  export userdb_mail="$USERDB_MAIL"
  exec "$@"
else
  exit 1
fi
AUTHEOF
chmod +x /usr/local/bin/nodemail-auth-wrap.sh

# Detect SSL cert
CERT_PATH=""
for p in "/etc/letsencrypt/live/$MAIL_HOSTNAME" "/etc/letsencrypt/live/$(echo $MAIL_HOSTNAME | sed 's/mail\.//')"; do
  if [ -f "$p/fullchain.pem" ]; then
    CERT_PATH="$p"
    break
  fi
done

if [ -z "$CERT_PATH" ]; then
  echo "  WARNING: No SSL cert found for $MAIL_HOSTNAME"
  echo "  Run: certbot certonly --standalone -d $MAIL_HOSTNAME"
  SSL_CONF="ssl = no"
else
  echo "  SSL cert: $CERT_PATH"
  SSL_CONF="ssl = required
ssl_cert = <${CERT_PATH}/fullchain.pem
ssl_key = <${CERT_PATH}/privkey.pem
ssl_min_protocol = TLSv1.2"
fi

# Write Dovecot config
cat > /etc/dovecot/local.conf << DOVECONF
# NodeMail Dovecot Configuration — Auto-generated
protocols = imap

${SSL_CONF}

mail_location = maildir:${VMAIL_DIR}/%d/%n/Maildir
mail_uid = vmail
mail_gid = vmail
first_valid_uid = 5000
last_valid_uid = 5000

passdb {
  driver = checkpassword
  args = /usr/local/bin/nodemail-auth-wrap.sh
}

userdb {
  driver = static
  args = uid=vmail gid=vmail home=${VMAIL_DIR}/%d/%n mail=maildir:${VMAIL_DIR}/%d/%n/Maildir
}

namespace inbox {
  inbox = yes
  separator = /

  mailbox Drafts {
    auto = subscribe
    special_use = \Drafts
  }
  mailbox Sent {
    auto = subscribe
    special_use = \Sent
  }
  mailbox Trash {
    auto = subscribe
    special_use = \Trash
  }
  mailbox Spam {
    auto = subscribe
    special_use = \Junk
  }
}

auth_mechanisms = plain login
log_path = /var/log/dovecot.log
auth_verbose = yes

service auth {
  user = root
}

service auth-worker {
  user = root
}
DOVECONF

# Disable default PAM auth
sed -i 's/!include auth-system.conf.ext/#!include auth-system.conf.ext/' /etc/dovecot/conf.d/10-auth.conf 2>/dev/null || true

# Restart Dovecot
systemctl restart dovecot
systemctl enable dovecot 2>/dev/null
echo "  Dovecot configured and running"

# ─── 5. Maildir sync cron ───
echo "[5/7] Setting up Maildir sync cron..."
CRON_CMD="*/2 * * * * cd $NODEMAIL_DIR && /usr/bin/node scripts/sync-maildir.js >> /var/log/nodemail-sync.log 2>&1"
(crontab -l 2>/dev/null | grep -v "sync-maildir"; echo "$CRON_CMD") | crontab -
echo "  Cron added (every 2 minutes)"

# ─── 6. Firewall ───
echo "[6/7] Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 25/tcp > /dev/null 2>&1
  ufw allow 587/tcp > /dev/null 2>&1
  ufw allow 993/tcp > /dev/null 2>&1
  ufw allow 80/tcp > /dev/null 2>&1
  ufw allow 443/tcp > /dev/null 2>&1
  echo "  Ports opened: 25, 587, 993, 80, 443"
elif command -v iptables &> /dev/null; then
  for port in 25 587 993 80 443; do
    iptables -A INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null
  done
  echo "  Ports opened: 25, 587, 993, 80, 443"
else
  echo "  No firewall detected, skipping"
fi

# ─── 7. Verify ───
echo "[7/7] Verifying..."
echo ""

# Check services
OK=0; FAIL=0
check() { if $1 > /dev/null 2>&1; then echo "  ✓ $2"; ((OK++)); else echo "  ✗ $2"; ((FAIL++)); fi; }

check "pm2 pid nodemail" "NodeMail running (PM2)"
check "ss -tlnp | grep -q :25" "Inbound SMTP (port 25)"
check "ss -tlnp | grep -q :587" "Outbound SMTP relay (port 587)"
check "ss -tlnp | grep -q :993" "Dovecot IMAP (port 993)"
check "ss -tlnp | grep -q :3000" "Web UI (port 3000)"

echo ""
echo "══════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo "  All services running! ($OK/$OK)"
else
  echo "  $OK passed, $FAIL failed"
fi
echo "══════════════════════════════════════════"
echo ""
echo "Web UI:    http://$(hostname -I | awk '{print $1}'):3000"
echo "Mail Host: $MAIL_HOSTNAME"
echo ""
if [ "$NEEDS_CONFIG" -eq 1 ]; then
  echo "⚠  IMPORTANT: Edit .env before using:"
  echo "   nano $NODEMAIL_DIR/.env"
  echo ""
fi
echo "Next steps:"
echo "  1. Configure .env with your MongoDB URI and SMTP credentials"
echo "  2. Set up Nginx reverse proxy (see README.md)"
echo "  3. Add domains at /domains in the web UI"
echo "  4. Follow the DNS guide for each domain"
echo ""
