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

    // Parse the message and relay it via the external SMTP provider
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk) => (raw += chunk.toString()));
      stream.on("end", async () => {
        try {
          const parsed = await simpleParser(raw);
          const mailbox = session.fromMailbox;

          const toAddrs = (parsed.to?.value || []).map(r => r.address).join(", ");
          const ccAddrs = (parsed.cc?.value || []).map(r => r.address).join(", ");

          const info = await sendMail({
            from: `"${mailbox.displayName || mailbox.localPart}" <${mailbox.address}>`,
            to: toAddrs,
            cc: ccAddrs || undefined,
            subject: parsed.subject || "(no subject)",
            text: parsed.text || "",
            html: parsed.html || "",
            inReplyTo: parsed.inReplyTo || undefined,
            references: parsed.references || undefined,
            attachments: (parsed.attachments || []).map(att => ({
              filename: att.filename,
              content: att.content,
              contentType: att.contentType,
            })),
          });

          // Save to Sent folder
          await Email.create({
            owner:       session.userId,
            folder:      "sent",
            from:        mailbox.address,
            fromName:    mailbox.displayName || mailbox.localPart,
            to:          (parsed.to?.value || []).map(r => r.address),
            cc:          (parsed.cc?.value || []).map(r => r.address),
            subject:     parsed.subject || "(no subject)",
            textBody:    parsed.text || "",
            htmlBody:    parsed.html || "",
            date:        new Date(),
            messageId:   info.messageId,
            read:        true,
          });

          console.log(`SMTP Relay: ${mailbox.address} → ${toAddrs} [${info.messageId}]`);
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
