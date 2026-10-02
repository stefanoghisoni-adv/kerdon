# Documenti legali — registro delle modifiche

Una voce per ogni cambio di informativa, DPA o dichiarazione dei dati cliente
protetti. La data e la versione sono quelle scritte in testa ai documenti.

## Precisazione senza cambio di versione — 02-10-2026

- Upstash (informativa EN/IT/HTML, DPA EN/IT): oltre alla cache dei conteggi,
  ospita, se attivati (`INGEST_SHARED_RATE_LIMIT=true`), i contatori anti-abuso
  delle scritture: identificativo interno del negozio, identificativo pubblico
  della chiave di invio, numero della finestra di 10 secondi. Nessun dato
  personale, stesso fornitore e stessa regione. Trattata come precisazione e
  non come modifica sostanziale: niente nuova versione né annuncio in app. Se
  il titolare la ritiene sostanziale, va portata in una 1.5.

## Informativa 1.4 — 27-09-2026 (DPA dello stesso giorno)

**Modifica sostanziale: va annunciata dentro l'app prima che valga** (sezione 10
dell'informativa). L'annuncio in app non esiste ancora: vedi la checklist qui
sotto.

- Dichiarati i dati di spedizione e logistica degli ordini, prima negati: paese
  di spedizione, stato di evasione, codici di tracciamento (solo contati, mai
  conservati), numero di colli, opzione e categoria di consegna, peso, numero di
  articoli, resi (stato e data), categoria di imballo, costo logistico. Per
  ognuno: finalità, dove finisce, conservazione, esportazione e cancellazione.
- Dichiarato che le notifiche di Shopify (webhook di ordini e resi) possono
  contenere indirizzo completo, email, telefono, tracking e motivi dei resi, e
  che vengono scartate alla ricezione tenendo i soli identificativi.
- Cancellazione: sugli ordini della persona si azzera anche il paese di
  spedizione, e l'ordine viene marcato (`customer_redacted_at`) perché nessuna
  scrittura successiva rimetta i dati tolti; il costo logistico già calcolato
  resta.
- Configurazione delle spedizioni (zone, tariffe, imballi, costo dei resi)
  nominata fra quel che conserva il database di Kerdon.
- Dichiarazione PCD: tabella dell'inventario, checklist per la Partner
  Dashboard. Inventario verificato da `app/lib/legal/order-data-inventory.test.ts`.

## Prima del lancio

- [ ] **Avviso in app delle modifiche sostanziali all'informativa.** La sezione
  10 promette che una modifica sostanziale viene annunciata dentro l'app prima
  di valere. Oggi nessuna schermata lo fa: serve prima della pubblicazione, e
  la 1.4 è la prima modifica che lo richiede.
- [ ] Modulo *Protected customer data access* compilato come da
  `protected-customer-data.md`, sezione «Per il proprietario».
