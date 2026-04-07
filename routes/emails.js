const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const Email   = require("../models/Email");
const Folder  = require("../models/Folder");
const Mailbox = require("../models/Mailbox");
const Domain  = require("../models/Domain");
const User    = require("../models/User");
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

// ── Helper: get user's available mailboxes (assigned + admin gets all) ──
async function getUserMailboxes(userId) {
  // Check if user is admin (first user created)
  const firstUser = await require("../models/User").findOne().sort({ createdAt: 1 });
  const isAdmin = firstUser && firstUser._id.toString() === userId.toString();

  if (isAdmin) {
    return Mailbox.find({ active: true }).sort({ domain: 1, localPart: 1 }).lean();
  }
  return Mailbox.find({ assignedUsers: userId, active: true }).sort({ domain: 1, localPart: 1 }).lean();
}

// ── Compose form ──
router.get("/compose", async (req, res) => {
  const sidebar = await getSidebar(req.session.userId);
  const mailboxes = await getUserMailboxes(req.session.userId);
  res.render("emails/compose", {
    sidebar,
    session: req.session,
    mailboxes,
    prefill: { to: req.query.to || "", subject: req.query.subject || "", body: "", cc: "", bcc: "", inReplyTo: "", references: "", fromAddress: "" },
  });
});

// ── Reply form ──
router.get("/reply/:id", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  const sidebar = await getSidebar(req.session.userId);
  const mailboxes = await getUserMailboxes(req.session.userId);
  const subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
  const quotedText = `\n\n--- On ${email.date.toUTCString()}, ${email.from} wrote ---\n${email.textBody}`;

  // Auto-select the right "From" mailbox:
  // 1. Exact match on To field
  // 2. Exact match on CC field
  // 3. Catch-all on the same domain as the To address
  // 4. First available mailbox
  const allTo = [...(email.to || []), ...(email.cc || [])].map(a => a.toLowerCase());

  let matchedMailbox = mailboxes.find(mb => allTo.includes(mb.address));

  if (!matchedMailbox) {
    // Try domain-based catch-all match
    const toDomains = allTo.map(a => a.split("@")[1]).filter(Boolean);
    matchedMailbox = mailboxes.find(mb => mb.catchAll && toDomains.includes(mb.domain));
  }

  if (!matchedMailbox && mailboxes.length > 0) {
    // Fall back to first mailbox on the same domain
    const toDomains = allTo.map(a => a.split("@")[1]).filter(Boolean);
    matchedMailbox = mailboxes.find(mb => toDomains.includes(mb.domain));
  }

  res.render("emails/compose", {
    sidebar,
    session: req.session,
    mailboxes,
    prefill: {
      to: email.from,
      cc: "",
      bcc: "",
      subject,
      body: quotedText,
      inReplyTo: email.messageId,
      references: [...email.references, email.messageId].join(" "),
      fromAddress: matchedMailbox ? matchedMailbox.address : (mailboxes.length > 0 ? mailboxes[0].address : ""),
    },
  });
});

