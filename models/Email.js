const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema({
  filename:    String,
  contentType: String,
  size:        Number,
  path:        String,   // local file path
}, { _id: true });

const emailSchema = new mongoose.Schema({
  owner:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  folder:     { type: String, default: "inbox", index: true },  // inbox, sent, drafts, trash, or custom
  from:       { type: String, required: true },
  fromName:   { type: String, default: "" },
  to:         [{ type: String }],
  cc:         [{ type: String }],
  bcc:        [{ type: String }],
  subject:    { type: String, default: "(no subject)" },
  textBody:   { type: String, default: "" },
  htmlBody:   { type: String, default: "" },
  date:       { type: Date, default: Date.now, index: true },
  messageId:  { type: String, default: "" },
  inReplyTo:  { type: String, default: "" },
  references: [{ type: String }],
  read:       { type: Boolean, default: false },
  starred:    { type: Boolean, default: false },
  attachments:[ attachmentSchema ],
});

// text index for search
emailSchema.index({ subject: "text", textBody: "text", from: "text", to: "text" });

module.exports = mongoose.model("Email", emailSchema);
