#!/usr/bin/env node
//
// dovecot-auth.js
//
// Dovecot checkpassword-compatible auth script.
// Authenticates users against NodeMail's MongoDB using full email address.
//
// Dovecot config:
//   passdb {
//     driver = checkpassword
//     args = /root/nodemail/scripts/dovecot-auth.js
//   }
//
// Protocol: reads from fd 3 (username\0password\0), exits 0 for success, 1 for fail.
//

const fs = require("fs");
const path = require("path");

// Load .env
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const MAIL_DIR_BASE = process.env.VMAIL_DIR || "/var/vmail";

async function main() {
  // Read credentials from fd 3 (Dovecot checkpassword protocol)
  let input = "";
  try {
    input = fs.readFileSync(3, "utf8");
  } catch (e) {
    // Fallback: read from fd 0 (stdin) for testing
    if (process.argv[2] && process.argv[3]) {
      input = `${process.argv[2]}\0${process.argv[3]}\0`;
    } else {
      process.exit(1);
    }
  }

  const parts = input.split("\0");
  const username = (parts[0] || "").toLowerCase().trim();
  const password = parts[1] || "";

  if (!username || !password) {
    process.exit(1);
  }

  // Connect to MongoDB
  const mongoose = require("mongoose");
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  } catch (e) {
    console.error("DB connect failed");
    process.exit(111); // temp fail
  }

  const User = require(path.join(__dirname, "..", "models", "User"));
  const Mailbox = require(path.join(__dirname, "..", "models", "Mailbox"));

  // Try direct user login
  let user = await User.findOne({ email: username });

  // If not found, check if it's a mailbox address
  if (!user) {
    const mailbox = await Mailbox.findOne({ address: username, active: true });
    if (mailbox && mailbox.assignedUsers && mailbox.assignedUsers.length > 0) {
      // Try first assigned user
      for (const uid of mailbox.assignedUsers) {
        const u = await User.findById(uid);
        if (u && await u.checkPassword(password)) {
          user = u;
          break;
        }
      }
    }
  }

  if (!user) {
    await mongoose.disconnect();
    process.exit(1);
  }

  // Check password (if found via direct email match)
  if (username === user.email) {
    const valid = await user.checkPassword(password);
    if (!valid) {
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // Determine maildir path — use the email address
  const safeUser = username.replace(/[^a-z0-9@._-]/g, "");
  const domain = safeUser.split("@")[1] || "default";
  const localPart = safeUser.split("@")[0] || safeUser;
  const maildir = `${MAIL_DIR_BASE}/${domain}/${localPart}`;

  // Create maildir if needed
  for (const sub of ["new", "cur", "tmp"]) {
    const dir = `${maildir}/Maildir/${sub}`;
    fs.mkdirSync(dir, { recursive: true });
  }

  // Set ownership to vmail user
  try {
    const { execSync } = require("child_process");
    execSync(`chown -R vmail:vmail ${MAIL_DIR_BASE}/${domain}`, { stdio: "pipe" });
  } catch (_) {}

  // Output environment for Dovecot (checkpassword protocol)
  // Write to fd 4 or stdout
  const env = [
    `userdb_uid=vmail`,
    `userdb_gid=vmail`,
    `userdb_home=${maildir}`,
    `userdb_mail=maildir:${maildir}/Maildir`,
    "",
  ].join("\n");

  try {
    fs.writeFileSync(4, env);
  } catch (_) {
    process.stdout.write(env);
  }

  await mongoose.disconnect();

  // Execute the rest of the command chain (Dovecot passes it as args)
  if (process.argv.length > 2 && process.argv[2] !== username) {
    const { execSync } = require("child_process");
    try {
      execSync(process.argv.slice(2).join(" "), { stdio: "inherit" });
    } catch (_) {}
  }

  process.exit(0);
}

main().catch(() => process.exit(111));
