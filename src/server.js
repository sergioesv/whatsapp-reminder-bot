const express = require("express");
const path = require("path");
const { performance } = require("perf_hooks");
require("dotenv").config();

const supabase = require("./supabase");
const sendWhatsAppMessage = require("./sendMessage");
const { analyzeMessage } = require("./gemini");
const { searchWeb } = require("./search");
const { getUsage, LIMITS } = require("./usage");
const { version } = require("../package.json");
const { getHeartbeats } = require("./scheduler");

const twilio = require("twilio");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded data
app.use(express.static("public"));

// ---------------------------------------------------------
// PAGE ROUTES
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/documentation", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/documentation.html"));
});

app.get("/status", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/status.html"));
});

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

function digitsOnly(v) {
  if (v == null || v === "") return "";
  return String(v).replace(/\D/g, "");
}

/** Comparación dueño: Twilio envía p. ej. 57300…; MY_PHONE_NUMBER puede tener +, espacios o 10 dígitos locales. */
function isSamePhoneAsOwner(senderRaw, ownerEnvRaw) {
  const s = digitsOnly(senderRaw);
  const o = digitsOnly(ownerEnvRaw);
  if (!s || !o) return false;
  if (s === o) return true;
  if (s.length >= 10 && o.length >= 10 && s.slice(-10) === o.slice(-10)) return true;
  return false;
}

/** Extrae el primer bloque de teléfono (≥10 dígitos) del texto del usuario. */
function extractPhoneFromNaturalMessage(text) {
  if (!text) return "";
  const chunks = text.match(/\d[\d\s\-\.]{8,18}\d/g) || [];
  for (const chunk of chunks) {
    const d = chunk.replace(/\D/g, "");
    if (d.length >= 10 && d.length <= 15) return d;
  }
  const all = text.replace(/\D/g, "");
  if (all.length >= 10 && all.length <= 15) return all;
  return "";
}

function cleanContactNameFromAI(taskOrMessage, userMessage) {
  let n = (taskOrMessage || "").trim();
  n = n.replace(/\s*\+?\d[\d\s\-\.\(\)]{7,}\d\s*$/u, "").trim();
  n = n.replace(/^(guarda|guardar|agrega|añade|add|salva|contacto)\s+/i, "").trim();
  n = n.replace(/^(a|al|a la)\s+/i, "").trim();
  if (!n && userMessage) {
    let u = userMessage.trim();
    u = u.replace(/\s*\+?\d[\d\s\-\.\(\)]{7,}\d\s*$/u, "").trim();
    u = u.replace(/^(guarda|guardar|agrega|añade|add|salva)\s+(contacto\s+)?/i, "").trim();
    u = u.replace(/^(a|al|a la)\s+/i, "").trim();
    n = u;
  }
  return n.trim();
}

// Converts AI-extracted HH:MM:SS to a full COT-offset ISO timestamp
function buildReminderDate(timeString, dateString = null) {
  const now = new Date();

  if (dateString) {
    const reminderDate = new Date(`${dateString}T${timeString}-05:00`);
    return reminderDate.toISOString();
  }

  const formatter = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  const isoString = `${year}-${month}-${day}T${timeString}-05:00`;
  const reminderDate = new Date(isoString);

  if (reminderDate < now) {
    reminderDate.setDate(reminderDate.getDate() + 1);
  }
  return reminderDate.toISOString();
}

