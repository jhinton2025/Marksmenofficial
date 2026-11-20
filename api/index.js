const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

const ORDERS_INBOX = "orders@marksmenofficial.com";

// Lazy Supabase client: a missing/bad Supabase env var no longer crashes
// the whole function (which also took down /api/contact).
let _sb = null;
const supabaseProxy = new Proxy({}, {
  get(_, prop) {
    if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const v = _sb[prop];
    return typeof v === "function" ? v.bind(_sb) : v;
  }
});
const supabase = supabaseProxy;

// One shared transporter. Port 465 => secure automatically (Hostinger uses 465/SSL).
let _t = null;
function mail() {
  if (_t) return _t;
  const port = Number(process.env.SMTP_PORT || 465);
  _t = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.hostinger.com",
    port,
    secure: process.env.SMTP_SECURE ? String(process.env.SMTP_SECURE) === "true" : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });
  return _t;
}

// Most SMTP hosts (Hostinger included) reject or junk mail whose From address
// is not the mailbox you logged in with. Always send FROM the SMTP_USER
// address; MAIL_FROM is used only for the display name.
function fromAddr() {
  const user = process.env.SMTP_USER;
  const raw = process.env.MAIL_FROM || "";
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = (m && m[1].trim()) || (raw && !raw.includes("@") ? raw.trim() : "Marksmen");
  return { name, address: user };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = s => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 6, fileSize: 1024 * 1024 },
  fileFilter: (req, f, cb) => {
    if (!allowed.has(f.mimetype)) { const e = new Error("Images only. Upload JPG, PNG or WEBP files."); e.code = "INVALID_FILE_TYPE"; return cb(e); }
    cb(null, true);
  }
});
function validImage(f) {
  const b = f.buffer;
  if (f.mimetype === "image/png") return b.length > 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71;
  if (f.mimetype === "image/jpeg") return b.length > 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (f.mimetype === "image/webp") return b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  return false;
}

app.get("/", (q, r) => r.json({ ok: true, service: "marksmen-orders-backend" }));

// Diagnostic: GET /api/mail-check?key=YOUR_MAIL_CHECK_KEY
// Logs into SMTP and reports the exact error. Set MAIL_CHECK_KEY in Vercel first.
app.get("/api/mail-check", async (q, r) => {
  if (!process.env.MAIL_CHECK_KEY || q.query.key !== process.env.MAIL_CHECK_KEY) return r.status(404).end();
  const cfg = {
    host: process.env.SMTP_HOST || "smtp.hostinger.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE ? String(process.env.SMTP_SECURE) === "true" : Number(process.env.SMTP_PORT || 465) === 465,
    user: process.env.SMTP_USER || "(missing)",
    passSet: Boolean(process.env.SMTP_PASS),
    from: fromAddr()
  };
  try {
    await mail().verify();
    if (q.query.to && EMAIL_RE.test(q.query.to)) {
      const info = await mail().sendMail({ from: cfg.from, to: q.query.to, subject: "Marksmen mail test", text: "SMTP test from the Marksmen backend." });
      return r.json({ ok: true, cfg, sent: info.response, accepted: info.accepted, rejected: info.rejected });
    }
    r.json({ ok: true, cfg, login: "SMTP login OK" });
  } catch (e) {
    r.status(500).json({ ok: false, cfg, error: e.message, code: e.code, response: e.response });
  }
});

