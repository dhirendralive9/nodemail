const Domain  = require("../models/Domain");
const Mailbox = require("../models/Mailbox");
const User    = require("../models/User");
const Email   = require("../models/Email");
const { sendMail } = require("./mailer");

/**
 * Smart forward — delivers locally if forward target is a local domain,
 * sends via external SMTP only for non-local targets.
 *
 * @param {Object} opts
 * @param {Object} opts.mailbox       - The mailbox triggering the forward
 * @param {string} opts.fromAddr      - Original sender address
 * @param {string} opts.fromName      - Original sender name
 * @param {string} opts.subject       - Email subject
 * @param {string} opts.textBody      - Plain text body
 * @param {string} opts.htmlBody      - HTML body
 * @param {string} opts.messageId     - Message ID for threading
 * @param {Date}   opts.date          - Email date
 * @param {Array}  opts.attachments   - Nodemailer attachment objects (for external)
 * @param {Array}  opts.savedAtts     - DB attachment records (for local)
 */
async function smartForward(opts) {
  const { mailbox, fromAddr, fromName, subject, textBody, htmlBody, messageId, date, attachments, savedAtts } = opts;

  if (!mailbox.forwardEnabled || !mailbox.forwardTo || mailbox.forwardTo.length === 0) return;

  const fwdAddresses = mailbox.forwardTo.filter(a => a && a.includes("@"));
  if (fwdAddresses.length === 0) return;

  // Get local domains
  const localDomains = await Domain.find().distinct("domain");
  const localDomainSet = new Set(localDomains);

  const localFwd = [];
  const externalFwd = [];

  for (const addr of fwdAddresses) {
    const domain = addr.split("@")[1];
    if (domain && localDomainSet.has(domain)) {
      localFwd.push(addr);
    } else {
      externalFwd.push(addr);
    }
  }

  // ── Local forward delivery ──
  if (localFwd.length > 0) {
    const deliveredTo = new Set();

    for (const recipientAddr of localFwd) {
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
          owner:       userId,
          folder:      "inbox",
          from:        fromAddr,
          fromName:    fromName,
          to:          [recipientAddr],
          subject:     subject,
          textBody:    textBody,
          htmlBody:    htmlBody,
          date:        date || new Date(),
          messageId:   messageId || "",
          read:        false,
          attachments: savedAtts || [],
        });
      }
    }

    console.log(`  Forward (local): ${mailbox.address} → ${localFwd.join(", ")}`);
  }

  // ── External forward via SMTP ──
  if (externalFwd.length > 0) {
    await sendMail({
      from: `"${fromName || fromAddr}" <${mailbox.address}>`,
      to: externalFwd.join(", "),
      subject: `Fwd: ${subject}`,
      text: `--- Forwarded from ${mailbox.address} ---\nOriginal From: ${fromAddr}\n\n${textBody}`,
      html: `<div style="font-family:sans-serif;font-size:13px;color:#888;border-left:3px solid #ccc;padding-left:12px;margin-bottom:16px;">
              <strong>Forwarded from</strong> ${mailbox.address}<br>
              <strong>Original From:</strong> ${fromAddr}
            </div>${htmlBody || textBody.replace(/\n/g, "<br>")}`,
      attachments: attachments || [],
    });

    console.log(`  Forward (external): ${mailbox.address} → ${externalFwd.join(", ")}`);
  }
}

module.exports = { smartForward };