// Evita que la IA asigne una fecha YYYY-MM-DD lejana sin que el usuario haya mencionado fecha.
function pickReminderCalendarDate(rawDate, userMessage) {
  const d = rawDate != null && rawDate !== "" ? String(rawDate).trim() : "";
  if (!d || /^null$/i.test(d)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const bogus = new Date(`${d}T12:00:00-05:00`);
  if (Number.isNaN(bogus.getTime())) return null;

  const msg = (userMessage || "").toLowerCase();
  const explicitDate =
    /\b(hoy|mañana|pasado\s*mañana)\b/i.test(msg) ||
    /\b(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i.test(msg) ||
    /\b\d{1,2}\s+de\s+\w+/i.test(msg) ||
    /\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/.test(msg) ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(msg) ||
    /\b(en\s+\d+\s*(d[ií]as?|semanas?|mes(es)?))\b/i.test(msg) ||
    /\b(pr[oó]xim[oa]s?\s+(semana|mes|año))\b/i.test(msg) ||
    /\b(el\s+\d{1,2})\b/.test(msg);

  const now = Date.now();
  const daysAhead = (bogus.getTime() - now) / 86400000;
  if (daysAhead > 14 && !explicitDate) {
    console.warn("[reminder] Descartando date de la IA (sin fecha en el mensaje):", d);
    return null;
  }
  return d;
}

// Formats HH:MM or HH:MM:SS to "9:00 AM"
function formatTimeDisplay(rawTime) {
  return new Date(`1970-01-01T${rawTime}`).toLocaleTimeString("es-CO", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Sends WhatsApp message and writes to interaction_logs
async function replyAndLog(phone, name, incomingMsg, botReply) {
  await sendWhatsAppMessage(phone, botReply);
  await supabase.from("interaction_logs").insert([{
    sender_name: name,
    sender_phone: phone,
    message: incomingMsg,
    bot_response: botReply,
  }]);
}

// ---------------------------------------------------------
// HEALTH CHECK
// /api/ping — monitored by UptimeRobot every 5 min
// Returns 200 when healthy, 500 when Supabase is unreachable
// ---------------------------------------------------------
app.get("/api/ping", async (req, res) => {
  const start = performance.now();
  const { error } = await supabase.from("api_usage").select("usage_date").limit(1);
  const latency = Math.round(performance.now() - start);

  res.status(error ? 500 : 200).json({
    status: error ? "degradado" : "ok",
    latency_ms: latency,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------
// STATUS API
// /api/status — feeds the Manvi dashboard
// ---------------------------------------------------------
app.get("/api/status", async (req, res) => {
  try {
    const stats = await getUsage();

    const { data: routineFireData } = await supabase
      .from("daily_routines")
      .select("last_fired_date")
      .eq("is_active", true)
      .not("last_fired_date", "is", null)
      .order("last_fired_date", { ascending: false })
      .limit(1);

    const lastRoutineFired = routineFireData?.[0]?.last_fired_date || null;
    const uptimeSeconds = process.uptime();

    // Fetch rich job status from DB if table exists, otherwise use in-memory heartbeats
    const { data: dbJobs } = await supabase.from("system_jobs").select("*");
    const heartbeats = getHeartbeats();

    const jobs = [
      {
        name: "Receptor de webhook",
        schedule: "Por eventos",
        description: "Procesador de mensajes entrantes y enrutador de intenciones por IA",
        layman: "La recepción 24/7: lee tu mensaje al instante y lo deriva al flujo correcto.",
        status: "active",
        lastFired: "En vivo"
      },
      {
        name: "Envío de recordatorios e intervalos",
        schedule: "* * * * *",
        description: "Ejecuta recordatorios únicos y por intervalo que ya cumplieron su hora",
        layman: "El vigilante: cada minuto revisa recordatorios pendientes, con fecha futura y alertas por intervalo.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Reminder Dispatch')?.last_fired || heartbeats['Reminder Dispatch']
      },
      {
        name: "Envío de rutinas",
        schedule: "* * * * *",
        description: "Compara la hora actual (COT) con las rutinas diarias activas",
        layman: "Los hábitos: asegura que las rutinas diarias recurrentes no se pierdan.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Routine Dispatch')?.last_fired || heartbeats['Routine Dispatch']
      },
      {
        name: "Envío de tareas recurrentes",
        schedule: "* * * * *",
        description: "Ejecuta tareas semanales y mensuales en su día y hora programados",
        layman: "El calendario: maneja recordatorios semanales y mensuales (por ejemplo, pagos o rutinas fijas).",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Recurring Task Dispatch')?.last_fired || heartbeats['Recurring Task Dispatch']
      },
      {
        name: "Alerta de eventos",
        schedule: "30 8 * * *",
        description: "Refuerzo de alertas de cumpleaños y eventos a las 08:30 COT",
        layman: "El anuncio: una vez al día a las 8:30 avisa cumpleaños y aniversarios.",
        status: "scheduled",
        lastFired: dbJobs?.find(j => j.job_name === 'Event Alert')?.last_fired || heartbeats['Event Alert']
      },
    ];

    res.json({
      success: true,
      version,
      uptime: {
        days: Math.floor(uptimeSeconds / 86400),
        hours: Math.floor((uptimeSeconds % 86400) / 3600),
        minutes: Math.floor((uptimeSeconds % 3600) / 60),
        seconds: Math.floor(uptimeSeconds % 60),
      },
      limits: LIMITS,
      stats,
      jobs,
    });
  } catch (err) {
    console.error("[status] Error al obtener el estado del sistema:", err);
    res.status(500).json({ success: false, error: "No se pudo obtener el estado del sistema" });
  }
});

// ---------------------------------------------------------
// WEBHOOK — Twilio (no verification GET needed for Twilio Sandbox)
// ---------------------------------------------------------

// ---------------------------------------------------------
// MAIN WEBHOOK — Inbound message processor (Twilio)
// ---------------------------------------------------------
app.post("/webhook", async (req, res) => {
  // Twilio signature validation (optional but recommended in production)
  // const twilioSignature = req.headers["x-twilio-signature"];
  // const valid = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, twilioSignature, process.env.PUBLIC_URL + "/webhook", req.body);
  // if (!valid) return res.sendStatus(403);

  res.sendStatus(200);

  // Twilio sends: Body, From, To
  const message = req.body.Body;
  const rawFrom = req.body.From; // e.g. "whatsapp:+573001234567"

  if (!message || !rawFrom) return;

  // Strip "whatsapp:+" prefix to normalize phone number
  const senderPhone = rawFrom.replace("whatsapp:+", "").replace("whatsapp:", "");
  const lowerMsg = message.toLowerCase().trim();

  // 1. CALLER ID
  let senderName = "Invitado";
  let isOwner = false;

  if (isSamePhoneAsOwner(senderPhone, process.env.MY_PHONE_NUMBER)) {
    senderName = "Sergio";
    isOwner = true;
  } else {
    const { data: contact } = await supabase
      .from("contacts")
      .select("name")
      .eq("phone", senderPhone)
      .single();
    if (contact) {
      senderName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
    }
  }

  // 2. USAGE DASHBOARD
  if (lowerMsg === "/limit") {
    const u = await getUsage();
    const msg =
      `Límites del sistema\n\n` +
      `Motores de IA\n` +
      `Gemini: ${u.gemini} / ${LIMITS.gemini}\n` +
      `Groq: ${u.groq} / ${LIMITS.groq}\n` +
      `OpenRouter: ${u.openrouter} / ${LIMITS.openrouter}\n\n` +
      `Motores de búsqueda\n` +
      `Tavily (mensual): ${u.tavily} / ${LIMITS.tavily}\n` +
      `Serper (total): ${u.serper} / ${LIMITS.serper}\n\n` +
      `Estado: Operativo`;
    return await replyAndLog(senderPhone, senderName, message, msg);
  }

  // 3. GREETING
  if (
    ["hi", "hello", "hey", "hola", "buenas", "buenos días", "buen día", "buenas tardes", "buenas noches"].includes(lowerMsg)
  ) {
    const text = isOwner
      ? `Hola Sergio. Manvi en línea. Puedes crear recordatorios, rutinas, eventos, buscar en la web o consultar tu agenda.`
      : `Hola ${senderName}. Soy Manvi, la asistente personal de Sergio.`;
    return await replyAndLog(senderPhone, senderName, message, text);
  }

  // 4. CONVERSATIONAL MEMORY — fetch last 4 turns for this sender
  const { data: historyRows } = await supabase
    .from("interaction_logs")
    .select("message, bot_response")
    .eq("sender_phone", senderPhone)
    .order("created_at", { ascending: true })
    .limit(4);

  const history = (historyRows || []).map((row) => ({
    userMessage: row.message,
    botResponse: row.bot_response,
  }));

  // 5. AI INTENT ANALYSIS (with memory context)
  const aiResult = await analyzeMessage(message, false, history);
  const { intent, targetName, time, date, taskOrMessage, ai_meta } = aiResult;

  // respond() is the single exit point — appends ai_meta automatically
  const respond = async (responseText, overrideAiMeta) => {
    const meta = overrideAiMeta !== undefined ? overrideAiMeta : ai_meta;
    const finalText = meta ? `${responseText}\n\n${meta}` : responseText;
    return await replyAndLog(senderPhone, senderName, message, finalText);
  };

  // 6. ADDRESS BOOK
  const queryOnlyIntents = [
    "query_birthday", "query_schedule", "query_events",
    "query_reminders", "query_routines", "query_contacts",
    "save_contact",
  ];

  let targetPhone = process.env.MY_PHONE_NUMBER;
  let finalName = "you";

  if (targetName && targetName.toLowerCase() !== "you") {
    if (!queryOnlyIntents.includes(intent)) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("*")
        .ilike("name", targetName)
        .single();

      if (contact) {
        targetPhone = contact.phone;
        finalName = contact.name.charAt(0).toUpperCase() + contact.name.slice(1);
      } else {
        return await respond(`No encontré el contacto "${targetName}" en la agenda.`);
      }
    } else {
      finalName = targetName.charAt(0).toUpperCase() + targetName.slice(1);
    }
  }

  // 7. INTENT ROUTING
  try {
    if (intent === "chat") {
      return await respond(taskOrMessage);
    }

    if (intent === "api_error") {
      return await respond(`IA no disponible: ${taskOrMessage}`);
    }

    if (intent === "web_search") {
      const searchResults = await searchWeb(taskOrMessage);
      if (!searchResults) return await respond("Las herramientas de búsqueda no están disponibles en este momento.");

      const summaryPrompt =
        `Asistente Manvi. El usuario preguntó: "${message}". ` +
        `Resultados de ${searchResults.source}: ${searchResults.data}. ` +
        `Responde de forma breve y precisa en español.`;

      const summaryResult = await analyzeMessage(summaryPrompt, true);
      return await respond(
        `Resultados de búsqueda (${searchResults.source})\n\n${summaryResult.text}`,
        summaryResult.ai_meta
      );
    }

    if (intent === "delete_task") {
      if (!isOwner) return await respond("Acceso denegado.");

      const cleanTask = taskOrMessage.replace(/(routine|reminder|task|event)/gi, "").trim();

      const { data: remData } = await supabase
        .from("personal_reminders")
        .delete()
        .ilike("message", `%${cleanTask}%`)
        .select();
      if (remData?.length > 0)
        return await respond(`Recordatorio eliminado: "${remData[0].message}"`);

      const { data: routData } = await supabase
        .from("daily_routines")
        .delete()
        .ilike("task_name", `%${cleanTask}%`)
        .select();
      if (routData?.length > 0)
        return await respond(`Rutina eliminada: "${routData[0].task_name}"`);

      const { data: recurData } = await supabase
        .from("recurring_tasks")
        .delete()
        .ilike("task_name", `%${cleanTask}%`)
        .select();
      if (recurData?.length > 0)
        return await respond(`Tarea recurrente eliminada: "${recurData[0].task_name}"`);

      const { data: eventData } = await supabase
        .from("special_events")
        .delete()
        .ilike("person_name", `%${cleanTask}%`)
        .select();
      if (eventData?.length > 0)
        return await respond(`Evento eliminado para: "${eventData[0].person_name}"`);

      return await respond(`No hay ninguna tarea que coincida con "${cleanTask}".`);
    }

    // Feature 1: edit_task — modify the most recent matching reminder
    if (intent === "edit_task") {
      if (!isOwner) return await respond("Acceso denegado.");

      const cleanTask = (aiResult.editTarget || taskOrMessage || "")
        .replace(/(routine|reminder|task|event)/gi, "")
        .trim();

      if (!cleanTask) return await respond("No pude identificar qué tarea editar. Sé más específico.");
      if (!time) return await respond("Indica la nueva hora de la tarea.");

      // Find the most recent pending reminder matching the task name
      const { data: matches } = await supabase
        .from("personal_reminders")
        .select("*")
        .eq("phone", targetPhone)
        .eq("status", "pending")
        .ilike("message", `%${cleanTask}%`)
        .order("reminder_time", { ascending: true })
        .limit(1);

      if (!matches || matches.length === 0) {
        return await respond(`No hay recordatorios pendientes que coincidan con "${cleanTask}".`);
      }

      const existing = matches[0];
      // Delete old row and insert updated one
      await supabase.from("personal_reminders").delete().eq("id", existing.id);

      const newTimestamp = buildReminderDate(time, pickReminderCalendarDate(date, message));
      const { error: insertErr } = await supabase.from("personal_reminders").insert([{
        phone: targetPhone,
        message: existing.message,
        reminder_time: newTimestamp,
        group_name: existing.group_name,
        status: "pending",
      }]);

      return await respond(
        !insertErr
          ? `Actualicé "${existing.message}" a las ${formatTimeDisplay(time)}.`
          : "No se pudo actualizar el recordatorio. Intenta de nuevo."
      );
    }

    if (intent === "save_contact") {
      if (!isOwner) return await respond("Acceso denegado.");

      let phone = digitsOnly(aiResult.phone);
      if (!phone || phone.length < 10) {
        phone = extractPhoneFromNaturalMessage(message);
      }

      let name = cleanContactNameFromAI(taskOrMessage, message);

      if (!name) return await respond("Indica el nombre del contacto.");
      if (!phone || phone.length < 10) {
        return await respond(
          "Indica un número válido (10 dígitos mínimo, ideal con código de país 57…). Ejemplo: «Guarda a Ana 573001234567»."
        );
      }

      // Sin depender de UNIQUE(name): muchas bases creadas a mano no tienen la restricción y fallan upsert/onConflict (42P10).
      const { data: existingRows, error: findErr } = await supabase
        .from("contacts")
        .select("id")
        .ilike("name", name);

      let error = findErr;
      if (!error) {
        if (existingRows?.length) {
          if (existingRows.length > 1) {
            console.warn("[save_contact] Hay varias filas con el mismo nombre (ilike); actualizo la primera.");
          }
          ({ error } = await supabase
            .from("contacts")
            .update({ phone, name })
            .eq("id", existingRows[0].id));
        } else {
          ({ error } = await supabase.from("contacts").insert([{ name, phone }]));
        }
      }

      if (error) {
        console.error("[save_contact] Supabase:", JSON.stringify(error));
        const errStr = `${error.code || ""} ${error.message || ""} ${error.details || ""}`;
        const rls = /row-level security|RLS|permission denied|42501|PGRST301/i.test(errStr);
        const hint = rls
          ? " Revisa políticas RLS en Supabase (INSERT en contacts) o usa SUPABASE_KEY con rol service_role."
          : "";
        return await respond(`No se pudo guardar el contacto.${hint ? ` ${hint}` : ""}`);
      }

      return await respond(`Contacto guardado: ${name} — ${phone}`);
    }

    if (["query_routines", "query_contacts", "query_reminders", "query_events"].includes(intent)) {
      if (!isOwner) return await respond("Acceso denegado. Estos datos son privados.");

      if (intent === "query_contacts") {
        const { data } = await supabase.from("contacts").select("name").order("name");
        if (!data || data.length === 0) return await respond("No hay contactos guardados.");
        let text = "Agenda:\n\n";
        data.forEach((c) => (text += `- ${c.name.charAt(0).toUpperCase() + c.name.slice(1)}\n`));
        return await respond(text);
      }

      if (intent === "query_reminders") {
        const nowIso = new Date().toISOString();
        const { data } = await supabase
          .from("personal_reminders")
          .select("*")
          .eq("phone", targetPhone)
          .gt("reminder_time", nowIso)
          .order("reminder_time");
        if (!data || data.length === 0) return await respond("No hay recordatorios próximos.");

        const oneOff = data.filter((r) => r.group_name !== "interval");
        const interval = data.filter((r) => r.group_name === "interval");

        let text = "";

        if (oneOff.length > 0) {
          text += "Recordatorios puntuales:\n\n";
          oneOff.forEach((r) => {
            const t = new Date(r.reminder_time).toLocaleString("es-CO", {
              timeZone: "America/Bogota", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit", hour12: true,
            });
            text += `- [${t}] ${r.group_name ? r.group_name + ": " : ""}${r.message}\n`;
          });
        }

        if (interval.length > 0) {
          text += `\nRecordatorios por intervalo (${interval.length} pendientes):\n\n`;
          const grouped = {};
          interval.forEach((r) => {
            if (!grouped[r.message]) grouped[r.message] = [];
            grouped[r.message].push(r.reminder_time);
          });
          Object.entries(grouped).forEach(([msg, times]) => {
            const next = new Date(times[0]).toLocaleString("es-CO", {
              timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true,
            });
            text += `- "${msg}" — ${times.length} alertas restantes, la próxima a las ${next}\n`;
          });
        }

        return await respond(text.trim());
      }

      if (intent === "query_routines") {
        const { data: dailyData } = await supabase
          .from("daily_routines")
          .select("*")
          .eq("phone", targetPhone)
          .eq("is_active", true);

        const { data: recurData } = await supabase
          .from("recurring_tasks")
          .select("*")
          .eq("phone", targetPhone)
          .eq("is_active", true);

        const hasDailyData = dailyData && dailyData.length > 0;
        const hasRecurData = recurData && recurData.length > 0;

        if (!hasDailyData && !hasRecurData) return await respond("No hay rutinas diarias ni tareas recurrentes activas.");

        let text = "";

        if (hasDailyData) {
          text += "Rutinas diarias:\n\n";
          dailyData.forEach((r) => (text += `- ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`));
        }

        if (hasRecurData) {
          text += "\nTareas recurrentes:\n\n";
          const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
          recurData.forEach((r) => {
            if (r.recurrence_type === "weekly") {
              text += `- Cada ${DAY_NAMES[r.day_of_week]} a las ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`;
            } else {
              text += `- Cada mes el día ${r.day_of_month} a las ${formatTimeDisplay(r.reminder_time)}: ${r.task_name}\n`;
            }
          });
        }

        return await respond(text.trim());
      }

      if (intent === "query_events") {
        const { data } = await supabase.from("special_events").select("*").order("event_date");
        if (!data || data.length === 0) return await respond("No hay eventos especiales guardados.");
        let text = "Eventos especiales:\n\n";
        data.forEach((e) => (text += `- ${e.event_date}: ${e.person_name} — ${e.event_type}\n`));
        return await respond(text);
      }
    }

    if (intent === "query_birthday") {
      const { data } = await supabase
        .from("special_events")
        .select("event_date")
        .ilike("person_name", finalName)
        .eq("event_type", "birthday")
        .single();
      return await respond(
        data
          ? `Cumpleaños de ${finalName}: ${data.event_date}`
          : `No hay cumpleaños guardado para ${finalName}.`
      );
    }

    if (intent === "query_schedule") {
      if (!date) return await respond("Indica una fecha.");

      const { data: events } = await supabase
        .from("special_events")
        .select("*")
        .eq("event_date", date);
      const { data: reminders } = await supabase
        .from("personal_reminders")
        .select("*")
        .like("reminder_time", `${date}%`);

      const hasItems = (events?.length > 0) || (reminders?.length > 0);
      if (!hasItems) return await respond(`No hay eventos ni recordatorios para ${date}.`);

      let text = `Agenda — ${date}\n\n`;
      if (events?.length > 0) {
        text += `Eventos:\n`;
        events.forEach((e) => (text += `- ${e.person_name} — ${e.event_type}\n`));
      }
      if (reminders?.length > 0) {
        text += `\nRecordatorios:\n`;
        reminders.forEach((r) => {
          const t = new Date(r.reminder_time).toLocaleTimeString("es-CO", {
            timeZone: "America/Bogota",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          text += `- ${t}: ${r.message}\n`;
        });
      }
      return await respond(text);
    }

    if (intent === "event") {
      const eventPersonName = finalName.toLowerCase() === "you" ? "Sergio" : finalName;
      const { error } = await supabase.from("special_events").insert([{
        phone: targetPhone,
        event_type: taskOrMessage,
        person_name: eventPersonName,
        event_date: date,
      }]);
      return await respond(
        !error
          ? `Guardé el ${taskOrMessage} de ${eventPersonName} el ${date}.`
          : "No se pudo guardar el evento. Intenta de nuevo."
      );
    }

    if (intent === "routine") {
      const { error } = await supabase.from("daily_routines").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
      }]);
      return await respond(
        !error
          ? `Rutina configurada — ${taskOrMessage} todos los días a las ${formatTimeDisplay(time)}.`
          : "No se pudo guardar la rutina. Intenta de nuevo."
      );
    }

    // Feature 3: weekly_reminder and monthly_reminder intents
    if (intent === "weekly_reminder") {
      const dayOfWeek = parseInt(aiResult.dayOfWeek);
      if (isNaN(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        return await respond("No pude determinar el día de la semana. Intenta de nuevo.");
      }
      if (!time) return await respond("Indica la hora del recordatorio semanal.");

      const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const { error } = await supabase.from("recurring_tasks").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
        recurrence_type: "weekly",
        day_of_week: dayOfWeek,
        day_of_month: null,
        is_active: true,
      }]);
      return await respond(
        !error
          ? `Recordatorio semanal configurado — "${taskOrMessage}" cada ${DAY_NAMES[dayOfWeek]} a las ${formatTimeDisplay(time)}.`
          : "No se pudo guardar el recordatorio semanal. Intenta de nuevo."
      );
    }

    if (intent === "monthly_reminder") {
      const dayOfMonth = parseInt(aiResult.dayOfMonth);
      if (isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        return await respond("No pude determinar el día del mes. Intenta de nuevo.");
      }
      if (!time) return await respond("Indica la hora del recordatorio mensual.");

      const { error } = await supabase.from("recurring_tasks").insert([{
        phone: targetPhone,
        task_name: taskOrMessage,
        reminder_time: time,
        recurrence_type: "monthly",
        day_of_week: null,
        day_of_month: dayOfMonth,
        is_active: true,
      }]);
      return await respond(
        !error
          ? `Recordatorio mensual configurado — "${taskOrMessage}" el día ${dayOfMonth} de cada mes a las ${formatTimeDisplay(time)}.`
          : "No se pudo guardar el recordatorio mensual. Intenta de nuevo."
      );
    }

    if (intent === "instant_message") {
      if (finalName.toLowerCase() === "you") {
        await sendWhatsAppMessage(
          process.env.MY_PHONE_NUMBER,
          `Mensaje de ${senderName}: ${taskOrMessage}`
        );
        return await respond("Mensaje reenviado.");
      } else {
        await sendWhatsAppMessage(targetPhone, `Mensaje de ${senderName}: ${taskOrMessage}`);
        return await respond(`Mensaje enviado a ${finalName}.`);
      }
    }

    if (intent === "reminder") {
      if (!time) return await respond("Indica la hora del recordatorio.");
      if (!taskOrMessage || taskOrMessage.trim() === "") return await respond("Indica para qué es el recordatorio.");
      const calendarDate = pickReminderCalendarDate(date, message);
      const dbTimestamp = buildReminderDate(time, calendarDate);
      const insertPayload = {
        phone: targetPhone,
        message: taskOrMessage,
        reminder_time: dbTimestamp,
        group_name: finalName.toLowerCase() === "you" ? null : finalName,
        status: "pending",
      };
      console.log(
        "[reminder] IA time=%s date=%s → usado=%s | INSERT %s",
        time,
        date ?? "(vacío)",
        calendarDate ?? "(hoy Bogotá)",
        JSON.stringify(insertPayload)
      );
      const { error } = await supabase.from("personal_reminders").insert([insertPayload]);
      if (error) console.error("[reminder] Supabase INSERT error:", JSON.stringify(error));
      return await respond(
        !error
          ? `Recordatorio programado para las ${formatTimeDisplay(time)}.`
          : "No se pudo guardar el recordatorio. Intenta de nuevo."
      );
    }

    if (intent === "interval_reminder") {
      const intervalMins = parseInt(aiResult.intervalMinutes);
      const durationHrs = parseInt(aiResult.durationHours) || 8;
      const task = taskOrMessage || "recordatorio";

      if (!intervalMins || intervalMins < 1) {
        return await respond("Indica cada cuánto — por ejemplo, cada 30 minutos.");
      }
      if (intervalMins < 5) {
        return await respond("El intervalo mínimo es de 5 minutos.");
      }

      const now = new Date();
      const endTime = new Date(now.getTime() + durationHrs * 60 * 60 * 1000);
      const rows = [];

      let next = new Date(now.getTime() + intervalMins * 60 * 1000);
      while (next <= endTime) {
        rows.push({
          phone: targetPhone,
          message: task,
          reminder_time: next.toISOString(),
          group_name: "interval",
        });
        next = new Date(next.getTime() + intervalMins * 60 * 1000);
      }

      if (rows.length === 0) {
        return await respond("No se pudieron programar recordatorios en ese intervalo de tiempo.");
      }

      const { error } = await supabase.from("personal_reminders").insert(rows);
      return await respond(
        !error
          ? `Recordatorio cada ${intervalMins} min configurado para "${task}" — ${rows.length} alertas en las próximas ${durationHrs} horas.`
          : "No se pudo guardar el recordatorio por intervalo. Intenta de nuevo."
      );
    }

    await respond("No entendí la solicitud. Reformula por favor.");
  } catch (err) {
    console.error("[webhook] Error de enrutado:", err);
    await respond("Error interno. Intenta de nuevo.");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`[server] Manvi v${version} en ejecución en el puerto ${process.env.PORT || 3000}`);

  // Self-Pinging Keep-Alive (prevents Render sleep)
  const PUBLIC_URL = process.env.PUBLIC_URL;
  if (PUBLIC_URL) {
    console.log(`[keep-alive] Auto-ping activado para ${PUBLIC_URL}`);
    const axios = require("axios");
    setInterval(async () => {
      try {
        await axios.get(`${PUBLIC_URL}/api/ping`);
        console.log(`[keep-alive] Latido enviado a ${PUBLIC_URL}`);
      } catch (err) {
        console.warn(`[keep-alive] Aviso de auto-ping: ${err.message}`);
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  } else {
    console.warn("[keep-alive] AVISO: PUBLIC_URL no está definido. El bot puede entrar en reposo si no hay actividad.");
    console.warn("[keep-alive] Añade PUBLIC_URL en tu .env para activar el auto-ping.");
  }
});
