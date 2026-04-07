const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const Email   = require("../models/Email");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");
const Domain  = require("../models/Domain");
const { verifyEmail } = require("./spamFilter");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

function startInboundSMTP(port) {
  const fs = require("fs");
  const hostname = process.env.MAIL_HOSTNAME || "localhost";

  const certPaths = [
    `/etc/letsencrypt/live/${hostname}`,
    `/etc/letsencrypt/live/${hostname.replace('mail.', '')}`,
  ];
  if (process.env.TLS_CERT_PATH) {
    certPaths.unshift(process.env.TLS_CERT_PATH);
  }

  let tlsOptions = {};
  for (const certPath of certPaths) {
    try {
      const key  = fs.readFileSync(`${certPath}/privkey.pem`);
      const cert = fs.readFileSync(`${certPath}/fullchain.pem`);
      tlsOptions = { key, cert };
      console.log(`Inbound SMTP TLS loaded from ${certPath} (key: ${key.length}B, cert: ${cert.length}B)`);
      break;
    } catch (err) {
      console.log(`Inbound TLS: ${certPath} — ${err.code || err.message}`);
    }
  }

  const hasTLS = !!(tlsOptions.key && tlsOptions.cert);
  if (!hasTLS) {
    console.log("Inbound SMTP TLS: No valid certs found. Running without TLS.");
  }

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: 30 * 1024 * 1024,
    ...(hasTLS ? { key: tlsOptions.key, cert: tlsOptions.cert } : {}),
    onConnect(session, callback) {
      // Store sender IP for spam filtering
      session.senderIP = session.remoteAddress;
      callback();
    },
    onMailFrom(address, session, callback) {
      session.mailFrom = address.address;
      callback();
    },
    onRcptTo(address, session, callback) {
      callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", async () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          await handleIncoming(rawBuffer, session);
          callback();
        } catch (err) {
          console.error("Inbound parse error:", err);
          callback(err);
        }
      });
    },
  });

  server.listen(port, () => {
    console.log(`Inbound SMTP server listening on port ${port}`);
  });

  server.on("error", (err) => console.error("SMTP server error:", err));
  return server;
}

async function handleIncoming(rawEmail, session) {
  const parsed = await simpleParser(rawEmail);

  // Get all recipient addresses
  const allRecipients = [
    ...(parsed.to?.value || []),
    ...(parsed.cc?.value || []),
  ].map((r) => r.address.toLowerCase());

  console.log(`Inbound mail from ${parsed.from?.value?.[0]?.address} to ${allRecipients.join(", ")} — Subject: ${parsed.subject}`);

  // ── SPF / DKIM / DMARC verification ──
  const spamResult = await verifyEmail(rawEmail, {
    senderIP: session.senderIP || session.remoteAddress || "127.0.0.1",
    heloDomain: session.hostNameAppearsAs || session.clientHostname || "unknown",
    mailFrom: session.mailFrom || parsed.from?.value?.[0]?.address || "",
  });

  console.log(`  Auth: SPF=${spamResult.flags.spf} DKIM=${spamResult.flags.dkim} DMARC=${spamResult.flags.dmarc} → ${spamResult.allow ? spamResult.folder : 'REJECTED'}`);

  // If policy says reject, stop here
  if (!spamResult.allow) {
    console.log(`  Email REJECTED by spam filter`);
    return;
  }

  // Save attachments
  const savedAttachments = [];
  if (parsed.attachments && parsed.attachments.length > 0) {
    for (const att of parsed.attachments) {
      const safeName = `${Date.now()}-${att.filename || "attachment"}`;
      const filePath = path.join(UPLOAD_DIR, safeName);
      fs.writeFileSync(filePath, att.content);
      savedAttachments.push({
        filename:    att.filename || "attachment",
        contentType: att.contentType || "application/octet-stream",
        size:        att.size || att.content.length,
        path:        filePath,
      });
    }
  }

  // Build base email data
  const emailData = {
    from:        parsed.from?.value?.[0]?.address || "unknown",
    fromName:    parsed.from?.value?.[0]?.name || "",
    to:          (parsed.to?.value || []).map((r) => r.address),
    cc:          (parsed.cc?.value || []).map((r) => r.address),
    subject:     parsed.subject || "(no subject)",
    textBody:    parsed.text || "",
    htmlBody:    parsed.html || "",
    date:        parsed.date || new Date(),
    messageId:   parsed.messageId || "",
    inReplyTo:   parsed.inReplyTo || "",
    references:  parsed.references || [],
    attachments: savedAttachments,
    spam:        spamResult.folder === "spam",
    authResults: spamResult.flags,
  };

  // For each recipient, find the matching mailbox and deliver
  const deliveredTo = new Set(); // track user IDs we've delivered to

  for (const recipientAddr of allRecipients) {
    const [localPart, domainPart] = recipientAddr.split("@");
    if (!domainPart) continue;

    // Check if we handle this domain
    const domainDoc = await Domain.findOne({ domain: domainPart });
    if (!domainDoc) {
      console.log(`  Domain ${domainPart} not managed, skipping ${recipientAddr}`);
      continue;
    }

    // Find the mailbox
    let mailbox = await Mailbox.findOne({ address: recipientAddr, active: true });

    // If no exact match, check for catch-all on this domain
    if (!mailbox) {
      mailbox = await Mailbox.findOne({ domain: domainPart, catchAll: true, active: true });
      if (mailbox) {
        console.log(`  Catch-all ${mailbox.address} handling ${recipientAddr}`);
      }
    }

    if (!mailbox) {
      console.log(`  No mailbox for ${recipientAddr}, skipping`);
      continue;
    }

    // Determine which users get this email
    let targetUserIds = [];

    if (mailbox.assignedUsers && mailbox.assignedUsers.length > 0) {
      targetUserIds = mailbox.assignedUsers.map(id => id.toString());
    } else {
      const adminUser = await User.findOne().sort({ createdAt: 1 });
      if (adminUser) {
        targetUserIds = [adminUser._id.toString()];
      }
    }

    // If forwarding is enabled and NOT keeping a copy, skip local delivery
    const skipLocal = mailbox.forwardEnabled && !mailbox.forwardKeepCopy;

    // Create email for each target user (avoid duplicates)
    if (!skipLocal) {
      for (const userId of targetUserIds) {
        if (deliveredTo.has(userId)) continue;
        deliveredTo.add(userId);

        await Email.create({
          owner:  userId,
          folder: spamResult.folder === "spam" ? "spam" : "inbox",
          read:   false,
          ...emailData,
        });
      }
    }

    // ── Forward if enabled ──
    if (mailbox.forwardEnabled && mailbox.forwardTo && mailbox.forwardTo.length > 0) {
      try {
        const { smartForward } = require("./smartForward");
        await smartForward({
          mailbox,
          fromAddr: emailData.from,
          fromName: emailData.fromName,
          subject: emailData.subject,
          textBody: emailData.textBody,
          htmlBody: emailData.htmlBody,
          messageId: emailData.messageId,
          date: emailData.date,
          savedAtts: emailData.attachments,
        });
      } catch (fwdErr) {
        console.error(`  Forward error for ${mailbox.address}:`, fwdErr.message);
      }
    }
  }

  if (deliveredTo.size > 0) {
    console.log(`  Delivered to ${deliveredTo.size} user(s)`);
  } else {
    console.log(`  No delivery — no matching mailboxes or users`);
  }
}

module.exports = { startInboundSMTP, handleIncoming };
