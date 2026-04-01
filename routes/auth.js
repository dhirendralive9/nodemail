const express = require("express");
const router  = express.Router();
const User    = require("../models/User");

router.get("/login", (req, res) => {
  res.render("login", { error: null });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user || !(await user.checkPassword(password))) {
    return res.render("login", { error: "Invalid credentials" });
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
