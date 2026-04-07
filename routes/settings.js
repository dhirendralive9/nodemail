const express = require("express");
const router  = express.Router();
const dns     = require("dns").promises;
const os      = require("os");
const Domain  = require("../models/Domain");
const Mailbox = require("../models/Mailbox");
const User    = require("../models/User");
const Folder  = require("../models/Folder");
const Email   = require("../models/Email");
const { requireAuth } = require("../lib/auth");

router.use(requireAuth);

// ── Helper: sidebar ──
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

function getServerHostname() {
  return process.env.MAIL_HOSTNAME || os.hostname();
}

// ═══════════════════════════════════════════
//  DOMAINS
// ═══════════════════════════════════════════

router.get("/domains", async (req, res) => {
  const domains = await Domain.find().sort({ createdAt: -1 }).lean();
  const sidebar = await getSidebar(req.session.userId);
  const serverHostname = getServerHostname();

  res.render("settings/domains", {
    domains,
    sidebar,
    session: req.session,
    serverHostname,
    error: req.query.error || null,
    success: req.query.success || null,
  });
});

router.post("/domains/add", async (req, res) => {
  let { domain } = req.body;
  if (!domain) return res.redirect("/domains?error=Domain is required");

  domain = domain.toLowerCase().trim().replace(/^@/, "");
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.redirect("/domains?error=Invalid domain format");
  }

  const exists = await Domain.findOne({ domain });
  if (exists) return res.redirect("/domains?error=Domain already added");

  await Domain.create({ domain, addedBy: req.session.userId });
  res.redirect("/domains?success=Domain added! Configure DNS then verify.");
});

router.post("/domains/:id/delete", async (req, res) => {
  const domainDoc = await Domain.findById(req.params.id);
  if (domainDoc) {
    // Remove mailboxes on this domain
    await Mailbox.deleteMany({ domain: domainDoc.domain });
    await domainDoc.deleteOne();
  }
  res.redirect("/domains?success=Domain and its mailboxes removed");
});

router.post("/domains/:id/verify", async (req, res) => {
  const domainDoc = await Domain.findById(req.params.id);
  if (!domainDoc) return res.redirect("/domains?error=Domain not found");

  const results = { mx: false, spf: false };
  const serverHostname = getServerHostname();

  try {
    const mxRecords = await dns.resolveMx(domainDoc.domain);
    if (mxRecords && mxRecords.length > 0) {
      results.mx = true;
      results.mxRecords = mxRecords.map(r => ({ exchange: r.exchange, priority: r.priority }));
      const pointsToUs = mxRecords.some((mx) => {
        const exchange = mx.exchange.toLowerCase().replace(/\.$/, "");
        return exchange === serverHostname.toLowerCase() ||
               exchange.includes(serverHostname.toLowerCase());
      });
      if (pointsToUs) results.mxPointsToUs = true;
    }
  } catch (err) {
    results.mxError = err.code === "ENODATA" ? "No MX records found" : err.message;
  }

  try {
    const txtRecords = await dns.resolveTxt(domainDoc.domain);
    const flat = txtRecords.map((r) => r.join(""));
    const spfRecord = flat.find((r) => r.startsWith("v=spf1"));
    if (spfRecord) {
      results.spf = true;
      results.spfValue = spfRecord;
    }
  } catch (err) {
    results.spfError = err.code === "ENODATA" ? "No TXT records found" : err.message;
  }

  try {
    const dmarcRecords = await dns.resolveTxt(`_dmarc.${domainDoc.domain}`);
    const flat = dmarcRecords.map((r) => r.join(""));
    const dmarcRecord = flat.find((r) => r.startsWith("v=DMARC1"));
    if (dmarcRecord) {
      results.dmarc = true;
      results.dmarcValue = dmarcRecord;
    }
  } catch (err) { /* optional */ }

  domainDoc.mxConfigured = results.mx;
  domainDoc.spfConfigured = results.spf;
  domainDoc.verified = results.mx && results.spf;
  await domainDoc.save();

  const sidebar = await getSidebar(req.session.userId);
  res.render("settings/domain-verify", {
    domain: domainDoc,
    results,
    sidebar,
    session: req.session,
    serverHostname,
  });
});

router.get("/domains/:id/guide", async (req, res) => {
  const domainDoc = await Domain.findById(req.params.id);
  if (!domainDoc) return res.redirect("/domains?error=Domain not found");

  const sidebar = await getSidebar(req.session.userId);
  const serverHostname = getServerHostname();

  let serverIP = process.env.SERVER_IP || "";
  if (!serverIP) {
    try {
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === "IPv4" && !iface.internal) {
            serverIP = iface.address;
            break;
          }
        }
        if (serverIP) break;
      }
    } catch (_) {}
  }

  res.render("settings/domain-guide", {
    domain: domainDoc,
    sidebar,
    session: req.session,
    serverHostname,
    serverIP,
    smtpHost: process.env.SMTP_HOST || "smtp-relay.brevo.com",
    inboundMode: process.env.INBOUND_MODE || "smtp",
    inboundPort: process.env.INBOUND_SMTP_PORT || 25,
  });
});

