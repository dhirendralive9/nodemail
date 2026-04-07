#!/usr/bin/env node
/**
 * sync-maildir.js
 *
 * Exports emails from MongoDB to Maildir format so Dovecot can serve them via IMAP.
 * Run via cron every few minutes: */5 * * * * cd /root/nodemail && node scripts/sync-maildir.js
 *
 * Maildir structure per user:
 *   /home/{username}/Maildir/
 *     new/     — unread messages
 *     cur/     — read messages
 *     .Sent/new/
 *     .Drafts/new/
 *     .Trash/new/
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const os = require("os");

const Email   = require("../models/Email");
const User    = require("../models/User");
const Mailbox = require("../models/Mailbox");

// Map NodeMail folders to Maildir subdirs
const FOLDER_MAP = {
  inbox:  "",        // root Maildir = inbox
  sent:   ".Sent",
  drafts: ".Drafts",
  trash:  ".Trash",
};

// Track synced emails to avoid re-exporting
const SYNC_STATE_FILE = path.join(__dirname, "..", ".maildir-sync-state.json");

function loadSyncState() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf8"));
  } catch (_) {
    return { lastSync: null, syncedIds: [] };
  }
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
    `From: ${email.fromName ? email.fromName + ' <' + email.from + '>' : email.from}`,
    `To: ${email.to.join(", ")}`,
    email.cc && email.cc.length > 0 ? `Cc: ${email.cc.join(", ")}` : null,
    `Subject: ${email.subject}`,
    `Date: ${date}`,
    `Message-ID: ${email.messageId || '<' + email._id + '@nodemail>'}`,
    email.inReplyTo ? `In-Reply-To: ${email.inReplyTo}` : null,
    `MIME-Version: 1.0`,
  ].filter(Boolean).join("\r\n");

  if (email.htmlBody && email.htmlBody.trim()) {
    const boundary = `----=_Part_${email._id}`;
    return `${headers}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${email.textBody || ''}\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${email.htmlBody}\r\n\r\n--${boundary}--\r\n`;
  }

  return `${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${email.textBody || ''}\r\n`;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const state = loadSyncState();
  const syncedSet = new Set(state.syncedIds || []);

  // Find all emails not yet synced
  const query = state.lastSync
    ? { date: { $gte: new Date(state.lastSync) } }
    : {};

  const emails = await Email.find(query).populate("owner", "email").lean();
  let synced = 0;

  for (const email of emails) {
    const emailId = email._id.toString();
    if (syncedSet.has(emailId)) continue;

    if (!email.owner || !email.owner.email) continue;

    // Determine system username from owner email (local part)
    const username = email.owner.email.split("@")[0];
    const homeDir = `/home/${username}`;

    // Check if system user exists
    if (!fs.existsSync(homeDir)) continue;

    // Determine Maildir subfolder
    const folderSuffix = FOLDER_MAP[email.folder] ?? "";
    const maildirBase = folderSuffix
      ? path.join(homeDir, "Maildir", folderSuffix)
      : path.join(homeDir, "Maildir");

    ensureMaildir(maildirBase);

    // Write email as RFC822 file
    const subdir = email.read ? "cur" : "new";
    const filename = `${Date.now()}.${emailId}.${os.hostname()}`;
    const flags = email.read ? ":2,S" : "";
    const filePath = path.join(maildirBase, subdir, filename + flags);

    const rfc822 = emailToRfc822(email);
    fs.writeFileSync(filePath, rfc822);

    syncedSet.add(emailId);
    synced++;
  }

  // Save state
  saveSyncState({
    lastSync: new Date().toISOString(),
    syncedIds: [...syncedSet].slice(-10000), // keep last 10k IDs
  });

  if (synced > 0) {
    console.log(`Synced ${synced} emails to Maildir`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Sync error:", err);
  process.exit(1);
});
