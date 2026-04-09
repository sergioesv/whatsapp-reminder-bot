-- Supabase → SQL Editor. Etapa 4: bucket privado para imágenes de recordatorios.
--
-- Usa SUPABASE_KEY con rol service_role en el backend (Railway): ignora RLS en Storage.
-- Ajusta límite de tamaño y MIME permitidos en Dashboard → Storage → bucket → Configuration.

INSERT INTO storage.buckets (id, name, public)
VALUES ('reminder-attachments', 'reminder-attachments', false)
ON CONFLICT (id) DO NOTHING;
