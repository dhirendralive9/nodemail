const express  = require("express");
const router   = express.Router();
const User     = require("../models/User");
const LoginLog = require("../models/LoginLog");
const { checkBan, recordAttempt, getClientIP } = require("../lib/ipban");

const TURNSTILE_SITE_KEY   = process.env.TURNSTILE_SITE_KEY || "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_ENABLED    = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

router.get("/login", async (req, res) => {
  const ip = getClientIP(req);
  const ban = await checkBan(ip);

  res.render("login", {
    error: ban.banned ? `Too many failed attempts. Try again in ${ban.remainingMin} minute${ban.remainingMin !== 1 ? 's' : ''}.` : null,
    turnstileEnabled: TURNSTILE_ENABLED,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
    banned: ban.banned,
  });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const ip = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "";
  const cleanEmail = (email || "").toLowerCase().trim();

  const renderError = (msg, banned = false) => res.render("login", {
    error: msg,
    turnstileEnabled: TURNSTILE_ENABLED,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
    banned,
  });

  // ── IP ban check ──
  const ban = await checkBan(ip);
  if (ban.banned) {
    await recordAttempt({ email: cleanEmail, ip, userAgent, success: false, reason: "ip_banned" });
    return renderError(`Too many failed attempts. Try again in ${ban.remainingMin} minute${ban.remainingMin !== 1 ? 's' : ''}.`, true);
  }

  // ── Turnstile verification ──
  if (TURNSTILE_ENABLED) {
    const token = req.body["cf-turnstile-response"];
    if (!token) {
      await recordAttempt({ email: cleanEmail, ip, userAgent, success: false, reason: "turnstile_missing" });
      return renderError("Please complete the security check.");
    }

    try {
      const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      });
      const result = await verifyRes.json();
      if (!result.success) {
        await recordAttempt({ email: cleanEmail, ip, userAgent, success: false, reason: "turnstile_fail" });
        return renderError("Security check failed. Please try again.");
      }
    } catch (err) {
      console.error("Turnstile verify error:", err);
      await recordAttempt({ email: cleanEmail, ip, userAgent, success: false, reason: "turnstile_error" });
      return renderError("Security verification error. Please try again.");
    }
  }

  // ── Credential check ──
  const user = await User.findOne({ email: cleanEmail });

  if (!user) {
    await recordAttempt({ email: cleanEmail, ip, userAgent, success: false, reason: "user_not_found" });
    return renderError("Invalid credentials");
  }

  const valid = await user.checkPassword(password);
  if (!valid) {
    await recordAttempt({ email: cleanEmail, userId: user._id, ip, userAgent, success: false, reason: "bad_password" });
    return renderError("Invalid credentials");
  }

  // ── Success ──
  await recordAttempt({ email: cleanEmail, userId: user._id, ip, userAgent, success: true, reason: "ok" });

  req.session.userId = user._id;
  req.session.userEmail = user.email;
  req.session.userName = user.name || user.email;
  res.redirect("/");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
