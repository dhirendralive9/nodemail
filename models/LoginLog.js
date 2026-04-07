const mongoose = require("mongoose");

const loginLogSchema = new mongoose.Schema({
  email:     { type: String, lowercase: true, trim: true, default: "" },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  ip:        { type: String, default: "" },
  userAgent: { type: String, default: "" },
  success:   { type: Boolean, required: true },
  reason:    { type: String, default: "" }, // "ok", "bad_password", "user_not_found", "ip_banned", "turnstile_fail"
  date:      { type: Date, default: Date.now, index: true },
});

loginLogSchema.index({ ip: 1, date: 1 });
loginLogSchema.index({ email: 1, date: 1 });
loginLogSchema.index({ success: 1 });

// Auto-expire logs after 90 days
loginLogSchema.index({ date: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("LoginLog", loginLogSchema);
