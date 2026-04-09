-- Supabase → SQL Editor. Etapa 4: ruta del archivo en Storage ligada al recordatorio.
--
-- Valor: object path dentro del bucket (ej. 573001234567/a1b2c3d4-....jpg), no URL pública.

ALTER TABLE personal_reminders
  ADD COLUMN IF NOT EXISTS attachment_storage_path TEXT;

COMMENT ON COLUMN personal_reminders.attachment_storage_path IS
  'Ruta del objeto en el bucket reminder-attachments (Storage). NULL si no hay imagen guardada.';
