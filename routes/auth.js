const express = require("express");
const router  = express.Router();
const User    = require("../models/User");

const TURNSTILE_SITE_KEY   = process.env.TURNSTILE_SITE_KEY || "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const TURNSTILE_ENABLED    = !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

router.get("/login", (req, res) => {
  res.render("login", {
    error: null,
    turnstileEnabled: TURNSTILE_ENABLED,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
  });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const renderError = (msg) => res.render("login", {
    error: msg,
    turnstileEnabled: TURNSTILE_ENABLED,
    turnstileSiteKey: TURNSTILE_SITE_KEY,
  });

  // ── Turnstile verification (if enabled) ──
  if (TURNSTILE_ENABLED) {
    const token = req.body["cf-turnstile-response"];
    if (!token) {
      return renderError("Please complete the security check.");
    }

    try {
      const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: req.ip,
        }),
      });

      const result = await verifyRes.json();
      if (!result.success) {
        return renderError("Security check failed. Please try again.");
      }
    } catch (err) {
      console.error("Turnstile verify error:", err);
      return renderError("Security verification error. Please try again.");
    }
  }

  // ── Credential check ──
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !(await user.checkPassword(password))) {
    return renderError("Invalid credentials");
  }

  req.session.userId = user._id;
  req.session.userEmail = user.email;
  req.session.userName = user.name || user.email;
  res.redirect("/");
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
