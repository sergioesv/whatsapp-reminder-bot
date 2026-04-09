// messages_es.js

module.exports = {
  // ✅ Recordatorios
  REMINDER_CREATED: "✅ Recordatorio creado correctamente",
  REMINDER_SCHEDULED: "⏰ Tu recordatorio ha sido programado",
  REMINDER_DELETED: "🗑️ Recordatorio eliminado",

  // 🔁 Rutinas
  DAILY_ADDED: "📅 Rutina diaria agregada",
  DAILY_REMOVED: "❌ Rutina eliminada",
  ROUTINE_SET: (task, time) => `📅 Rutina configurada: ${task} todos los días a las ${time}`,

  // 🎉 Eventos
  EVENT_SAVED: "🎉 Evento guardado correctamente",
  EVENT_REMINDER: (name, type) => `🎊 Hoy es ${type} de ${name}`,

  // ⚠️ Errores
  INVALID_INPUT: "❌ Entrada inválida. Intenta nuevamente",
  ERROR: "⚠️ Ocurrió un error",
  NOT_FOUND: "🔍 No se encontró información",

  // ℹ️ Info
  HELP: `🤖 Comandos disponibles:
- "Recuérdame [mensaje] a las [hora]"
- "Rutina [mensaje] a las [hora]"
- "Evento [nombre] [fecha]"
`,

  // 👋 Saludo
  WELCOME: "👋 Hola, soy tu asistente de recordatorios"
};
