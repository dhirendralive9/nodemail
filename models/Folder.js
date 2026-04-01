const mongoose = require("mongoose");

const folderSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name:  { type: String, required: true, trim: true },
  color: { type: String, default: "#6366f1" },
});

folderSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Folder", folderSchema);
