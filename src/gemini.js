const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai");
const { getUsage, track, LIMITS } = require("./usage");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Tier 1: Gemini 2.5 Flash (Principal)
const gemini25Json = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini25Text = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Tier 2: Gemini 1.5 Flash (Respaldo)
const gemini15Json = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
  generationConfig: { responseMimeType: "application/json" },
});
const gemini15Text = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Tier 3: Groq — Llama 3.3 (free, optional)
const groqAI = process.env.GROQ_API_KEY ? new OpenAI({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: process.env.GROQ_API_KEY,
}) : null;

// Tier 4: OpenRouter — GPT-4o-mini (paid fallback, optional)
const backupAI = process.env.OPENROUTER_API_KEY ? new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
}) : null;

// ---------------------------------------------------------
// Feature 2: WhatsApp Markdown Formatter
// ---------------------------------------------------------
function formatForWhatsApp(text) {
  return text
    .replace(/^#{1,3}\s+(.+)$/gm, (_, heading) => `*${heading.toUpperCase()}*`)
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/`([^`]+)`/g, "```$1```")
    .replace(/^[-*]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 4-Tier AI Waterfall Router
 */
async function analyzeMessage(userMessage, isSummaryRequest = false, history = []) {
  const usageStats = await getUsage();
  const currentIST = new Date().toLocaleString("en-US", {
    timeZone: "America/Bogota",
    hour12: false,
  });

const systemPrompt = `
Eres el cerebro de un asistente personal de WhatsApp llamado CERO.
Tu dueño es Sergio. Estás hablando con él por WhatsApp.

⚠️ REGLA MÁS IMPORTANTE:
SIEMPRE responde en español. NUNCA uses inglés.

CONTEXTO:
La fecha y hora actual es: ${currentIST} (hora Colombia).
Si el usuario dice "en 5 minutos", calcula la hora exacta en formato HH:MM:SS.

Tu trabajo es analizar el mensaje del usuario y devolver SOLO un JSON válido.
NO escribas texto adicional. NO explicaciones. SOLO JSON.

REGLAS DE INTENCIÓN:

- "event": SOLO cuando el usuario quiere GUARDAR cumpleaños o fechas especiales.
- "reminder": cuando el usuario dice "recuérdame".
- "routine": cuando dice "todos los días" o algo repetitivo.
- "edit_task": cuando quiere modificar algo.
- "delete_task": cuando quiere eliminar algo.

⚠️ IMPORTANTE:
Si NO hay hora en un recordatorio:
→ responde con intent "chat" y taskOrMessage:
"¿A qué hora quieres que lo programe?"

TIEMPOS VAGOS:
- mañana → 09:00:00
- tarde → 14:00:00
- noche → 21:00:00

CAMPO "date" (MUY IMPORTANTE para intent "reminder" y "edit_task"):
- Usa "date": null (o omite la clave) cuando el usuario SOLO dice la hora o "en X minutos/horas" SIN nombrar un día del calendario.
- SOLO rellena "date" con "YYYY-MM-DD" si el usuario dijo algo como: hoy, mañana, un día de la semana, "el 5 de agosto", "15/04", etc.
- NUNCA inventes una fecha lejana ni adivines el mes si el usuario no lo dijo. Si solo hay hora, date = null y la hora debe ser la de HOY en Colombia (o mañana si ya pasó).

FORMATO JSON:

{
  "intent": "reminder" | "routine" | "interval_reminder" | "weekly_reminder" | "monthly_reminder" | "event" | "instant_message" | "chat" | "query_birthday" | "query_schedule" | "query_routines" | "query_contacts" | "query_reminders" | "query_events" | "delete_task" | "edit_task" | "save_contact" | "web_search" | "unknown",
  "targetName": "you",
  "time": "HH:MM:SS",
  "date": null,
  "taskOrMessage": "mensaje en español",
  "phone": "",
  "intervalMinutes": null,
  "durationHours": null,
  "dayOfWeek": null,
  "dayOfMonth": null,
  "editTarget": ""
}


  Message: "${userMessage}"
  `;

  const promptToSend = isSummaryRequest
    ? `Summarize the following search results concisely in plain text. No JSON, no markdown:\n\n${userMessage}`
    : systemPrompt;

  const openAIMessages = [
    {
      role: "system",
      content: isSummaryRequest
        ? "Eres CERO, asistente personal de Sergio. Summarize search results concisely in plain text."
        : systemPrompt,
    },
    { role: "user", content: userMessage },
  ];

  // --- TIER 1 & 2: GOOGLE GEMINI ---
  let googleResponseText = null;
  let activeBrain = "Gemini 2.5 Flash";

  if (usageStats.gemini < LIMITS.gemini) {
    try {
      // Intento con Tier 1: 2.5 Flash
      const model = isSummaryRequest ? gemini25Text : gemini25Json;
      const result = await model.generateContent(promptToSend);
      googleResponseText = result.response.text();
    } catch (err1) {
      console.warn("[gemini] Tier 1 (2.5 Flash) failed:", err1.message);
      try {
        // Intento con Tier 2: 1.5 Flash
        const model = isSummaryRequest ? gemini15Text : gemini15Json;
        const result = await model.generateContent(promptToSend);
        googleResponseText = result.response.text();
        activeBrain = "Gemini 1.5 Flash";
      } catch (err2) {
        console.warn("[gemini] Tier 2 (1.5 Flash) failed:", err2.message);
      }
    }
  }

  if (googleResponseText) {
    await track("gemini");
    const remaining = LIMITS.gemini - (usageStats.gemini + 1);
    const ai_meta = `${activeBrain} — ${remaining} remaining`;

    if (isSummaryRequest) return { text: formatForWhatsApp(googleResponseText), ai_meta };

    const match = googleResponseText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Gemini response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  }

  // --- TIER 3: GROQ (FREE — LLAMA 3.3) ---
  if (!groqAI) console.warn("[groq] Skipping Tier 3 — no GROQ_API_KEY");
  try {
    if (!groqAI) throw new Error("Groq not configured");
    console.log("[groq] Routing to Tier 3");
    const response = await groqAI.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("groq");
    const text = response.choices[0].message.content;
    const remaining = LIMITS.groq - (usageStats.groq + 1);
    const ai_meta = `Groq Llama 3.3 — ${remaining} remaining`;

    if (isSummaryRequest) return { text: formatForWhatsApp(text), ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in Groq response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.warn("[groq] Tier 3 failed, cascading to OpenRouter:", err.message);
  }

  // --- TIER 4: OPENROUTER (PAID — GPT-4o-mini) ---
  try {
    if (!backupAI) throw new Error("OpenRouter not configured");
    console.log("[openrouter] Routing to Tier 4");
    const response = await backupAI.chat.completions.create({
      model: "openai/gpt-4o-mini",
      messages: openAIMessages,
      ...(!isSummaryRequest && { response_format: { type: "json_object" } }),
    });

    await track("openrouter");
    const text = response.choices[0].message.content;
    const ai_meta = `OpenRouter GPT-4o-mini`;

    if (isSummaryRequest) return { text: formatForWhatsApp(text), ai_meta };

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in OpenRouter response");

    const parsed = JSON.parse(match[0]);
    parsed.ai_meta = ai_meta;
    return parsed;
  } catch (err) {
    console.error("[openrouter] All tiers exhausted:", err.message);
    await track("error");
    return {
      intent: "api_error",
      targetName: "you",
      time: null,
      date: null,
      taskOrMessage: "All AI models are currently offline or daily limits have been reached.",
    };
  }
}

module.exports = { analyzeMessage };
