-- Il metafield del cliente da cui leggere la data di nascita.
--
-- Non e' una costante dell'app: un negozio puo' avere gia' un suo campo — con
-- un altro nome e un altro namespace — e obbligarlo a crearne un doppione
-- nostro significherebbe due campi che dicono la stessa cosa, con i clienti
-- vecchi su uno e i nuovi sull'altro. Quindi la scelta e' per negozio.
--
-- Due colonne e non una stringa "custom.data_di_nascita": la query di Shopify
-- vuole namespace e chiave separati. Divisi al salvataggio, chi legge trova due
-- valori gia' buoni e una riga scritta male si scopre subito.
ALTER TABLE "shops" ADD COLUMN "birthdate_metafield_namespace" TEXT;
ALTER TABLE "shops" ADD COLUMN "birthdate_metafield_key" TEXT;