// ═══════════════════════════════════════════
//  MAILBOXES
// ═══════════════════════════════════════════

router.get("/mailboxes", async (req, res) => {
  const mailboxes = await Mailbox.find().populate("assignedUsers", "email name").sort({ domain: 1, localPart: 1 }).lean();
  const domains = await Domain.find({ verified: true }).sort("domain").lean();
  const allDomains = await Domain.find().sort("domain").lean();
  const users = await User.find().sort("email").lean();
  const sidebar = await getSidebar(req.session.userId);

  res.render("settings/mailboxes", {
    mailboxes,
    domains,
    allDomains,
    users,
    sidebar,
    session: req.session,
    error: req.query.error || null,
    success: req.query.success || null,
  });
});

router.post("/mailboxes/add", async (req, res) => {
  const { localPart, domain, displayName, catchAll } = req.body;

  if (!localPart || !domain) {
    return res.redirect("/mailboxes?error=Email address and domain are required");
  }

  const clean = localPart.toLowerCase().trim().replace(/[^a-z0-9._-]/g, "");
  if (!clean) return res.redirect("/mailboxes?error=Invalid local part");

  const address = `${clean}@${domain}`;

  // Check domain exists
  const domainDoc = await Domain.findOne({ domain });
  if (!domainDoc) return res.redirect("/mailboxes?error=Domain not found. Add it first.");

  // Check duplicate
  const exists = await Mailbox.findOne({ address });
  if (exists) return res.redirect("/mailboxes?error=Mailbox already exists");

  // If catch-all, unset any existing catch-all on this domain
  if (catchAll === "on") {
    await Mailbox.updateMany({ domain, catchAll: true }, { $set: { catchAll: false } });
  }

  await Mailbox.create({
    address,
    localPart: clean,
    domain,
    displayName: displayName || clean,
    catchAll: catchAll === "on",
  });

  res.redirect(`/mailboxes?success=Mailbox ${address} created`);
});

router.post("/mailboxes/:id/assign", async (req, res) => {
  const { userIds } = req.body;
  const idArr = !userIds ? [] : (Array.isArray(userIds) ? userIds : [userIds]);

  await Mailbox.findByIdAndUpdate(req.params.id, { assignedUsers: idArr });
  res.redirect("/mailboxes?success=Users updated");
});

router.post("/mailboxes/:id/forward", async (req, res) => {
  const { forwardTo, forwardKeepCopy, forwardEnabled } = req.body;
  const mb = await Mailbox.findById(req.params.id);
  if (!mb) return res.redirect("/mailboxes?error=Mailbox not found");

  const addresses = forwardTo
    ? forwardTo.split(",").map(a => a.trim().toLowerCase()).filter(a => a && a.includes("@"))
    : [];

  mb.forwardEnabled = forwardEnabled === "on";
  mb.forwardTo = addresses;
  mb.forwardKeepCopy = forwardKeepCopy === "on";
  await mb.save();

  res.redirect(`/mailboxes?success=Forwarding updated for ${mb.address}`);
});

router.post("/mailboxes/:id/toggle", async (req, res) => {
  const mb = await Mailbox.findById(req.params.id);
  if (mb) {
    mb.active = !mb.active;
    await mb.save();
  }
  res.redirect("/mailboxes");
});

router.post("/mailboxes/:id/delete", async (req, res) => {
  const mb = await Mailbox.findById(req.params.id);
  if (mb) {
    await mb.deleteOne();
  }
  res.redirect("/mailboxes?success=Mailbox deleted");
});

// ═══════════════════════════════════════════
//  USERS
// ═══════════════════════════════════════════

router.get("/users", async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).lean();
  // For each user, find their assigned mailboxes
  for (const u of users) {
    u.mailboxes = await Mailbox.find({ assignedUsers: u._id }).select("address").lean();
  }
  const sidebar = await getSidebar(req.session.userId);

  res.render("settings/users", {
    users,
    sidebar,
    session: req.session,
    error: req.query.error || null,
    success: req.query.success || null,
  });
});

router.post("/users/add", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.redirect("/users?error=Email and password required");

  try {
    await User.create({ email: email.toLowerCase().trim(), password, name: name || "" });
    res.redirect("/users?success=User created. Assign mailboxes in the Mailboxes page.");
  } catch (err) {
    res.redirect(`/users?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/users/:id/delete", async (req, res) => {
  if (req.params.id === req.session.userId.toString()) {
    return res.redirect("/users?error=Cannot delete yourself");
  }
  // Remove user from all mailbox assignments
  await Mailbox.updateMany({ assignedUsers: req.params.id }, { $pull: { assignedUsers: req.params.id } });
  await User.findByIdAndDelete(req.params.id);
  await Email.deleteMany({ owner: req.params.id });
  await Folder.deleteMany({ owner: req.params.id });
  res.redirect("/users?success=User deleted");
});

module.exports = router;
