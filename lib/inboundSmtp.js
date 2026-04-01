const { SMTPServer } = require("smtp-server");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const Email = require("../models/Email");
const User  = require("../models/User");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

function startInboundSMTP(port) {
  const server = new SMTPServer({
    authOptional: true,       // accept mail without auth (we're a receiving MTA)
    disabledCommands: ["AUTH"], // no auth required for inbound
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
      // Accept all recipients — we'll match to users later
      callback();
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

  // Determine recipients
  const allRecipients = [
    ...(parsed.to?.value || []),
    ...(parsed.cc?.value || []),
  ].map((r) => r.address.toLowerCase());

  // Find matching users (by email or alias)
  const users = await User.find({
    $or: [
      { email: { $in: allRecipients } },
      { aliases: { $in: allRecipients } },
    ],
  });

  if (users.length === 0) {
    console.log("No matching users for:", allRecipients.join(", "));
    return;
  }

  // Save attachments to disk
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

  // Create an Email document for each matching user
  for (const user of users) {
    await Email.create({
      owner:       user._id,
      folder:      "inbox",
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
      read:        false,
      attachments: savedAttachments,
    });
  }

  console.log(`Received mail for ${users.length} user(s): ${parsed.subject}`);
}

module.exports = { startInboundSMTP, handleIncoming };
