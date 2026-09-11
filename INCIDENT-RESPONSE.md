# CoreWard — Policy di risposta agli incidenti di sicurezza

Ultima revisione: 6 agosto 2026 · Prossima revisione: 6 febbraio 2027

Questo documento dice cosa si fa quando qualcosa va storto con i dati. Esiste
perché senza un piano scritto, nel momento in cui serve si improvvisa — e si
improvvisa male, di notte, sotto pressione.

È deliberatamente breve. CoreWard è gestito da una persona sola: una procedura
con sei livelli di escalation sarebbe una finzione.

---

## 1. Chi risponde

**Responsabile unico**: il titolare di CoreWard, che è anche l'unica persona con
accesso ai sistemi di produzione.

**Contatto di sicurezza**: security@kerdon.io — casella da tenere
raggiungibile e controllata quotidianamente. È l'indirizzo pubblicato per le
segnalazioni esterne, incluse quelle di ricercatori di sicurezza.

Non esistono altri membri dello staff. Se un giorno esisteranno, questa sezione
va riscritta prima che ricevano gli accessi, non dopo.

---

## 2. Cosa conta come incidente

Qualunque evento che comprometta la riservatezza, l'integrità o la disponibilità
dei dati trattati. In concreto, per questa architettura:

| Evento | Gravità |
|---|---|
| Esposizione di `SHOPIFY_API_SECRET`, `ENCRYPTION_SECRET` o `SUPABASE_OAUTH_CLIENT_SECRET` | Critica |
| Accesso non autorizzato al database owner | Critica |
| Token di lettura di un merchant usato da terzi | Alta |
| Lettura di dati dei clienti oltre il consenso o oltre il piano | Alta |
| Password di un database Supabase esposta | Alta |
| Indisponibilità prolungata della sincronizzazione | Media |
| Vulnerabilità segnalata ma non ancora sfruttata | Media |

I dati dei clienti dei merchant vivono nei progetti Supabase dei merchant, non
sull'infrastruttura di CoreWard. Un incidente su quei progetti riguarda il
merchant come titolare: CoreWard collabora ma non è il custode.

---

## 3. Come ci si accorge

Le fonti di segnale, in ordine di quanto sono affidabili:

1. **Registro degli accessi** (`customer_data_access_logs`): un picco di
   `denied_invalid_token`, o accessi `allowed` in orari senza traffico, sono il
   segnale più diretto che qualcuno sta provando token altrui.
2. **Segnalazione di un merchant** o di un ricercatore, via
   security@kerdon.io.
3. **Notifica di Shopify** o di Supabase.
4. **Log della piattaforma**: errori anomali su Vercel, Advisors di Supabase.

Non esiste monitoraggio automatico con allerta. È un limite noto e dichiarato:
finché il numero di merchant è basso, il controllo è manuale e periodico.

---

## 4. Cosa si fa, nell'ordine

### Entro 1 ora dalla scoperta — contenere

Fermare l'emorragia prima di capirla. Le leve disponibili, dalla più mirata alla
più drastica:

- **Singolo negozio compromesso**: portare `trackingAuthorization` a `DISABLED`.
  Il proxy nega ogni lettura per quel negozio, il tracciamento smette di ricevere
  dati, la sincronizzazione si ferma.
- **Token di lettura esposto**: rigenerare `readProxyTokenHash` /
  `readProxyTokenEnc` del negozio interessato.
- **Credenziali dell'app esposte**: rigenerare il client secret dal dashboard
  Shopify e aggiornare le variabili su Vercel.
- **Database owner compromesso**: cambiare la password del database Supabase e
  ruotare `ENCRYPTION_SECRET`. Attenzione: ruotare quel valore rende
  indecifrabili i token già salvati, quindi va fatto solo insieme alla
  reinstallazione dell'app sui negozi coinvolti.
- **Compromissione estesa**: sospendere l'app togliendo `DATABASE_URL` da Vercel.
  Tutto si ferma, niente si perde.

### Entro 24 ore — valutare

Stabilire, con i log alla mano: cosa è stato raggiunto, quali dati personali sono
coinvolti, quanti merchant e quanti dei loro clienti, e se l'accesso è ancora in
corso. Le risposte si scrivono man mano, non a memoria dopo.

### Entro 72 ore — notificare

- **Ai merchant coinvolti**: senza ingiustificato ritardo. Sono i titolari del
  trattamento e devono poter adempiere ai propri obblighi. Si comunica cosa è
  successo, quali dati, cosa è stato fatto, cosa devono fare loro.
- **A Shopify**: attraverso i canali del Partner Program, per qualunque incidente
  che coinvolga dati protetti dei clienti o le credenziali dell'app.
- **All'autorità di controllo**: dove previsto, entro 72 ore dalla scoperta. Il
  ruolo di CoreWard è di responsabile del trattamento, quindi l'obbligo primario
  è verso i titolari — ma la valutazione va fatta caso per caso, non data per
  scontata.

Una notifica incompleta e puntuale vale più di una completa e tardiva.

### Entro 7 giorni — chiudere

Rimuovere la causa, non solo l'effetto. Scrivere un breve resoconto: cosa è
successo, perché è stato possibile, cosa impedisce che si ripeta. Il resoconto
resta nel repository, in `docs/incidents/`, anche quando l'incidente si è
rivelato un falso allarme.

---

## 5. Cosa si conserva

- **Registro degli accessi**: un anno (`ACCESS_LOG_RETENTION_DAYS`).
- **Resoconti degli incidenti**: senza scadenza. Sono la memoria di cosa è già
  andato storto.
- **Log della piattaforma**: quanto li conserva il fornitore, che è meno di
  quanto servirebbe. Le indagini che dipendono da quelli vanno fatte subito.

---

## 6. Limiti dichiarati

Onestà su cosa questa policy non copre, perché una policy che promette più di
quanto la struttura può mantenere è peggio dell'assenza di policy:

- Nessuna reperibilità continua: la risposta parte quando il responsabile legge.
- Nessun allertamento automatico sui segnali del punto 3.
- Nessuna certificazione di terze parti (SOC 2, ISO 27001) e nessun audit esterno.
- Nessun test periodico di questa procedura.

Il primo di questi limiti da chiudere, quando il numero di merchant lo
giustificherà, è l'allertamento automatico sul registro degli accessi.
