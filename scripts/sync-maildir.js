#!/usr/bin/env node
//
// sync-maildir.js — Exports emails from MongoDB to Maildir for Dovecot IMAP
//
// Virtual user structure: /var/vmail/{domain}/{localpart}/Maildir/
// Cron: */2 * * * * cd /root/nodemail && node scripts/sync-maildir.js
//

const envPath = require("path").join(__dirname, "..", ".env");
require("dotenv").config({ path: envPath });

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const os = require("os");

const Email   = require("../models/Email");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");

const VMAIL_DIR = process.env.VMAIL_DIR || "/var/vmail";
const SYNC_STATE_FILE = path.join(__dirname, "..", ".maildir-sync-state.json");

const FOLDER_MAP = {
  inbox: "", sent: ".Sent", drafts: ".Drafts", trash: ".Trash", spam: ".Spam",
};

function loadSyncState() {
  try { return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf8")); }
  catch (_) { return { lastSync: null, syncedIds: [] }; }
}

function saveSyncState(state) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
}

function ensureMaildir(basePath) {
  for (const sub of ["new", "cur", "tmp"]) {
    fs.mkdirSync(path.join(basePath, sub), { recursive: true });
  }
}

function emailToRfc822(email) {
  const date = new Date(email.date).toUTCString();
  const headers = [
    `From: ${email.fromName ? email.fromName + " <" + email.from + ">" : email.from}`,
    `To: ${email.to.join(", ")}`,
    email.cc && email.cc.length > 0 ? `Cc: ${email.cc.join(", ")}` : null,
    `Subject: ${email.subject}`,
    `Date: ${date}`,
    `Message-ID: ${email.messageId || "<" + email._id + "@nodemail>"}`,
    email.inReplyTo ? `In-Reply-To: ${email.inReplyTo}` : null,
    `MIME-Version: 1.0`,
  ].filter(Boolean).join("\r\n");

  if (email.htmlBody && email.htmlBody.trim()) {
    const boundary = `----=_Part_${email._id}`;
    return [
      headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      email.textBody || "",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      email.htmlBody,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return `${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${email.textBody || ""}\r\n`;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const state = loadSyncState();
  const syncedSet = new Set(state.syncedIds || []);
  const query = state.lastSync ? { date: { $gte: new Date(state.lastSync) } } : {};
  const emails = await Email.find(query).populate("owner", "email").lean();
  const allMailboxes = await Mailbox.find({ active: true }).lean();

  let synced = 0;

  for (const email of emails) {
    const emailId = email._id.toString();
    if (syncedSet.has(emailId)) continue;
    if (!email.owner || !email.owner.email) continue;

    // Find which mailbox address to deliver to
    const userMailboxes = allMailboxes.filter(
      (mb) => mb.assignedUsers && mb.assignedUsers.some((id) => id.toString() === email.owner._id.toString())
    );

    let targetEmail = null;
    if (email.to) {
      for (const toAddr of email.to) {
        const matched = userMailboxes.find((mb) => mb.address === toAddr.toLowerCase());
        if (matched) { targetEmail = matched.address; break; }
      }
    }
    if (!targetEmail && userMailboxes.length > 0) targetEmail = userMailboxes[0].address;
    if (!targetEmail) targetEmail = email.owner.email;

    const [localPart, domain] = targetEmail.split("@");
    if (!domain) continue;

    const folderSuffix = FOLDER_MAP[email.folder] || "";
    const maildirBase = folderSuffix
      ? path.join(VMAIL_DIR, domain, localPart, "Maildir", folderSuffix)
      : path.join(VMAIL_DIR, domain, localPart, "Maildir");

    ensureMaildir(maildirBase);

    const subdir = email.read ? "cur" : "new";
    const filename = `${Date.now()}.${emailId}.${os.hostname()}`;
    const flags = email.read ? ":2,S" : "";

    fs.writeFileSync(path.join(maildirBase, subdir, filename + flags), emailToRfc822(email));
    syncedSet.add(emailId);
    synced++;
  }

  if (synced > 0) {
    try {
      require("child_process").execSync(`chown -R vmail:vmail ${VMAIL_DIR}`, { stdio: "pipe" });
    } catch (_) {}
    console.log(`Synced ${synced} emails to Maildir`);
  }

  saveSyncState({
    lastSync: new Date().toISOString(),
    syncedIds: [...syncedSet].slice(-50000),
  });

  await mongoose.disconnect();
}

main().catch((err) => { console.error("Sync error:", err.message); process.exit(1); });