// ── Forward form ──
router.get("/forward/:id", async (req, res) => {
  const email = await Email.findOne({ _id: req.params.id, owner: req.session.userId });
  if (!email) return res.redirect("/");

  const sidebar = await getSidebar(req.session.userId);
  const mailboxes = await getUserMailboxes(req.session.userId);
  const subject = email.subject.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject}`;
  const fwdText = `\n\n--- Forwarded message ---\nFrom: ${email.from}\nDate: ${email.date.toUTCString()}\nSubject: ${email.subject}\n\n${email.textBody}`;

  res.render("emails/compose", {
    sidebar,
    session: req.session,
    mailboxes,
    prefill: { to: "", cc: "", bcc: "", subject, body: fwdText, inReplyTo: "", references: "", fromAddress: "" },
  });
});

// ── Send email ──
router.post("/send", upload.array("attachments", 10), async (req, res) => {
  const { to, cc, bcc, subject, body, htmlBody, inReplyTo, references, fromAddress } = req.body;

  if (!to) return res.redirect("/compose");

  // Determine "from" — use selected mailbox or fall back to user email
  let fromAddr = req.session.userEmail;
  let fromName = req.session.userName;

  if (fromAddress) {
    const mailbox = await Mailbox.findOne({ address: fromAddress, active: true });
    if (mailbox) {
      fromAddr = mailbox.address;
      fromName = mailbox.displayName || mailbox.localPart;
    }
  }

  // Build nodemailer attachments
  const fileAtts = (req.files || []).map((f) => ({
    filename: f.originalname,
    path: f.path,
    contentType: f.mimetype,
  }));

  // Saved attachment records for DB
  const savedAtts = (req.files || []).map((f) => ({
    filename: f.originalname,
    contentType: f.mimetype,
    size: f.size,
    path: f.path,
  }));

  // Use rich HTML from Quill if available, fall back to plain text
  const emailHtml = htmlBody && htmlBody.trim()
    ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;color:#222;">${htmlBody}</div>`
    : `<div style="white-space:pre-wrap;font-family:sans-serif;font-size:14px;color:#222;">${(body || '').replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>`;

  const plainText = body || '';
  const msgSubject = subject || "(no subject)";
  const now = new Date();
  const refArr = references ? references.split(" ").filter(Boolean) : [];

  // Parse all recipient addresses
  const allToAddrs = to.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const allCcAddrs = cc ? cc.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const allBccAddrs = bcc ? bcc.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const allRecipients = [...allToAddrs, ...allCcAddrs, ...allBccAddrs];

  // Get all local domains
  const localDomains = await Domain.find().distinct("domain");
  const localDomainSet = new Set(localDomains);

  // Split recipients into local and external
  const localAddrs = [];
  const externalAddrs = [];

  for (const addr of allRecipients) {
    const domain = addr.split("@")[1];
    if (domain && localDomainSet.has(domain)) {
      localAddrs.push(addr);
    } else {
      externalAddrs.push(addr);
    }
  }

  let messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${fromAddr.split("@")[1]}>`;

  try {
    // ── Deliver locally to matching mailboxes ──
    if (localAddrs.length > 0) {
      const deliveredTo = new Set();

      for (const recipientAddr of localAddrs) {
        const [localPart, domainPart] = recipientAddr.split("@");

        // Find mailbox
        let mb = await Mailbox.findOne({ address: recipientAddr, active: true });
        if (!mb) {
          mb = await Mailbox.findOne({ domain: domainPart, catchAll: true, active: true });
        }
        if (!mb) continue;

        // Get target users
        let targetUserIds = [];
        if (mb.assignedUsers && mb.assignedUsers.length > 0) {
          targetUserIds = mb.assignedUsers.map(id => id.toString());
        } else {
          const adminUser = await User.findOne().sort({ createdAt: 1 });
          if (adminUser) targetUserIds = [adminUser._id.toString()];
        }

        for (const userId of targetUserIds) {
          if (deliveredTo.has(userId)) continue;
          deliveredTo.add(userId);

          await Email.create({
            owner:       userId,
            folder:      "inbox",
            from:        fromAddr,
            fromName:    fromName,
            to:          allToAddrs,
            cc:          allCcAddrs,
            subject:     msgSubject,
            textBody:    plainText,
            htmlBody:    emailHtml,
            date:        now,
            messageId:   messageId,
            inReplyTo:   inReplyTo || "",
            references:  refArr,
            read:        false,
            attachments: savedAtts,
          });
        }

        // Handle forwarding for local mailbox
        if (mb.forwardEnabled && mb.forwardTo && mb.forwardTo.length > 0) {
          const { smartForward } = require("../lib/smartForward");
          try {
            await smartForward({
              mailbox: mb, fromAddr, fromName,
              subject: msgSubject, textBody: plainText, htmlBody: emailHtml,
              messageId, date: now, attachments: fileAtts, savedAtts,
            });
          } catch (fwdErr) {
            console.error("Forward error:", fwdErr.message);
          }
        }
      }

      console.log(`Local delivery: ${fromAddr} → ${localAddrs.join(", ")}`);
    }

    // ── Send externally via SMTP provider ──
    if (externalAddrs.length > 0) {
      const externalTo = externalAddrs.filter(a => allToAddrs.includes(a)).join(", ");
      const externalCc = externalAddrs.filter(a => allCcAddrs.includes(a)).join(", ");
      const externalBcc = externalAddrs.filter(a => allBccAddrs.includes(a)).join(", ");

      const info = await sendMail({
        from: `"${fromName}" <${fromAddr}>`,
        to: externalTo || undefined,
        cc: externalCc || undefined,
        bcc: externalBcc || undefined,
        subject: msgSubject,
        text: plainText,
        html: emailHtml,
        inReplyTo: inReplyTo || undefined,
        references: refArr.length > 0 ? refArr : undefined,
        attachments: fileAtts,
      });

      messageId = info.messageId || messageId;
      console.log(`External delivery: ${fromAddr} → ${externalAddrs.join(", ")} [${messageId}]`);
    }

    // ── Save to sender's Sent folder ──
    await Email.create({
      owner:       req.session.userId,
      folder:      "sent",
      from:        fromAddr,
      fromName:    fromName,
      to:          allToAddrs,
      cc:          allCcAddrs,
      bcc:         allBccAddrs,
      subject:     msgSubject,
      textBody:    plainText,
      htmlBody:    emailHtml,
      date:        now,
      messageId:   messageId,
      inReplyTo:   inReplyTo || "",
      references:  refArr,
      read:        true,
      attachments: savedAtts,
    });

    res.redirect("/?folder=sent");
  } catch (err) {
    console.error("Send error:", err);
    const sidebar = await getSidebar(req.session.userId);
    const mailboxes = await getUserMailboxes(req.session.userId);
    res.render("emails/compose", {
      sidebar,
      session: req.session,
      mailboxes,
      prefill: { to, cc, bcc, subject, body, inReplyTo, references, fromAddress },
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
