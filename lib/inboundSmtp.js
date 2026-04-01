const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const Email   = require("../models/Email");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");
const Domain  = require("../models/Domain");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

function startInboundSMTP(port) {
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["AUTH"],
    size: 30 * 1024 * 1024, // 30 MB max message size
    onData(stream, session, callback) {
      let raw = "";
      stream.on("data", (chunk) => (raw += chunk.toString()));
      stream.on("end", async () => {
        try {
          await handleIncoming(raw, session);
          callback();
        } catch (err) {
          console.error("Inbound parse error:", err);
          callback(err);
        }
      });
    },
    onRcptTo(address, session, callback) {
      callback(); // Accept all — we route later
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
      // Deliver to assigned users
      targetUserIds = mailbox.assignedUsers.map(id => id.toString());
    } else {
      // No users assigned — deliver to the admin (first user in DB, or the one who added the domain)
      const adminUser = await User.findOne().sort({ createdAt: 1 });
      if (adminUser) {
        targetUserIds = [adminUser._id.toString()];
      }
    }

    // Create email for each target user (avoid duplicates)
    for (const userId of targetUserIds) {
      if (deliveredTo.has(userId)) continue;
      deliveredTo.add(userId);

      await Email.create({
        owner:  userId,
        folder: "inbox",
        read:   false,
        ...emailData,
      });
    }
  }

  if (deliveredTo.size > 0) {
    console.log(`  Delivered to ${deliveredTo.size} user(s)`);
  } else {
    console.log(`  No delivery — no matching mailboxes or users`);
  }
}

module.exports = { startInboundSMTP, handleIncoming };
