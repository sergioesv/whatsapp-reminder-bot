/**
 * Entrada de medios vía webhook de Twilio (WhatsApp).
 * Etapa 1: parseo y respuestas sin multimodal.
 * Etapa 2: descarga autenticada desde MediaUrl (Basic: AccountSid + AuthToken).
 */

const MAX_MEDIA_ITEMS = 10;

/** Tamaño máximo por archivo descargado (WhatsApp suele enviar menos). */
const DEFAULT_MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/**
 * Lee NumMedia, MediaUrl{i}, MediaContentType{i} del body form-urlencoded de Twilio.
 * @returns {{ count: number, items: Array<{ url: string, contentType: string }> }}
 */
function parseTwilioInboundMedia(body) {
  if (!body || typeof body !== "object") return { count: 0, items: [] };
  const declared = parseInt(body.NumMedia, 10);
  const n =
    Number.isFinite(declared) && declared > 0 ? Math.min(declared, MAX_MEDIA_ITEMS) : 0;
  const items = [];
  for (let i = 0; i < n; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType =
      String(body[`MediaContentType${i}`] || "").trim() || "application/octet-stream";
    if (url) items.push({ url: String(url), contentType });
  }
  return { count: items.length, items };
}

/** @returns {"image"|"audio"|"video"|"file"} */
function inferMediaKind(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  return "file";
}

/**
 * Respuesta en español cuando hay adjunto(s) pero no hay pie de texto (Etapa 1: sin análisis multimodal).
 */
function replyNoCaptionMediaEs(kind, itemCount = 1) {
  const plural = itemCount > 1;
  if (kind === "image") {
    return plural
      ? "Recibí las imágenes, pero aún no puedo leer su contenido. Eso se irá activando por etapas. Mientras tanto, escribe en texto lo que necesitas (recordatorio, consulta, etc.)."
      : "Recibí la imagen, pero aún no puedo leer su contenido. Eso se irá activando por etapas. Mientras tanto, escribe en texto lo que necesitas (recordatorio, consulta, etc.).";
  }
  if (kind === "audio") {
    return "Por ahora solo proceso texto: las notas de voz no las puedo transcribir todavía. Escribe tu mensaje.";
  }
  if (kind === "video") {
    return "Por ahora no puedo procesar videos. Escribe en texto lo que necesitas.";
  }
  return "Por ahora no puedo procesar este tipo de archivo. Escribe tu solicitud en texto.";
}

/**
 * Descarga un medio desde la URL que envía Twilio en el webhook.
 * Requiere las mismas credenciales que la API de Twilio (no la API key pública del webhook).
 *
 * @param {string} url - MediaUrlN del body
 * @param {{ accountSid: string, authToken: string, maxBytes?: number, fallbackContentType?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function fetchTwilioMediaBuffer(url, options = {}) {
  const accountSid = options.accountSid;
  const authToken = options.authToken;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const fallbackType = options.fallbackContentType || "application/octet-stream";

  if (!url || typeof url !== "string") {
    throw new Error("TWILIO_MEDIA_BAD_URL");
  }
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_MEDIA_MISSING_CREDS");
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(`TWILIO_MEDIA_HTTP_${res.status}`);
  }

  const cl = res.headers.get("content-length");
  if (cl) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error("TWILIO_MEDIA_TOO_LARGE");
    }
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error("TWILIO_MEDIA_TOO_LARGE");
  }

  const rawCt = res.headers.get("content-type");
  const contentType = rawCt
    ? String(rawCt).split(";")[0].trim()
    : fallbackType || "application/octet-stream";

  return { buffer: buf, contentType };
}

/** Texto resumido para interaction_logs cuando solo hay medio(s). */
function inboundMediaLogLabel(kind, itemCount) {
  if (kind === "image" && itemCount > 1) return `[${itemCount} imágenes sin texto]`;
  if (kind === "image") return "[Imagen sin texto]";
  if (kind === "audio") return itemCount > 1 ? `[${itemCount} notas de voz sin texto]` : "[Nota de voz sin texto]";
  if (kind === "video") return itemCount > 1 ? `[${itemCount} videos sin texto]` : "[Video sin texto]";
  return itemCount > 1 ? `[${itemCount} archivos sin texto]` : "[Archivo sin texto]";
}

module.exports = {
  MAX_MEDIA_ITEMS,
  DEFAULT_MAX_MEDIA_BYTES,
  parseTwilioInboundMedia,
  inferMediaKind,
  replyNoCaptionMediaEs,
  inboundMediaLogLabel,
  fetchTwilioMediaBuffer,
};
