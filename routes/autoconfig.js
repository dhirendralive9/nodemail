const express = require("express");
const router  = express.Router();

const MAIL_HOSTNAME   = process.env.MAIL_HOSTNAME || "mail.localhost";
const IMAP_PORT       = process.env.IMAP_PORT || "993";
const SMTP_RELAY_PORT = process.env.SMTP_RELAY_PORT || "587";

/**
 * Mozilla Thunderbird / Autoconfig
 * Thunderbird checks: https://autoconfig.{domain}/mail/config-v1.1.xml
 * Also checks:        https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml
 */
router.get("/mail/config-v1.1.xml", (req, res) => {
  // Extract domain from query or host header
  const emailDomain = req.query.emailaddress
    ? req.query.emailaddress.split("@")[1]
    : req.hostname.replace("autoconfig.", "");

  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${emailDomain}">
    <domain>${emailDomain}</domain>
    <displayName>NodeMail</displayName>
    <displayShortName>NodeMail</displayShortName>

    <incomingServer type="imap">
      <hostname>${MAIL_HOSTNAME}</hostname>
      <port>${IMAP_PORT}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>

    <outgoingServer type="smtp">
      <hostname>${MAIL_HOSTNAME}</hostname>
      <port>${SMTP_RELAY_PORT}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`);
});

// Also serve at .well-known path
router.get("/.well-known/autoconfig/mail/config-v1.1.xml", (req, res) => {
  req.url = "/mail/config-v1.1.xml";
  router.handle(req, res);
});

/**
 * Microsoft Outlook / Autodiscover
 * Outlook checks: POST https://autodiscover.{domain}/autodiscover/autodiscover.xml
 * Also checks:    POST https://{domain}/autodiscover/autodiscover.xml
 */
router.post("/autodiscover/autodiscover.xml", express.text({ type: "*/xml" }), (req, res) => {
  // Extract email from request body
  let emailAddress = "";
  const match = (req.body || "").match(/<EMailAddress>(.*?)<\/EMailAddress>/i);
  if (match) emailAddress = match[1];
  const localPart = emailAddress.split("@")[0] || "";

  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${MAIL_HOSTNAME}</Server>
        <Port>${IMAP_PORT}</Port>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <LoginName>${emailAddress}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${MAIL_HOSTNAME}</Server>
        <Port>${SMTP_RELAY_PORT}</Port>
        <Encryption>TLS</Encryption>
        <AuthRequired>on</AuthRequired>
        <LoginName>${emailAddress}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`);
});

// Outlook also tries GET
router.get("/autodiscover/autodiscover.xml", (req, res) => {
  const emailAddress = req.query.Email || req.query.email || "";
  const localPart = emailAddress.split("@")[0] || "";
  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${MAIL_HOSTNAME}</Server>
        <Port>${IMAP_PORT}</Port>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <LoginName>${emailAddress}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${MAIL_HOSTNAME}</Server>
        <Port>${SMTP_RELAY_PORT}</Port>
        <Encryption>TLS</Encryption>
        <AuthRequired>on</AuthRequired>
        <LoginName>${emailAddress}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`);
});

/**
 * Apple Mail / iOS
 * Checks: https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml (same as Thunderbird)
 * Also uses a .mobileconfig profile endpoint
 */
router.get("/.well-known/autoconfig", (req, res) => {
  res.redirect("/mail/config-v1.1.xml");
});

/**
 * JSON autoconfig for modern clients
 * Some clients check: https://{domain}/.well-known/mail-v1.json
 */
router.get("/.well-known/mail-v1.json", (req, res) => {
  res.json({
    version: "1.0",
    provider: "NodeMail",
    incoming: {
      type: "imap",
      hostname: MAIL_HOSTNAME,
      port: parseInt(IMAP_PORT),
      security: "tls",
      auth: "plain",
    },
    outgoing: {
      type: "smtp",
      hostname: MAIL_HOSTNAME,
      port: parseInt(SMTP_RELAY_PORT),
      security: "starttls",
      auth: "plain",
    },
  });
});

module.exports = router;
