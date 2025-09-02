"use strict";

/*──────────────────────────────────────────────────────────────────────
 * app.js – WhatsApp + Express + Socket.IO (QR en web)
 * MODO AVISO: sin OpenAI ni JSON; responde mensaje fijo de lanzamiento
 * + Fallback QR en /qr y /qr.png para Railway
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
const { phoneNumberFormatter } = require("./helpers/formatter"); // mismo helper de tu repo

// ──────────────────────────────────────────────────────────────────────
// 1) Express + Socket.IO
// ──────────────────────────────────────────────────────────────────────
const port   = process.env.PORT || 8080; // Railway inyecta PORT
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));

// Sirve index.html si lo tenés en la raíz del repo
app.get("/", (_req, res) => {
  const indexPath = path.join(__dirname, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.type("html").send(`<!doctype html>
<html lang="es"><meta charset="utf-8"/>
<title>Camila Bot – QR</title>
<body style="font-family:system-ui;padding:24px">
  <h1>Camila Bot</h1>
  <p>Escaneá el QR en <a href="/qr" target="_blank" rel="noreferrer">/qr</a>.</p>
  <p>Health: <a href="/health" target="_blank" rel="noreferrer">/health</a></p>
</body></html>`);
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  mode: "notice-only",
  uptime_s: Math.round(process.uptime()),
  timestamp: new Date().toISOString()
}));

// Fallback QR simple (sin websockets)
let lastQrDataUrl = null;

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

// ──────────────────────────────────────────────────────────────────────
// 2) MENSAJE FIJO (sin gasto de tokens)
// ──────────────────────────────────────────────────────────────────────
const HARD_STOP_MESSAGE = [
  "¡Gracias por tu interés! 😊",
  "Las respuestas del asistente Camila estarán disponibles a partir del 5 de septiembre de 2025 (lanzamiento oficial).",
  "El bot de WhatsApp y los links de inscripción también se habilitarán en esa fecha.",
  "Mientras tanto, podés explorar la información general del sitio. 🙌",
  "(Motivo: se filtró el número antes del lanzamiento)"
].join("\n");

// ──────────────────────────────────────────────────────────────────────
// 3) Cliente WhatsApp + eventos QR hacia la web
// ──────────────────────────────────────────────────────────────────────
const client = new Client({
  restartOnAuthFail: true,
  authStrategy: new LocalAuth({
    // En Railway, usá un Volume y seteá SESSION_PATH=/data/session
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

// QR hacia la web vía Socket.IO
io.on("connection", (socket) => {
  socket.emit("message", "Connecting...");

  client.on("qr", (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        socket.emit("message", "Error generando QR");
        return;
      }
      lastQrDataUrl = url;     // ← guardamos para /qr y /qr.png
      socket.emit("qr", url);
      io.emit("qr", url);      // broadcast por si hay varias conexiones
      socket.emit("message", "QR Code received, scan please!");
    });
  });

  client.on("ready", () => {
    socket.emit("ready", "Whatsapp is ready!");
    socket.emit("message", "Whatsapp is ready!");
  });

  client.on("authenticated", () => {
    socket.emit("authenticated", "Whatsapp is authenticated!");
    socket.emit("message", "Whatsapp is authenticated!");
    console.log("AUTHENTICATED");
  });

  client.on("auth_failure", () => {
    socket.emit("message", "Auth failure, restarting...");
  });

  client.on("disconnected", (_reason) => {
    socket.emit("message", "Whatsapp is disconnected!");
    client.destroy();
    client.initialize();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4) Handler de mensajes – SIEMPRE responde el aviso
//    (cualquier mensaje entrante que no sea "fromMe")
// ──────────────────────────────────────────────────────────────────────
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;           // no nos auto-respondemos
    await msg.reply(HARD_STOP_MESSAGE);
  } catch (err) {
    console.error("❌ Error al responder mensaje:", err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// 5) Inicializar cliente
// ──────────────────────────────────────────────────────────────────────
client.initialize();

// ──────────────────────────────────────────────────────────────────────
// 6) Utilidades + Endpoints REST del repo
// ──────────────────────────────────────────────────────────────────────
const checkRegisteredNumber = async function (number) {
  try {
    const isRegistered = await client.isRegisteredUser(number);
    return isRegistered;
  } catch (_e) {
    return false;
  }
};

// Enviar mensaje directo
app.post("/send-message", [
  body("number").notEmpty(),
  body("message").notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) {
    return res.status(422).json({ status: false, message: errors.mapped() });
  }

  const number  = phoneNumberFormatter(req.body.number);
  const message = String(req.body.message);

  const isRegisteredNumber = await checkRegisteredNumber(number);
  if (!isRegisteredNumber) {
    return res.status(422).json({ status: false, message: "The number is not registered" });
  }

  client.sendMessage(number, message)
    .then((response) => res.status(200).json({ status: true, response }))
    .catch((err) => res.status(500).json({ status: false, response: String(err) }));
});

// Enviar media desde URL
app.post("/send-media", [
  body("number").notEmpty(),
  body("file").notEmpty()
], async (req, res) => {
  try {
    const number  = phoneNumberFormatter(req.body.number);
    const caption = req.body.caption || "";
    const fileUrl = req.body.file;

    const isRegisteredNumber = await checkRegisteredNumber(number);
    if (!isRegisteredNumber) {
      return res.status(422).json({ status: false, message: "The number is not registered" });
    }

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

// Enviar media subiendo archivo (multipart/form-data, campo "file")
app.post("/send-media-upload", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ status: false, message: "No se adjuntó el archivo en 'file'." });
    }
    const number  = phoneNumberFormatter(String(req.body.number || ""));
    const caption = String(req.body.caption || "");
    const up      = req.files.file;

    if (!number) return res.status(400).json({ status: false, message: "Falta 'number'." });

    const isRegisteredNumber = await checkRegisteredNumber(number);
    if (!isRegisteredNumber) {
      return res.status(422).json({ status: false, message: "The number is not registered" });
    }

    const mimetype = up.mimetype || mime.lookup(up.name) || "application/octet-stream";
    const base64   = up.data.toString("base64");
    const media    = new MessageMedia(mimetype, base64, up.name);

    client.sendMessage(number, media, { caption })
      .then((response) => res.status(200).json({ status: true, response }))
      .catch((err) => res.status(500).json({ status: false, response: String(err) }));
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

// Enviar a grupo (por id o nombre exacto)
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
  if (!errors.isEmpty()) {
    return res.status(422).json({ status: false, message: errors.mapped() });
  }

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message   = String(req.body.message);

  try {
    if (!chatId) {
      const group = await findGroupByName(groupName);
      if (!group) {
        return res.status(422).json({ status: false, message: "No group found with name: " + groupName });
      }
      chatId = group.id._serialized;
    }

    client.sendMessage(chatId, message)
      .then((response) => res.status(200).json({ status: true, response }))
      .catch((err) => res.status(500).json({ status: false, response: String(err) }));
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

// Limpiar mensajes de un chat
app.post("/clear-message", [
  body("number").notEmpty()
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) {
    return res.status(422).json({ status: false, message: errors.mapped() });
  }

  const number = phoneNumberFormatter(req.body.number);
  const isRegisteredNumber = await checkRegisteredNumber(number);
  if (!isRegisteredNumber) {
    return res.status(422).json({ status: false, message: "The number is not registered" });
  }

  try {
    const chat = await client.getChatById(number);
    const status = await chat.clearMessages();
    res.status(200).json({ status: true, response: status });
  } catch (err) {
    res.status(500).json({ status: false, response: String(err) });
  }
});

// Broadcast simple a lista de números (JSON: ["549388...", "..."])
app.post("/broadcast", [
  body("numbers").isArray({ min: 1 }),
  body("message").notEmpty()
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) {
    return res.status(422).json({ status: false, message: errors.mapped() });
  }

  const numbers = req.body.numbers.map((n) => phoneNumberFormatter(String(n)));
  const message = String(req.body.message);
  const results = [];

  for (const number of numbers) {
    try {
      const isRegistered = await checkRegisteredNumber(number);
      if (!isRegistered) {
        results.push({ number, ok: false, error: "not_registered" });
        continue;
      }
      const resp = await client.sendMessage(number, message);
      results.push({ number, ok: true, id: resp.id?._serialized || null });
    } catch (e) {
      results.push({ number, ok: false, error: String(e) });
    }
  }

  res.json({ status: true, sent: results });
});

// ──────────────────────────────────────────────────────────────────────
// 7) Arranque servidor
// ──────────────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log("App running on *:" + port + " (notice-only mode)");
});
