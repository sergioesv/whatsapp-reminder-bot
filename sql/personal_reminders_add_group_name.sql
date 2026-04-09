-- Ejecutar en Supabase: SQL Editor → New query → Run
-- Corrige: PGRST204 "Could not find the 'group_name' column of 'personal_reminders'"
--
-- Usada para: recordatorios dirigidos a un contacto (nombre), y filas de intervalo (group_name = 'interval').

ALTER TABLE personal_reminders
  ADD COLUMN IF NOT EXISTS group_name VARCHAR(50);

COMMENT ON COLUMN personal_reminders.group_name IS
  'NULL = recordatorio propio; nombre del contacto; o "interval" para recordatorios repetidos por intervalo.';
