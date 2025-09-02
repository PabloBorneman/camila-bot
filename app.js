"use strict";

/*──────────────────────────────────────────────────────────────────────
 * app.js – WhatsApp + Express + Socket.IO (QR en web)
 * MODO AVISO: sin OpenAI ni JSON; responde mensaje fijo de lanzamiento
 * Logs robustos + listeners de WhatsApp al tope (no dependen de Socket.IO)
 *──────────────────────────────────────────────────────────────────────*/

require("dotenv").config();

const express    = require("express");
const { body, validationResult } = require("express-validator");
const socketIO   = require("socket.io");
const qrcode     = require("qrcode");
const http       = require("http");
const fs         = require("fs");
const path       = require("path");
const axios      = require("axios");
const mime       = require("mime-types");
const fileUpload = require("express-fileupload");
const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const { phoneNumberFormatter } = require("./helpers/formatter");

const port   = process.env.PORT || 8080;
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));

/* ──────────────────────────────────────────────────────────────────── */
/*  Aviso fijo                                                            */
/* ──────────────────────────────────────────────────────────────────── */
const HARD_STOP_MESSAGE = [
  "¡Gracias por tu interés! 😊",
  "Las respuestas del asistente Camila estarán disponibles a partir del 5 de septiembre de 2025 (lanzamiento oficial).",
  "El bot de WhatsApp y los links de inscripción también se habilitarán en esa fecha.",
  "Mientras tanto, podés explorar la información general del sitio. 🙌",
  "(Motivo: se filtró el número antes del lanzamiento)"
].join("\n");

/* ──────────────────────────────────────────────────────────────────── */
/*  WhatsApp Client (listeners al tope, con logs)                         */
/* ──────────────────────────────────────────────────────────────────── */
let WAPP_READY = false;
let lastQrDataUrl = null;