app.post("/api/contact", async (q, r) => {
  const { name, email, message } = q.body || {};
  const cleanEmail = String(email || "").trim();
  if (!cleanEmail || !message) return r.status(400).json({ ok: false, error: "Name, email and message are required." });
  if (!EMAIL_RE.test(cleanEmail)) return r.status(400).json({ ok: false, error: "Please enter a valid email address." });

  const t = mail();
  const from = fromAddr();
  const who = name || "there";

  // Send both at once and independently, so one failing doesn't block the other.
  const [inbox, confirm] = await Promise.allSettled([
    t.sendMail({
      from, to: ORDERS_INBOX, replyTo: cleanEmail,
      subject: `Contact — ${name || "Client"}`,
      text: `Name: ${name || "—"}\nEmail: ${cleanEmail}\n\n${message}`
    }),
    t.sendMail({
      from, to: cleanEmail, replyTo: ORDERS_INBOX,
      subject: "We received your message — Marksmen",
      text: `Hi ${who},\n\nThanks for contacting Marksmen. We received your message and will respond by email.\n\nYour message:\n${message}\n\n— Marksmen Orders\n${ORDERS_INBOX}`,
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;line-height:1.5">
<p>Hi ${esc(who)},</p>
<p>Thanks for contacting Marksmen. We received your message and will respond by email.</p>
<p style="color:#555;border-left:3px solid #ccc;padding-left:12px;white-space:pre-wrap">${esc(message)}</p>
<p>— Marksmen Orders<br><a href="mailto:${ORDERS_INBOX}">${ORDERS_INBOX}</a></p></div>`
    })
  ]);

  if (inbox.status === "rejected") console.error("CONTACT inbox send failed:", inbox.reason);
  if (confirm.status === "rejected") console.error("CONTACT confirmation send failed to", cleanEmail, confirm.reason);
  else console.log("CONTACT confirmation accepted:", confirm.value.accepted, confirm.value.response);

  if (inbox.status === "rejected" && confirm.status === "rejected")
    return r.status(500).json({ ok: false, error: "Message could not be sent. Please email " + ORDERS_INBOX + " directly." });

  r.json({ ok: true, delivered: inbox.status === "fulfilled", confirmationSent: confirm.status === "fulfilled" });
});

app.post("/api/custom-order",upload.array("refs",6),async(q,r)=>{try{const b=q.body||{};if(!b.email||!b.fit||!b.size||!b.leather)return r.status(400).json({ok:false,error:"Email, fit, size and leather are required."});const files=q.files||[];if(files.some(f=>!validImage(f)))return r.status(415).json({ok:false,error:"Invalid image file. JPG, PNG and WEBP only."});const{data:orderId,error:rpcError}=await supabase.rpc("next_marksmen_order_id");if(rpcError)throw rpcError;const measurements={chest:b.mChest||"",waistHalf:b.mWaistHalf||"",bicepHalf:b.mBicepHalf||"",sleeve:b.mSleeve||"",backLength:b.mBackLength||"",shoulders:b.mShoulders||"",sleeveOpeningHalf:b.mSleeveOpeningHalf||"",cuffOpeningHalf:b.mCuffOpeningHalf||""};const payload={orderId,...b,measurements,createdAt:new Date().toISOString()};const{error:saveError}=await supabase.from("custom_orders").insert([{order_id:orderId,email:b.email,payload}]);if(saveError)throw saveError;const attachments=files.map(f=>({filename:f.originalname,content:f.buffer,contentType:f.mimetype}));const text=[`ORDER ID: ${orderId}`,"MARKSMEN CUSTOM RACING JACKET REQUEST","--------------------------------",`Client: ${b.name||"—"}`,`Email: ${b.email}`,`Fit: ${b.fit}`,`Size: ${b.size}`,`Leather: ${b.leather}`,"","MEASUREMENTS",`Chest: ${measurements.chest||"—"}`,`Waist (Half): ${measurements.waistHalf||"—"}`,`Bicep (Half): ${measurements.bicepHalf||"—"}`,`Sleeve: ${measurements.sleeve||"—"}`,`Back Length: ${measurements.backLength||"—"}`,`Shoulders: ${measurements.shoulders||"—"}`,`Sleeve Opening (Half): ${measurements.sleeveOpeningHalf||"—"}`,`Cuff Opening (Half): ${measurements.cuffOpeningHalf||"—"}`,"","PLACEMENT",`FRONT: ${b.front||"—"}`,`BACK: ${b.back||"—"}`,`LEFT ARM: ${b.leftArm||"—"}`,`RIGHT ARM: ${b.rightArm||"—"}`,`INSIDE LINING: ${b.lining||"—"}`,"",`Complexity: ${b.complexity||"standard"}`,`Patch Count: ${b.patchCount||"—"}`,`Estimated Total: ${b.estimatedTotal||"$799"}`,`Lead Time: ${b.leadTime||"6–8 weeks"}`,"","MORE DETAILS",b.details||"—"].join("\n");const t=mail();await t.sendMail({from:fromAddr(),to:"orders@marksmenofficial.com",replyTo:b.email,subject:`Custom Order ${orderId} — ${b.name||"Client"}`,text,attachments});await t.sendMail({from:fromAddr(),to:b.email,subject:`Marksmen Custom Order Received — ${orderId}`,text:`Hi ${b.name||"there"},\n\nYour custom jacket request has been received.\n\nOrder ID: ${orderId}\nLead time: 6–8 weeks after approval + payment.\n\nWe will review your design details and respond by email.\n\n— Marksmen Orders\norders@marksmenofficial.com`});r.json({ok:true,orderId})}catch(e){console.error(e);if(e.code==="INVALID_FILE_TYPE")return r.status(415).json({ok:false,error:e.message});if(e.code==="LIMIT_FILE_SIZE")return r.status(413).json({ok:false,error:"Each image must be 1MB or smaller."});r.status(500).json({ok:false,error:"Order submission failed. Check Vercel environment variables and Supabase setup."})}});

module.exports = app;
