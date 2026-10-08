# Documenti legali — registro delle modifiche

Una voce per ogni cambio di informativa, DPA o dichiarazione dei dati cliente
protetti. La data e la versione sono quelle scritte in testa ai documenti.

## Informativa 1.6 — 08-10-2026 (DPA 1.6 dello stesso giorno)

**Modifica sostanziale: annunciata dentro l'app prima che valga** (sezione 10
dell'informativa), con l'avviso in cima alla Dashboard che ricompare a ogni
negozio installato prima di oggi finché non preme «Ho capito». La frase
dell'avviso (`dashboard.privacyNotice` in `it.ts`/`en.ts`) dice cosa cambia in
questa versione.

- Importazione da Klaviyo (informativa EN/IT/HTML sezione 3.3, DPA EN/IT
  sezioni 1, 2 e 3): se il merchant collega il proprio account Klaviyo, Kerdon
  ne legge i profili per suo conto e solo su suo comando (anteprima delle
  proprietà, importazione avviata dal merchant) per completare le date di
  nascita. Abbinamento per ID cliente Shopify, email o telefono, solo fra i
  clienti con consenso al marketing. Data vuota: riempita nel metafield di
  Shopify. Data diversa: elencata in «Dati diversi da Klaviyo», cambiata solo
  se il merchant sceglie «Usa Klaviyo» — l'unico caso in cui una data già
  presente su Shopify viene sostituita (la frase «non sovrascrive mai» ora vale
  per la riscrittura dal database del merchant). Del profilo resta solo la
  data; il resto si legge per abbinare e si scarta. Nessuna scrittura verso
  Klaviyo: accesso in sola lettura (profili e nome dell'account).
- Token di Klaviyo conservati cifrati (informativa sezioni 3.1 e 6, DPA
  sezione 6), cancellati e revocati presso Klaviyo allo scollegamento.
- Le differenze con Klaviyo come quinto caso di riferimento a una persona
  scritto nel nostro database (informativa 3.6, DPA sezione 9,
  `protected-customer-data.md`): identificativo Shopify del cliente, le due
  date e la decisione presa, conservate perché l'importazione successiva non
  richieda la stessa cosa; cancellate con `customers/redact` di quel cliente
  (informativa sezione 8, DPA sezione 8) e, per cascata da `shops`, con
  `shop/redact`. Escono anche nell'esportazione per il diritto di accesso
  (`customers/data_request`, chiave `integration_conflicts`; informativa
  sezione 8, DPA sezione 8), perché la data di Klaviyo di un conflitto aperto o
  tenuto con «Tieni il nostro» non esiste da nessun'altra parte.
- Klaviyo nella tabella «Who else is involved» dell'informativa come fonte dei
  dati, sul modello di Shopify. Nel DPA non è un sub-responsabile: come il
  database del merchant, è un fornitore del merchant, e la sezione 5 lo dice
  sotto la tabella. Nessun nuovo sub-responsabile, quindi nessun preavviso ai
  sensi della lettera d) della sezione 4.

## Informativa 1.5 — 02-10-2026 (DPA 1.5 dello stesso giorno)

**Modifica sostanziale: annunciata dentro l'app prima che valga** (sezione 10
dell'informativa), con l'avviso in cima alla Dashboard che compare a ogni
negozio installato prima di oggi finché non preme «Ho capito». La versione
annunciata è `PRIVACY_POLICY_VERSION` (`app/lib/legal/policy-version.ts`),
tenuta uguale alla testata da `policy-version.test.ts`.

- Cookie dichiarati (informativa EN/IT/HTML sezione 3.5, DPA EN/IT sezione 3,
  `protected-customer-data.md`): `kerdon_eid` e `kerdon_rv`, scritti dal
  container server-side del merchant sul dominio del negozio con il template
  `integrations/sgtm/kerdon-id-client.tpl`, con chi li scrive e quando,
  finalità, durata richiesta (un anno per impostazione per `kerdon_eid`, come
  massimo richiesto che il browser può accorciare; 30 giorni al massimo per
  `kerdon_rv`), contenuto e attributi (`Secure`, `SameSite=Lax`, `Path=/`;
  `HttpOnly` solo `kerdon_rv`), come li imposta il template. Il nome di prima
  `corew_eid` dichiarato come non più scritto. Nominati i cookie di consenso
  che il template legge senza scriverli (`_tracking_consent`, `kerdon_consent`,
  `corew_consent`) e il `kerdon_eid` sul dominio di Kerdon che accompagna la
  risposta al container.
- Upstash (informativa EN/IT/HTML, DPA EN/IT): oltre alla cache dei conteggi,
  ospita, se attivati (`INGEST_SHARED_RATE_LIMIT=true`), i contatori anti-abuso
  delle scritture: identificativo interno del negozio, identificativo pubblico
  della chiave di invio, numero della finestra di 10 secondi. Nessun dato
  personale, stesso fornitore e stessa regione. Era stata annotata il 02-10-2026
  come precisazione senza cambio di versione; entra in questa versione.
- DPA: da questa versione porta anche il numero di versione in testa, allineato
  a quello dell'informativa.

## Informativa 1.4 — 27-09-2026 (DPA dello stesso giorno)

**Modifica sostanziale: va annunciata dentro l'app prima che valga** (sezione 10
dell'informativa). L'annuncio in app è arrivato con la 1.5, che la comprende:
chi vede l'avviso della 1.5 legge un'informativa che contiene anche la 1.4.

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

- [x] **Avviso in app delle modifiche sostanziali all'informativa.** La sezione
  10 promette che una modifica sostanziale viene annunciata dentro l'app prima
  di valere. Fatto con la 1.5: Banner nella Dashboard, «Ho capito» registra la
  versione vista per negozio (tabella `privacy_notice_acknowledgements`, la
  migrazione `20261002120000_privacy_notice_acknowledgements` va applicata con
  `docs/database-migrations.md` su Test e Live prima della pubblicazione).
- [ ] Modulo *Protected customer data access* compilato come da
  `protected-customer-data.md`, sezione «Per il proprietario».