const client = new Client({
  restartOnAuthFail: true,
  authStrategy: new LocalAuth({
    // En Railway: usar un Volume y setear SESSION_PATH=/data/session
    dataPath: process.env.SESSION_PATH || ".wwebjs_auth"
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  }
});

/* Logs de ciclo de vida */
client.on("qr", (qr) => {
  console.log("📱  QR generado (escaneá con WhatsApp).");
  qrcode.toDataURL(qr, (err, url) => {
    if (!err) lastQrDataUrl = url;
  });
});

client.on("authenticated", () => {
  console.log("🔐 AUTHENTICATED");
});

client.on("auth_failure", (m) => {
  console.error("❌ AUTH FAILURE:", m || "");
});

client.on("ready", () => {
  WAPP_READY = true;
  console.log("✅ WhatsApp READY");
});

client.on("disconnected", (reason) => {
  WAPP_READY = false;
  console.warn("⚠️  WhatsApp DISCONNECTED:", reason);
  client.destroy();
  client.initialize();
});

/* Handler de mensajes: responde SIEMPRE el aviso (no a fromMe) */
client.on("message", async (msg) => {
  try {
    console.log("[RX]", {
      from: msg.from,
      fromMe: msg.fromMe,
      type: msg.type,
      body: (msg.body || "").slice(0, 120)
    });

    if (msg.fromMe) {
      console.log("[SKIP] Mensaje propio (fromMe=true)");
      return;
    }

    await client.sendMessage(msg.from, HARD_STOP_MESSAGE);
    console.log("[TX] Aviso enviado a", msg.from);
  } catch (err) {
    console.error("❌ Error en handler de mensaje:", err);
  }
});

/* Inicializar */
client.initialize();

/* ──────────────────────────────────────────────────────────────────── */
/*  Web + QR                                                              */
/* ──────────────────────────────────────────────────────────────────── */
app.get("/", (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"/>
<title>Camila Bot – QR</title>
<body style="font-family:system-ui;padding:24px">
  <h1>Camila Bot</h1>
  <p>Escaneá el QR en <a href="/qr" target="_blank" rel="noreferrer">/qr</a>.</p>
  <p>Health: <a href="/health" target="_blank" rel="noreferrer">/health</a></p>
</body>`);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "notice-only",
    ready: WAPP_READY,
    uptime_s: Math.round(process.uptime()),
    ts: new Date().toISOString()
  });
});

app.get("/qr.png", (_req, res) => {
  if (!lastQrDataUrl) return res.status(503).send("QR aún no generado");
  const base64 = lastQrDataUrl.split(",")[1];
  const buf = Buffer.from(base64, "base64");
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});

app.get("/qr", (_req, res) => {
  res.send(`<!doctype html>
<meta charset="utf-8"/>
<title>QR WhatsApp</title>
<body style="display:grid;place-items:center;height:100vh;background:#0b1320;color:#fff;font-family:system-ui;margin:0">
  <div style="text-align:center;max-width:520px">
    <h1 style="margin:16px 0 8px">Escaneá el QR</h1>
    <img src="/qr.png" style="width:320px;height:320px;background:#fff;padding:8px;border-radius:12px"/>
    <p style="opacity:.8">Si no carga, refrescá la página en 5–10 segundos.</p>
  </div>
</body>`);
});

/* ──────────────────────────────────────────────────────────────────── */
/*  Endpoints REST (opcional)                                             */
/* ──────────────────────────────────────────────────────────────────── */
const checkRegisteredNumber = async function (number) {
  try {
    return await client.isRegisteredUser(number);
  } catch {
    return false;
  }
};

app.post("/send-message", [
  body("number").notEmpty(),
  body("message").notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ status: false, message: errors.mapped() });

  const number  = phoneNumberFormatter(req.body.number);
  const message = String(req.body.message);

  const isRegisteredNumber = await checkRegisteredNumber(number);
  if (!isRegisteredNumber) return res.status(422).json({ status: false, message: "The number is not registered" });

  client.sendMessage(number, message)
    .then((response) => res.status(200).json({ status: true, response }))
    .catch((err) => res.status(500).json({ status: false, response: String(err) }));
});

app.post("/send-media", [
  body("number").notEmpty(),
  body("file").notEmpty()
], async (req, res) => {
  try {
    const number  = phoneNumberFormatter(req.body.number);
    const caption = req.body.caption || "";
    const fileUrl = req.body.file;

    const isRegisteredNumber = await checkRegisteredNumber(number);
    if (!isRegisteredNumber) return res.status(422).json({ status: false, message: "The number is not registered" });

    let mimetype;
    const attachment = await axios.get(fileUrl, { responseType: "arraybuffer" })
      .then((response) => {
        mimetype = response.headers["content-type"] || mime.lookup(fileUrl) || "application/octet-stream";
        return response.data.toString("base64");
      });

    const media = new MessageMedia(mimetype, attachment, path.basename(fileUrl));
    client.sendMessage(number, media, { caption })
      .then((response) => res.status(200).json({ status: true, response }))
      .catch((err) => res.status(500).json({ status: false, response: String(err) }));
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

const findGroupByName = async function (name) {
  const chats = await client.getChats();
  return chats.find((chat) => chat.isGroup && chat.name.toLowerCase() === String(name).toLowerCase());
};

app.post("/send-group-message", [
  body("message").notEmpty(),
  body("id").custom((value, { req }) => {
    if (!value && !req.body.name) throw new Error("Invalid value, you can use `id` or `name`");
    return true;
  })
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ status: false, message: errors.mapped() });

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message   = String(req.body.message);

  try {
    if (!chatId) {
      const group = await findGroupByName(groupName);
      if (!group) return res.status(422).json({ status: false, message: "No group found with name: " + groupName });
      chatId = group.id._serialized;
    }

    client.sendMessage(chatId, message)
      .then((response) => res.status(200).json({ status: true, response }))
      .catch((err) => res.status(500).json({ status: false, response: String(err) }));
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

app.post("/clear-message", [ body("number").notEmpty() ], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) return res.status(422).json({ status: false, message: errors.mapped() });

  const number = phoneNumberFormatter(req.body.number);
  const isRegisteredNumber = await checkRegisteredNumber(number);
  if (!isRegisteredNumber) return res.status(422).json({ status: false, message: "The number is not registered" });

  try {
    const chat = await client.getChatById(number);
    const status = await chat.clearMessages();
    res.status(200).json({ status: true, response: status });
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

/* ──────────────────────────────────────────────────────────────────── */
/*  Socket.IO (solo para mostrar QR en vivo)                              */
/* ──────────────────────────────────────────────────────────────────── */
io.on("connection", (socket) => {
  socket.emit("message", "Connecting...");
  if (lastQrDataUrl) socket.emit("qr", lastQrDataUrl);
});

/* ──────────────────────────────────────────────────────────────────── */
/*  Arranque                                                               */
/* ──────────────────────────────────────────────────────────────────── */
server.listen(port, () => {
  console.log("🚀 App running on *:" + port + " (notice-only mode)");
});
