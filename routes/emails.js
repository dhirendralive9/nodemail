const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const Email   = require("../models/Email");
const Folder  = require("../models/Folder");
const { requireAuth } = require("../lib/auth");
const { sendMail }    = require("../lib/mailer");

const upload = multer({
  dest: path.join(__dirname, "..", "uploads"),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

router.use(requireAuth);

// ── Helper: get sidebar counts ──
async function getSidebar(userId) {
  const systemFolders = ["inbox", "sent", "drafts", "trash", "starred"];
  const counts = {};
  for (const f of systemFolders) {
    if (f === "starred") {
      counts[f] = await Email.countDocuments({ owner: userId, starred: true, folder: { $ne: "trash" } });
    } else {
      counts[f] = await Email.countDocuments({ owner: userId, folder: f });
    }
  }
  const customFolders = await Folder.find({ owner: userId }).sort("name");
  for (const cf of customFolders) {
    counts[`custom_${cf._id}`] = await Email.countDocuments({ owner: userId, folder: cf._id.toString() });
  }
  const unread = await Email.countDocuments({ owner: userId, folder: "inbox", read: false });
  return { systemFolders, customFolders, counts, unread };
}

// ── Inbox / folder listing ──
router.get("/", async (req, res) => {
  const folder = req.query.folder || "inbox";
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = 30;
  const skip   = (page - 1) * limit;

  const sidebar = await getSidebar(req.session.userId);

  let query = { owner: req.session.userId };
  let currentFolderName = folder;

  if (folder === "starred") {
    query.starred = true;
    query.folder = { $ne: "trash" };
  } else {
    query.folder = folder;
  }

  // Check if it's a custom folder
  if (!["inbox", "sent", "drafts", "trash", "starred"].includes(folder)) {
    const cf = sidebar.customFolders.find(f => f._id.toString() === folder);
    if (cf) currentFolderName = cf.name;
  }

  const total  = await Email.countDocuments(query);
  const emails = await Email.find(query).sort({ date: -1 }).skip(skip).limit(limit).lean();
  const pages  = Math.ceil(total / limit);

  res.render("inbox", {
    emails,
    folder,
    currentFolderName,
    page,
    pages,
    total,
    sidebar,
    session: req.session,
    query: req.query.q || "",
  });
});

// ── Search ──
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.redirect("/");

  const sidebar = await getSidebar(req.session.userId);

  const emails = await Email.find({
    owner: req.session.userId,
    $text: { $search: q },
    folder: { $ne: "trash" },
  }).sort({ date: -1 }).limit(50).lean();

  res.render("inbox", {
    emails,
    folder: "search",
    currentFolderName: `Search: "${q}"`,
    page: 1,
    pages: 1,
    total: emails.length,
    sidebar,
    session: req.session,
    query: q,
  });
});

// ── Read email ──
router.get("/email/:id", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  if (!email.read) {
    email.read = true;
    await email.save();
  }

  const sidebar = await getSidebar(req.session.userId);
  res.render("emails/read", { email, sidebar, session: req.session });
});

// ── Toggle star ──
router.post("/email/:id/star", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (email) {
    email.starred = !email.starred;
    await email.save();
  }
  res.redirect("back");
});

// ── Toggle read/unread ──
router.post("/email/:id/toggle-read", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (email) {
    email.read = !email.read;
    await email.save();
  }
  res.redirect("back");
});

// ── Move to folder ──
router.post("/email/:id/move", async (req, res) => {
  const { folder } = req.body;
  await Email.updateOne(
    { _id: req.params.id, owner: req.session.userId },
    { $set: { folder } }
  );
  res.redirect("back");
});

// ── Delete (move to trash, or permanently if already in trash) ──
router.post("/email/:id/delete", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  if (email.folder === "trash") {
    // Permanently delete + remove attachment files
    for (const att of email.attachments) {
      try { fs.unlinkSync(att.path); } catch (_) {}
    }
    await email.deleteOne();
  } else {
    email.folder = "trash";
    await email.save();
  }
  res.redirect("/?folder=" + (req.body.returnFolder || "inbox"));
});

// ── Bulk actions ──
router.post("/bulk", async (req, res) => {
  const { ids, action, folder: targetFolder, returnFolder } = req.body;
  if (!ids) return res.redirect("back");

  const idArr = Array.isArray(ids) ? ids : [ids];
  const filter = { _id: { $in: idArr }, owner: req.session.userId };

  switch (action) {
    case "read":
      await Email.updateMany(filter, { $set: { read: true } });
      break;
    case "unread":
      await Email.updateMany(filter, { $set: { read: false } });
      break;
    case "star":
      await Email.updateMany(filter, { $set: { starred: true } });
      break;
    case "trash":
      await Email.updateMany(filter, { $set: { folder: "trash" } });
      break;
    case "move":
      if (targetFolder) await Email.updateMany(filter, { $set: { folder: targetFolder } });
      break;
    case "delete":
      const emails = await Email.find(filter);
      for (const e of emails) {
        for (const att of e.attachments) {
          try { fs.unlinkSync(att.path); } catch (_) {}
        }
      }
      await Email.deleteMany(filter);
      break;
  }
  res.redirect("/?folder=" + (returnFolder || "inbox"));
});

