const { randomUUID } = require("crypto");
const supabase = require("./supabase");

const DEFAULT_BUCKET =
  process.env.SUPABASE_REMINDER_ATTACHMENTS_BUCKET || "reminder-attachments";

function digitsOnly(v) {
  if (v == null || v === "") return "unknown";
  return String(v).replace(/\D/g, "") || "unknown";
}

function extensionForMime(mimeType) {
  const m = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "bin";
}

/**
 * Sube un adjunto de imagen al bucket de recordatorios.
 * @param {{ buffer: Buffer, mimeType: string, ownerPhone: string }} opts
 * @returns {Promise<{ path: string }|{ path: null, error: Error }>}
 */
async function uploadReminderAttachment({ buffer, mimeType, ownerPhone }) {
  if (!buffer?.length || !mimeType) {
    return { path: null, error: new Error("STORAGE_MISSING_BUFFER") };
  }

  const folder = digitsOnly(ownerPhone);
  const ext = extensionForMime(mimeType);
  const objectPath = `${folder}/${randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(DEFAULT_BUCKET)
    .upload(objectPath, buffer, {
      contentType: String(mimeType).split(";")[0].trim(),
      upsert: false,
    });

  if (error) {
    console.error("[storage] upload reminder attachment:", error.message || error);
    return { path: null, error };
  }

  return { path: objectPath };
}

/**
 * URL firmada (HTTPS) para que Twilio descargue el medio al enviar el WhatsApp.
 * @param {string} objectPath - Ruta guardada en attachment_storage_path
 * @param {number} expiresInSec - vigencia (segundos); Twilio suele pedir el archivo en segundos
 */
async function getSignedUrlForReminderPath(objectPath, expiresInSec = 7200) {
  if (!objectPath || typeof objectPath !== "string") return null;
  const { data, error } = await supabase.storage
    .from(DEFAULT_BUCKET)
    .createSignedUrl(objectPath.trim(), expiresInSec);

  if (error) {
    console.error("[storage] createSignedUrl:", error.message || error);
    return null;
  }
  return data?.signedUrl || null;
}

/**
 * Elimina el objeto en Storage (idempotente si ya no existe).
 */
async function removeReminderAttachment(objectPath) {
  if (!objectPath || typeof objectPath !== "string") return;
  const p = objectPath.trim();
  if (!p) return;

  const { error } = await supabase.storage.from(DEFAULT_BUCKET).remove([p]);
  if (error) {
    console.warn("[storage] remove object:", error.message || error);
    return;
  }
  console.log("[storage] objeto eliminado:", p);
}

/**
 * Si ninguna fila de personal_reminders sigue usando esta ruta, borra el fichero en Storage.
 */
async function removeReminderAttachmentIfOrphaned(storagePath) {
  if (!storagePath || typeof storagePath !== "string") return;
  const pathNorm = storagePath.trim();
  if (!pathNorm) return;

  const { count, error } = await supabase
    .from("personal_reminders")
    .select("id", { count: "exact", head: true })
    .eq("attachment_storage_path", pathNorm);

  if (error) {
    console.warn("[storage] comprobación huérfanos:", error.message);
    return;
  }
  if (count === 0) await removeReminderAttachment(pathNorm);
}

module.exports = {
  uploadReminderAttachment,
  getSignedUrlForReminderPath,
  removeReminderAttachment,
  removeReminderAttachmentIfOrphaned,
  reminderAttachmentsBucket: () => DEFAULT_BUCKET,
};
