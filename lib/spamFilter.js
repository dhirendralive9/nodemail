const { authenticate } = require("mailauth");
const dns = require("dns").promises;

// Policy: "reject" = drop the email, "flag" = deliver but mark as spam, "allow" = deliver normally
const SPF_POLICY   = process.env.SPAM_SPF_POLICY   || "flag";   // reject | flag | allow
const DKIM_POLICY  = process.env.SPAM_DKIM_POLICY  || "flag";   // reject | flag | allow
const DMARC_POLICY = process.env.SPAM_DMARC_POLICY || "flag";   // reject | flag | allow
const SPAM_ENABLED = process.env.SPAM_FILTER !== "false";        // disable with SPAM_FILTER=false

/**
 * Verify an incoming email's SPF, DKIM, and DMARC.
 *
 * @param {string} rawEmail     - Raw MIME email string
 * @param {string} senderIP     - IP of the sending server
 * @param {string} heloDomain   - HELO/EHLO hostname from SMTP session
 * @param {string} mailFrom     - MAIL FROM address from SMTP envelope
 * @returns {Object} { allow: bool, folder: string, flags: {}, details: {} }
 *   - allow: false = reject (don't deliver at all)
 *   - folder: "inbox" or "spam"
 *   - flags: { spf, dkim, dmarc } = "pass"|"fail"|"none"|"error"
 *   - details: raw verification results
 */
async function verifyEmail(rawEmail, { senderIP, heloDomain, mailFrom }) {
  if (!SPAM_ENABLED) {
    return { allow: true, folder: "inbox", flags: { spf: "skip", dkim: "skip", dmarc: "skip" }, details: {} };
  }

  const result = {
    allow: true,
    folder: "inbox",
    flags: { spf: "none", dkim: "none", dmarc: "none" },
    details: {},
  };

  try {
    // mailauth.authenticate does SPF + DKIM + DMARC + ARC in one call
    const authResult = await authenticate(
      Buffer.isBuffer(rawEmail) ? rawEmail : Buffer.from(rawEmail),
      {
        ip: senderIP || "127.0.0.1",
        helo: heloDomain || "unknown",
        mta: "nodemail",
        sender: mailFrom || "",
      }
    );

    result.details = authResult;

    // ── SPF ──
    if (authResult.spf) {
      const spfResult = authResult.spf.status?.result || "none";
      result.flags.spf = spfResult;

      if (spfResult === "fail" || spfResult === "softfail") {
        if (SPF_POLICY === "reject") {
          result.allow = false;
          console.log(`  SPF ${spfResult} → REJECTED (policy: reject)`);
          return result;
        } else if (SPF_POLICY === "flag") {
          result.folder = "spam";
          console.log(`  SPF ${spfResult} → flagged as spam`);
        }
      } else if (spfResult === "pass") {
        result.flags.spf = "pass";
      }
    }

    // ── DKIM ──
    if (authResult.dkim) {
      const dkimResults = authResult.dkim.results || [];
      const anyPass = dkimResults.some(r => r.status?.result === "pass");
      const anyFail = dkimResults.some(r => r.status?.result === "fail");

      if (anyPass) {
        result.flags.dkim = "pass";
      } else if (anyFail) {
        result.flags.dkim = "fail";

        if (DKIM_POLICY === "reject") {
          result.allow = false;
          console.log(`  DKIM fail → REJECTED (policy: reject)`);
          return result;
        } else if (DKIM_POLICY === "flag") {
          result.folder = "spam";
          console.log(`  DKIM fail → flagged as spam`);
        }
      } else {
        result.flags.dkim = "none";
      }
    }

    // ── DMARC ──
    if (authResult.dmarc) {
      const dmarcResult = authResult.dmarc.status?.result || "none";
      result.flags.dmarc = dmarcResult;

      if (dmarcResult === "fail") {
        if (DMARC_POLICY === "reject") {
          result.allow = false;
          console.log(`  DMARC fail → REJECTED (policy: reject)`);
          return result;
        } else if (DMARC_POLICY === "flag") {
          result.folder = "spam";
          console.log(`  DMARC fail → flagged as spam`);
        }
      }
    }

  } catch (err) {
    console.error("  Spam filter error:", err.message);
    result.flags.spf = "error";
    result.flags.dkim = "error";
    result.flags.dmarc = "error";
    // On error, still deliver (don't lose mail)
  }

  return result;
}

module.exports = { verifyEmail, SPAM_ENABLED };
