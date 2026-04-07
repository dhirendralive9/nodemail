const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const bcrypt = require("bcryptjs");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");
const Email   = require("../models/Email");
const { sendMail } = require("./mailer");

/**
 * Authenticated SMTP server for outbound mail from Thunderbird/Outlook/etc.
 * Users authenticate with their NodeMail credentials, then send via the
 * configured external SMTP provider.
 */
function startOutboundSMTP(port) {
  const server = new SMTPServer({
    secure: false,
    authMethods: ["PLAIN", "LOGIN"],
    size: 30 * 1024 * 1024,

    // Authenticate against NodeMail user database
    async onAuth(auth, session, callback) {
      try {
        const user = await User.findOne({ email: auth.username.toLowerCase() });
        if (!user) return callback(new Error("Invalid credentials"));

        const valid = await user.checkPassword(auth.password);
        if (!valid) return callback(new Error("Invalid credentials"));

        // Store user info on session
        session.userId = user._id;
        session.userEmail = user.email;
        session.userName = user.name || user.email;

        console.log(`SMTP Auth OK: ${user.email}`);
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