// ── Compose form ──
router.get("/compose", async (req, res) => {
  const sidebar = await getSidebar(req.session.userId);
  res.render("emails/compose", {
    sidebar,
    session: req.session,
    prefill: { to: req.query.to || "", subject: req.query.subject || "", body: "", cc: "", bcc: "", inReplyTo: "", references: "" },
  });
});

// ── Reply form ──
router.get("/reply/:id", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  const sidebar = await getSidebar(req.session.userId);
  const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
  const quotedText = `\n\n--- On ${email.date.toUTCString()}, ${email.from} wrote ---\n${email.textBody}`;

  res.render("emails/compose", {
    sidebar,
    session: req.session,
    prefill: {
      to: email.from,
      cc: "",
      bcc: "",
      subject,
      body: quotedText,
      inReplyTo: email.messageId,
      references: [...email.references, email.messageId].join(" "),
    },
  });
});

// ── Forward form ──
router.get("/forward/:id", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  const sidebar = await getSidebar(req.session.userId);
  const subject = email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`;
  const fwdText = `\n\n--- Forwarded message ---\nFrom: ${email.from}\nDate: ${email.date.toUTCString()}\nSubject: ${email.subject}\n\n${email.textBody}`;

  res.render("emails/compose", {
    sidebar,
    session: req.session,
    prefill: { to: "", cc: "", bcc: "", subject, body: fwdText, inReplyTo: "", references: "" },
  });
});

// ── Send email ──
router.post("/send", upload.array("attachments", 10), async (req, res) => {
  const { to, cc, bcc, subject, body, inReplyTo, references } = req.body;

  if (!to) return res.redirect("/compose");

  const fromAddr = req.session.userEmail;
  const fromName = req.session.userName;

  // Build nodemailer attachments
  const attachments = (req.files || []).map((f) => ({
    filename: f.originalname,
    path: f.path,
    contentType: f.mimetype,
  }));

  try {
    const info = await sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject: subject || "(no subject)",
      text: body,
      html: `<div style="white-space:pre-wrap;font-family:sans-serif;">${body.replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>`,
      inReplyTo: inReplyTo || undefined,
      references: references ? references.split(" ").filter(Boolean) : undefined,
      attachments,
    });

    // Save to Sent folder
    const savedAtts = (req.files || []).map((f) => ({
      filename: f.originalname,
      contentType: f.mimetype,
      size: f.size,
      path: f.path,
    }));

    await Email.create({
      owner:       req.session.userId,
      folder:      "sent",
      from:        fromAddr,
      fromName:    fromName,
      to:          to.split(",").map(s => s.trim()),
      cc:          cc ? cc.split(",").map(s => s.trim()) : [],
      bcc:         bcc ? bcc.split(",").map(s => s.trim()) : [],
      subject:     subject || "(no subject)",
      textBody:    body,
      htmlBody:    `<div style="white-space:pre-wrap;">${body.replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>`,
      date:        new Date(),
      messageId:   info.messageId,
      inReplyTo:   inReplyTo || "",
      references:  references ? references.split(" ").filter(Boolean) : [],
      read:        true,
      attachments: savedAtts,
    });

    res.redirect("/?folder=sent");
  } catch (err) {
    console.error("Send error:", err);
    const sidebar = await getSidebar(req.session.userId);
    res.render("emails/compose", {
      sidebar,
      session: req.session,
      prefill: { to, cc, bcc, subject, body, inReplyTo, references },
      error: err.message,
    });
  }
});

// ── Download attachment ──
router.get("/attachment/:emailId/:attId", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.emailId, owner: req.session.userId });
  if (!email) return res.status(404).send("Not found");

  const att = email.attachments.id(req.params.attId);
  if (!att) return res.status(404).send("Attachment not found");

  res.download(att.path, att.filename);
});

// ── Folder management ──
router.post("/folders/create", async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.redirect("/");
  try {
    await Folder.create({ owner: req.session.userId, name: name.trim(), color: color || "#6366f1" });
  } catch (err) {
    console.error("Folder create error:", err.message);
  }
  res.redirect("/");
});

router.post("/folders/:id/delete", async (req, res) => {
  const folder = await Folder.findOne({ _id: req.params.id, owner: req.session.userId });
  if (folder) {
    // Move emails in this folder back to inbox
    await Email.updateMany(
      { owner: req.session.userId, folder: folder._id.toString() },
      { $set: { folder: "inbox" } }
    );
    await folder.deleteOne();
  }
  res.redirect("/");
});

module.exports = router;
