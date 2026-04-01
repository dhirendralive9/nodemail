const express = require("express");
const router  = express.Router();
const { simpleParser } = require("mailparser");
const { handleIncoming } = require("../lib/inboundSmtp");

/**
 * POST /webhook/inbound
 *
 * Accepts inbound email via webhook from providers like Mailgun or SendGrid.
 *
 * Mailgun: set your route action to forward to https://yourdomain.com/webhook/inbound
 *          and send as raw MIME ("Store and Notify" or "Forward" with raw body).
 *
 * SendGrid: Inbound Parse → set URL to https://yourdomain.com/webhook/inbound
 *
 * This endpoint expects either:
 *   - Raw MIME body (content-type: message/rfc822)
 *   - JSON with a `body-mime` or `email` field containing the raw MIME
 *   - Form-encoded with common fields (from, to, subject, body-plain, body-html)
 */
router.post("/inbound", express.raw({ type: "message/rfc822", limit: "30mb" }), async (req, res) => {
  try {
    let rawMime = null;

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      // Raw MIME
      rawMime = req.body.toString();
    } else if (req.body && typeof req.body === "object") {
      // JSON or form body
      rawMime = req.body["body-mime"] || req.body["email"] || req.body["rawEmail"] || null;
    }

    if (rawMime) {
      await handleIncoming(rawMime, {});
    } else {
      // Fallback: try to construct from form fields (SendGrid style)
      const Email = require("../models/Email");
      const User  = require("../models/User");
      const to = (req.body.to || "").toLowerCase();
      const from = req.body.from || req.body.sender || "unknown";

      const users = await User.find({
        $or: [
          { email: { $regex: new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } },
          { aliases: { $regex: new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } },
        ],
      });

      for (const user of users) {
        await Email.create({
          owner:    user._id,
          folder:   "inbox",
          from:     from,
          to:       [to],
          subject:  req.body.subject || "(no subject)",
          textBody: req.body["body-plain"] || req.body.text || "",
          htmlBody: req.body["body-html"] || req.body.html || "",
          date:     new Date(),
          read:     false,
        });
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("Webhook inbound error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
