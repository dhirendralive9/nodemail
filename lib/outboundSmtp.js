const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const bcrypt = require("bcryptjs");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");
const Email   = require("../models/Email");
const { sendMail } = require("./mailer");
const { checkBan, recordAttempt } = require("./ipban");

/**
 * Authenticated SMTP server for outbound mail from Thunderbird/Outlook/etc.
 * Users authenticate with their NodeMail credentials, then send via the
 * configured external SMTP provider.
 */
function startOutboundSMTP(port) {
  const fs = require("fs");
  const hostname = process.env.MAIL_HOSTNAME || "localhost";

  // Try to load SSL certs (Let's Encrypt)
  const certPaths = [
    `/etc/letsencrypt/live/${hostname}`,
    `/etc/letsencrypt/live/${hostname.replace('mail.', '')}`,
  ];

  // Also support custom cert path via env
  if (process.env.TLS_CERT_PATH) {
    certPaths.unshift(process.env.TLS_CERT_PATH);
  }

  let tlsOptions = {};
  for (const certPath of certPaths) {
    try {
      const keyPath = `${certPath}/privkey.pem`;
      const certFile = `${certPath}/fullchain.pem`;
      const key  = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certFile);
      tlsOptions = { key, cert };
      console.log(`SMTP TLS loaded from ${certPath} (key: ${key.length}B, cert: ${cert.length}B)`);
      break;
    } catch (err) {
      console.log(`SMTP TLS: ${certPath} — ${err.code || err.message}`);
    }
  }

  const hasTLS = !!(tlsOptions.key && tlsOptions.cert);
  if (!hasTLS) {
    console.log("SMTP TLS: No valid certs found. STARTTLS disabled. Mail clients may show certificate warnings.");
  }

  const server = new SMTPServer({
    secure: false,                    // STARTTLS, not implicit TLS
    authMethods: ["PLAIN", "LOGIN"],
    size: 30 * 1024 * 1024,
    ...(hasTLS ? { key: tlsOptions.key, cert: tlsOptions.cert } : { disabledCommands: ["STARTTLS"] }),

    // Authenticate with IP ban and login logging
    async onAuth(auth, session, callback) {
      const ip = session.remoteAddress || "unknown";
      const email = (auth.username || "").toLowerCase().trim();

      try {
        const ban = await checkBan(ip);
        if (ban.banned) {
          await recordAttempt({ email, ip, userAgent: "SMTP-client", success: false, reason: "ip_banned" });
          return callback(new Error(`IP banned. Try again in ${ban.remainingMin} minutes.`));
        }

        // Try direct login email match first
        let user = await User.findOne({ email });

        // If not found, check if it's a mailbox address — find the assigned user
        if (!user) {
          const mailbox = await Mailbox.findOne({ address: email, active: true }).populate("assignedUsers");
          if (mailbox && mailbox.assignedUsers && mailbox.assignedUsers.length > 0) {
            // Try each assigned user's password
            for (const assignedUser of mailbox.assignedUsers) {
              const u = await User.findById(assignedUser._id);
              if (u && await u.checkPassword(auth.password)) {
                user = u;
                break;
              }
            }
            if (!user) {
              await recordAttempt({ email, ip, userAgent: "SMTP-client", success: false, reason: "bad_password" });
              return callback(new Error("Invalid credentials"));
            }
          }
        }

        if (!user) {
          await recordAttempt({ email, ip, userAgent: "SMTP-client", success: false, reason: "user_not_found" });
          return callback(new Error("Invalid credentials"));
        }

        // If found via direct email, verify password
        if (email === user.email) {
          const valid = await user.checkPassword(auth.password);
          if (!valid) {
            await recordAttempt({ email, userId: user._id, ip, userAgent: "SMTP-client", success: false, reason: "bad_password" });
            return callback(new Error("Invalid credentials"));
          }
        }

        await recordAttempt({ email, userId: user._id, ip, userAgent: "SMTP-client", success: true, reason: "ok" });

        session.userId = user._id;
        session.userEmail = user.email;
        session.userName = user.name || user.email;

        console.log(`SMTP Auth OK: ${user.email} (login as: ${email}) from ${ip}`);
        callback(null, { user: user.email });
      } catch (err) {
        console.error("SMTP Auth error:", err);
        callback(new Error("Authentication failed"));
      }
    },

    // Verify the sender address is a mailbox the user has access to
    async onMailFrom(address, session, callback) {
      try {
        const fromAddr = address.address.toLowerCase();
        const mailbox = await Mailbox.findOne({ address: fromAddr, active: true });

        if (!mailbox) {
          return callback(new Error(`${fromAddr} is not a registered mailbox`));
        }

        // Check user is assigned to this mailbox (or is admin)
        const firstUser = await User.findOne().sort({ createdAt: 1 });
        const isAdmin = firstUser && firstUser._id.toString() === session.userId.toString();

        if (!isAdmin && !mailbox.assignedUsers.some(id => id.toString() === session.userId.toString())) {
          return callback(new Error(`You don't have permission to send from ${fromAddr}`));
        }

        session.fromMailbox = mailbox;
        callback();
      } catch (err) {
        callback(err);
      }
    },

    onRcptTo(address, session, callback) {
      callback(); // Accept any recipient
    },

    // Parse the message and deliver locally or relay externally
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk) => (raw += chunk.toString()));
      stream.on("end", async () => {
        try {
          const parsed = await simpleParser(raw);
          const mailbox = session.fromMailbox;
          const Domain = require("../models/Domain");

          const fromAddr = mailbox.address;
          const fromName = mailbox.displayName || mailbox.localPart;
          const msgSubject = parsed.subject || "(no subject)";
          const textBody = parsed.text || "";
          const htmlBody = parsed.html || "";
          const now = new Date();

          const allTo = (parsed.to?.value || []).map(r => r.address.toLowerCase());
          const allCc = (parsed.cc?.value || []).map(r => r.address.toLowerCase());
          const allRecipients = [...allTo, ...allCc];

          // Get local domains
          const localDomains = await Domain.find().distinct("domain");
          const localDomainSet = new Set(localDomains);

          const localAddrs = [];
          const externalAddrs = [];

          for (const addr of allRecipients) {
            const domain = addr.split("@")[1];
            if (domain && localDomainSet.has(domain)) {
              localAddrs.push(addr);
            } else {
              externalAddrs.push(addr);
            }
          }

          let messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${fromAddr.split("@")[1]}>`;

          // ── Local delivery ──
          if (localAddrs.length > 0) {
            const deliveredTo = new Set();
            for (const recipientAddr of localAddrs) {
              const [lp, dp] = recipientAddr.split("@");
              let mb = await Mailbox.findOne({ address: recipientAddr, active: true });
              if (!mb) mb = await Mailbox.findOne({ domain: dp, catchAll: true, active: true });
              if (!mb) continue;

              let targetUserIds = [];
              if (mb.assignedUsers && mb.assignedUsers.length > 0) {
                targetUserIds = mb.assignedUsers.map(id => id.toString());
              } else {
                const admin = await User.findOne().sort({ createdAt: 1 });
                if (admin) targetUserIds = [admin._id.toString()];
              }

              for (const userId of targetUserIds) {
                if (deliveredTo.has(userId)) continue;
                deliveredTo.add(userId);
                await Email.create({
                  owner: userId, folder: "inbox", read: false,
                  from: fromAddr, fromName, to: allTo, cc: allCc,
                  subject: msgSubject, textBody, htmlBody,
                  date: now, messageId, attachments: [],
                });
              }
            }
            console.log(`SMTP Relay local: ${fromAddr} → ${localAddrs.join(", ")}`);
          }

          // ── External delivery ──
          if (externalAddrs.length > 0) {
            const info = await sendMail({
              from: `"${fromName}" <${fromAddr}>`,
              to: externalAddrs.filter(a => allTo.includes(a)).join(", ") || undefined,
              cc: externalAddrs.filter(a => allCc.includes(a)).join(", ") || undefined,
              subject: msgSubject,
              text: textBody,
              html: htmlBody,
              inReplyTo: parsed.inReplyTo || undefined,
              references: parsed.references || undefined,
              attachments: (parsed.attachments || []).map(att => ({
                filename: att.filename, content: att.content, contentType: att.contentType,
              })),
            });
            messageId = info.messageId || messageId;
            console.log(`SMTP Relay external: ${fromAddr} → ${externalAddrs.join(", ")} [${messageId}]`);
          }

          // Save to Sent folder
          await Email.create({
            owner: session.userId, folder: "sent", read: true,
            from: fromAddr, fromName, to: allTo, cc: allCc,
            subject: msgSubject, textBody, htmlBody,
            date: now, messageId,
          });

          callback();
        } catch (err) {
          console.error("SMTP Relay error:", err);
          callback(err);
        }
      });
    },
  });

  server.listen(port, () => {
    console.log(`Outbound SMTP relay (for mail clients) listening on port ${port}`);
  });

  server.on("error", (err) => console.error("Outbound SMTP error:", err));
  return server;
}

module.exports = { startOutboundSMTP };
