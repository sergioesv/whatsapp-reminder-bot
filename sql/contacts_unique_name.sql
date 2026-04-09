-- Opcional: unicidad por nombre (evita duplicados al guardar contactos).
-- El bot ya no usa upsert/onConflict; esto solo endurece el esquema.
--
-- Si falla por datos duplicados, en Supabase ejecuta antes:
--   SELECT name, count(*) FROM contacts GROUP BY name HAVING count(*) > 1;
-- y fusiona o borra filas repetidas.

ALTER TABLE contacts
  ADD CONSTRAINT contacts_name_unique UNIQUE (name);
