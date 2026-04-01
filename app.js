require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));

// ── Nodemailer transporter (Brevo SMTP) ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false, // STARTTLS on 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── GET  / ── render the form ──
app.get("/", (_req, res) => {
  res.render("index", { result: null });
});

// ── POST /send ── send the email ──
app.post("/send", async (req, res) => {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.render("index", {
      result: { ok: false, msg: "All fields are required." },
    });
  }

  try {
    const info = await transporter.sendMail({
      from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
      to,
      subject,
      text: body,
      html: `<p>${body.replace(/\n/g, "<br>")}</p>`,
    });

    console.log("Message sent: %s", info.messageId);
    res.render("index", {
      result: { ok: true, msg: `Email sent! Message ID: ${info.messageId}` },
    });
  } catch (err) {
    console.error("Send error:", err);
    res.render("index", {
      result: { ok: false, msg: `Failed: ${err.message}` },
    });
  }
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Email sender running → http://localhost:${PORT}`));
