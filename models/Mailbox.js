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
  // Active or disabled
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

mailboxSchema.index({ domain: 1 });
mailboxSchema.index({ assignedUsers: 1 });

module.exports = mongoose.model("Mailbox", mailboxSchema);
