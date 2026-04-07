const mongoose = require("mongoose");

const mailboxSchema = new mongoose.Schema({
  // The full email address: hello@shadowpbx.com
  address:   { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Parsed parts
  localPart: { type: String, required: true, lowercase: true, trim: true },
  domain:    { type: String, required: true, lowercase: true, trim: true },
  // Display name used in "From" header
  displayName: { type: String, default: "" },
  // Which users can access this mailbox (send & receive)
  // If empty, only admin can access
  assignedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  // Is this a catch-all for the domain? (receives all unmatched mail)
  catchAll: { type: Boolean, default: false },
  // ── Forwarding ──
  forwardEnabled: { type: Boolean, default: false },
  forwardTo:      [{ type: String, lowercase: true, trim: true }], // external addresses to forward to
  forwardKeepCopy:{ type: Boolean, default: true }, // keep a copy in the inbox or just forward
  // Active or disabled
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

mailboxSchema.index({ domain: 1 });
mailboxSchema.index({ assignedUsers: 1 });

module.exports = mongoose.model("Mailbox", mailboxSchema);
