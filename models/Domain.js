const mongoose = require("mongoose");

const domainSchema = new mongoose.Schema({
  domain:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  addedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  verified:  { type: Boolean, default: false },
  mxConfigured:   { type: Boolean, default: false },
  spfConfigured:  { type: Boolean, default: false },
  dkimConfigured: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Domain", domainSchema);
