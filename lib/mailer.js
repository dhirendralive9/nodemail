const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Send an email and return the nodemailer info object.
 * @param {Object} opts - { from, to, cc, bcc, subject, text, html, inReplyTo, references, attachments }
 */
async function sendMail(opts) {
  const mailOpts = {
    from:       opts.from,
    to:         opts.to,
    subject:    opts.subject,
    text:       opts.text || "",
    html:       opts.html || "",
  };
  if (opts.cc)         mailOpts.cc         = opts.cc;
  if (opts.bcc)        mailOpts.bcc        = opts.bcc;
  if (opts.inReplyTo)  mailOpts.inReplyTo  = opts.inReplyTo;
  if (opts.references) mailOpts.references = opts.references;
  if (opts.attachments) mailOpts.attachments = opts.attachments;

  return transporter.sendMail(mailOpts);
}

module.exports = { sendMail, transporter };
