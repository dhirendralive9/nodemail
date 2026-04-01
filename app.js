require("dotenv").config({ override: true, processEnv: process.env });
const express  = require("express");
const mongoose = require("mongoose");
const session  = require("express-session");
const helmet   = require("helmet");
const path     = require("path");

const User = require("./models/User");

const app = express();

// ── Security ──
app.use(helmet({ contentSecurityPolicy: false }));

// ── Body parsing ──
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Static ──
app.use(express.static(path.join(__dirname, "public")));

// ── View engine ──
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── Sessions ──
app.use(session({
  secret: process.env.SESSION_SECRET || "nodemail-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ── Routes ──
app.use("/", require("./routes/auth"));
app.use("/", require("./routes/emails"));
app.use("/webhook", require("./routes/webhook"));

// ── Boot ──
async function start() {
  // Connect MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log("MongoDB connected");

  // Create default admin user if none exists
  const userCount = await User.countDocuments();
  if (userCount === 0 && process.env.ADMIN_EMAIL) {
    await User.create({
      email:    process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASS || "changeme123",
      name:     "Admin",
    });
    console.log(`Default admin created: ${process.env.ADMIN_EMAIL}`);
  }

  // Start inbound SMTP server if configured
  if (process.env.INBOUND_MODE === "smtp") {
    const { startInboundSMTP } = require("./lib/inboundSmtp");
    startInboundSMTP(Number(process.env.INBOUND_SMTP_PORT) || 25);
  } else {
    console.log("Inbound mode: webhook (POST to /webhook/inbound)");
  }

  // Start Express
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`NodeMail running → http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});
