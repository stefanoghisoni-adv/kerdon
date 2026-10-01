# Il database owner: come si cambia

Questo documento e' per chi eseguira' una migrazione sul database owner (Live e
Test). Non serve aver scritto il codice ne' sapere di database: serve seguire i
passi nell'ordine e fermarsi dove il documento dice di fermarsi. I passi sono
in "La procedura, passo per passo"; il resto spiega il perche'.

## In una riga

Le migrazioni si applicano **da GitHub Actions**, a mano, con
un'approvazione — mai incollando SQL nell'editor di Supabase, e mai in
automatico insieme al deploy dell'app.

## Le tre strade, e a cosa servono

| Strada | Quando | Cosa fa |
| --- | --- | --- |
| `prisma/owner-bootstrap.sql` | si ricostruisce un ambiente da zero | crea tutto: tabelle, piani, listino, RLS, chiavi esterne |
| `prisma migrate deploy` | il database esiste gia' e deve cambiare | applica le sole migrazioni non ancora applicate |
| `.github/workflows/migrate-production.yml` | il database e' quello owner, Live o Test | fa la stessa cosa, ma dietro un'approvazione, con i controlli prima e dopo e un registro di ogni esecuzione |

`prisma/migrations/0_init/migration.sql` e' la fotografia dello schema alla
linea di base (`20260926000000_plans_basic_growth_scale_core`), ed e' **fermo**:
un test (`prisma/migrations.test.ts`) ne controlla l'impronta. Oggi coincide
ancora con `owner-bootstrap.sql`; dalla prima migrazione scritta dopo la linea
di base lo script va avanti e `0_init` no. Che le due strade arrivino comunque
allo stesso database lo prova la CI (job `migrations`, `prisma/percorsi-uguali.ts`).
Il perche' in "`0_init` non si tocca", in fondo.

## La procedura, passo per passo

Questa e' la sezione da seguire. Vale per **Test** e per **Live**, sempre in
quest'ordine: prima Test, e Live solo quando Test e' arrivato verde in fondo.
Tutto quello che c'e' da fare si fa da GitHub e dal proprio computer; niente
si incolla nell'editor SQL di Supabase.

Ogni lancio del workflow si fa da GitHub: **Actions → Migrazione del database
di produzione → Run workflow**, con `Use workflow from: main` (l'unica
eccezione e' una migrazione che aggiunge qualcosa e deve precedere il merge:
"L'ordine fra migrazione e deploy del codice"), scegliendo tre cose: il **database** (`test` o `live`), l'**azione**
(`verifica`, `linea-di-base`, `applica`) e la spunta sul **backup**. Poi GitHub
chiede l'approvazione (il pulsante **Review deployments** nella pagina del run)
e solo dopo il workflow si collega al database.

### Passo 0 — una volta sola: preparare GitHub

Su GitHub, **Settings → Environments**, due environment:

| Environment | Database | Chi lo approva |
| --- | --- | --- |
| `test` | il database owner di Test | tu (Required reviewers) |
| `production` | il database owner di Live | tu (Required reviewers) |

In ognuno: spuntare **Required reviewers** e mettersi in elenco (e' questo che
fa fermare il workflow in attesa di approvazione). Non limitarli al solo ramo
`main` (Deployment branches): una migrazione che aggiunge qualcosa si applica
dal ramo della PR, prima del merge, e l'approvazione resta il cancello. Poi due
segreti **dell'environment**, non del repository, con gli
stessi nomi in tutti e due (il nome `PRODUCTION_` e' storico: in `test`
puntano al database di Test):

| Segreto | Valore | Nota |
| --- | --- | --- |
| `PRODUCTION_DATABASE_URL` | l'indirizzo del database, con `?schema=public` in fondo | lo usa Prisma |
| `PRODUCTION_PSQL_URL` | lo stesso indirizzo, **senza** `?schema=public` | lo usa `psql` |

Quale indirizzo: vedi "La connessione" piu' sotto. In breve, da Supabase
**Connect → Session pooler** (porta **5432**), non "Transaction pooler" (6543).

### Passo 1 — il backup, e controllare che ci sia davvero

Prima di `linea-di-base` e di `applica`, sempre. Per `verifica` non serve: non
scrive niente.

Il backup che si puo' controllare e' una copia scaricata sul proprio computer.
Da Terminale, nella cartella dove si vogliono tenere le copie:

```bash
# Incollare l'indirizzo quando lo chiede (Session pooler, senza ?schema=public).
# Non si vede mentre lo si incolla, ed e' voluto: cosi' non resta nella
# cronologia del Terminale.
read -rs INDIRIZZO_DB

pg_dump "$INDIRIZZO_DB" --schema=public --format=custom --no-owner --no-privileges \
  --file "kerdon-test-$(date +%Y%m%d-%H%M).dump"
```

(`kerdon-test` o `kerdon-live` a seconda del database.)

Poi il controllo — un backup che non si e' guardato non e' un backup:

```bash
ls -lh kerdon-test-*.dump                                   # deve esistere e pesare piu' di qualche KB
pg_restore --list kerdon-test-AAAAMMGG-HHMM.dump | grep -c "TABLE DATA"   # quante tabelle con dati: decine, non zero
pg_restore --list kerdon-test-AAAAMMGG-HHMM.dump | grep -E "TABLE DATA public (shops|plans|plan_prices)"
```

L'ultimo comando deve stampare **tre righe**, una per `shops`, `plans` e
`plan_prices`. Se `pg_dump` da' errore, o se manca una delle tre righe: **non
mettere la spunta**, il backup non c'e'.

In piu', se il progetto Supabase e' su un piano a pagamento: **Database →
Backups** deve mostrare un backup giornaliero di oggi. E' un secondo paracadute,
non sostituisce il file: non lo si puo' aprire per controllarlo.

Il file `.dump` si tiene almeno finche' la migrazione non ha girato per qualche
giorno senza problemi. Contiene dati dei negozi: non va in cartelle condivise.

### Passo 2 — `verifica`

Database `test`, azione `verifica`, spunta backup non necessaria. Approvare
quando GitHub lo chiede.

`verifica` non scrive niente. Guarda quattro cose e le scrive nel registro del
run:

| File nel registro | Cosa dice | Verde vuol dire |
| --- | --- | --- |
| `02-stato-prima.log` | cosa Prisma ha nel suo registro e cosa e' in attesa | `ESITO: nessuna migrazione in attesa` oppure `ESITO: ci sono migrazioni in attesa` |
| `03-deriva-prima.log` | il database e' quello che dicono le migrazioni gia' registrate (prima della linea di base: quelle fino alla linea di base)? Le migrazioni in attesa sono elencate a parte e non contano | `Nessuna deriva inattesa` |
| `04-controlli-prima.log` | piani, listino, RLS, chiavi esterne sul piano | finisce con `DO`, nessun `ERROR` |
| `05-linea-di-base-resoconto.log` | la linea di base: c'e'? se no, cosa si marcherebbe | `La linea di base c'e' gia'` oppure l'elenco "Da marcare" |

### Passo 3 — leggere e conservare l'output

L'output di ogni run sta in due posti, gia' ripulito da password e indirizzi:

- **il riepilogo**, in fondo alla pagina del run: un riquadro per file,
  da aprire con un clic;
- **l'artifact** `registro-<database>-<azione>-<numero>`, nella stessa pagina
  sotto "Artifacts": si scarica come zip.

GitHub cancella entrambi dopo 90 giorni. Scaricare lo zip di **ogni** run di
`linea-di-base` e `applica` (e del `verifica` che li precede e li segue) e
tenerlo accanto al backup, per esempio in una cartella
`Kerdon/registri-migrazioni/` con nomi come `2026-10-02-test-verifica.zip`. E'
la prova di cosa e' stato fatto, quando e su quale commit
(`00-intestazione.log`).

### Passo 4 — quando fermarsi

Ci si ferma — non si rilancia, non si prova `applica` "per vedere" — se:

- il run e' rosso, in qualunque passo;
- `02-stato-prima.log` dice `FERMATI` (una migrazione fallita, o Prisma non
  riesce a collegarsi: vedi "La connessione");
- `03-deriva-prima.log` elenca una "Deriva inattesa": ogni riga chiede una
  decisione (vedi "La prima volta: la deriva");
- `05-linea-di-base-resoconto.log` dice `FERMATI`, o elenca come "NON PROVATA"
  una migrazione che non ti aspetti;
- l'elenco delle migrazioni in attesa contiene qualcosa che non sai spiegare.

In tutti questi casi: scaricare il registro e chiedere, con il registro in mano.

### Passo 5 — `linea-di-base`, una volta sola per database

Serve solo se `05-linea-di-base-resoconto.log` **non** dice "La linea di base
c'e' gia'". Succede la prima volta, perche' fino a oggi le migrazioni sono state
incollate a mano e Prisma non ha un registro.

1. Leggere nel resoconto l'elenco "Da marcare come applicate" e quello
   "Restano in attesa". Ci si aspetta che in attesa ci siano **zero**
   migrazioni (se il database ha gia' tutto, compresa la migrazione del 26
   settembre incollata a mano) oppure solo migrazioni dal **23 settembre** in
   poi. Qualunque altra cosa: fermarsi.
2. Backup (passo 1).
3. Database `test`, azione `linea-di-base`, spunta backup. Approvare.
4. Il run deve essere verde. `06-linea-di-base.log` finisce con
   `RLS attivata sul registro delle migrazioni`.
5. Rilanciare `verifica` (passo 2): ora il resoconto deve dire "La linea di base
   c'e' gia'".

Cosa fa e cosa non fa: scrive nel registro di Prisma "queste migrazioni ci sono
gia'", **senza eseguirle e senza toccare tabelle o dati**, e solo per quelle che
riesce a dimostrare presenti. Come le dimostra: "La linea di base: come decide"
piu' sotto.

### Passo 6 — `applica`, se c'e' qualcosa in attesa

Solo se `02-stato-prima.log` dell'ultimo `verifica` dice
`ci sono migrazioni in attesa`, e solo se l'elenco e' quello che ti aspetti.

1. La CI e' verde sul commit da cui si lancia il workflow: l'ultimo di `main`,
   o quello del ramo della PR quando la migrazione deve precedere il merge
   (pagina **Actions**, workflow **CI**).
2. Backup (passo 1) — fatto **adesso**, non quello di ieri.
3. Database `test`, azione `applica`, spunta backup. Approvare: e' il momento
   in cui si decide davvero. Prima di cliccare, riguardare l'elenco delle
   migrazioni in attesa.
4. Il run applica le migrazioni (`06-applica.log`) e subito dopo ricontrolla
   tutto sul database migrato.

### Passo 7 — i controlli dopo

Dopo `applica`, nel registro dello stesso run, tre file e tre verdi:

| File | Verde vuol dire |
| --- | --- |
| `07-stato-dopo.log` | `Database schema is up to date!` (niente piu' in attesa) |
| `08-deriva-dopo.log` | `Nessuna deriva inattesa` (in fase `post`: anche `plans.max_orders` non deve esserci piu') |
| `09-controlli-dopo.log` | finisce con `DO`, nessun `ERROR`: listino finale, RLS ovunque (registro compreso), chiavi esterne sul piano |

Ognuno dei tre, se fallisce, rende rosso il run. Poi rilanciare `verifica` una
volta: deve essere verde e dire "nessuna migrazione in attesa".

### Passo 8 — se qualcosa fallisce

- **Rosso prima di `Apply the pending migrations`** (o in `verifica`): non e'
  stato toccato niente. Fermarsi e leggere il registro.
- **Rosso in `Apply the pending migrations`**: Prisma ha segnato la migrazione
  come fallita e non ne applichera' altre. **Non rilanciare.** Scaricare il
  registro e seguire "Come si torna indietro".
- **Verde in `applica` ma rosso nei controlli dopo**: la migrazione e' passata
  ma il database non e' come dovrebbe (per esempio una tabella senza RLS). Non
  si torna al backup per questo: si scrive una migrazione che corregge, e si
  ripete dal passo 2.
- **L'app non funziona dopo la migrazione** e i dati sono stati danneggiati:
  e' il caso del backup. Fermare tutto e chiedere aiuto prima di ripristinare:
  un ripristino sovrascrive anche quello che i negozi hanno scritto nel
  frattempo.

### Passo 9 — Live

Quando Test e' arrivato verde fino al passo 7: stessi passi, con database
`live`. Un backup nuovo, preso da Live. Se Live mostra qualcosa che Test non
mostrava (una deriva, una migrazione "NON PROVATA"), ci si ferma lo stesso: i
due database sono stati aggiornati a mano in momenti diversi e possono non
essere uguali.

## La connessione: niente pooler transaction

Supabase espone tre indirizzi per lo stesso database (pulsante **Connect** in
alto nella dashboard del progetto):

| Indirizzo | Porta | DDL (migrazioni) | Raggiungibile da GitHub |
| --- | --- | --- | --- |
| Direct connection, `db.<ref>.supabase.co` | 5432 | si' | di solito **no**: e' solo IPv6, e le macchine di GitHub Actions non hanno IPv6 (a meno dell'add-on IPv4 di Supabase) |
| Session pooler, `aws-0-<regione>.pooler.supabase.com`, utente `postgres.<ref>` | 5432 | si' | si' |
| Transaction pooler | **6543** | **no** | si' |

Il pooler in modalita' transaction non esegue DDL: e' il motivo per cui finora
le migrazioni si incollavano a mano nell'SQL editor. Il workflow si rifiuta di
partire se riceve un indirizzo sulla 6543 o con `pgbouncer=true`.

Quindi, nei segreti: il **Session pooler**. La connessione diretta va bene solo
se il progetto ha l'add-on IPv4. Se il primo `verifica` si ferma con
`P1001: Can't reach database server`, e' quasi sempre questo.

I due segreti sono lo stesso indirizzo scritto in due modi:

```
PRODUCTION_DATABASE_URL  postgresql://postgres.<ref>:<password>@aws-0-<regione>.pooler.supabase.com:5432/postgres?schema=public
PRODUCTION_PSQL_URL      postgresql://postgres.<ref>:<password>@aws-0-<regione>.pooler.supabase.com:5432/postgres
```

Prisma vuole `?schema=public`; `psql` quel parametro non lo conosce e rifiuta
l'intero indirizzo con `invalid URI query parameter: schema`. Se la password
contiene caratteri come `@`, `/` o `#` va scritta codificata (`%40`, `%2F`,
`%23`).

## La prima volta: la deriva

Il primo `verifica` su un database aggiornato a mano puo' fermarsi in
`03-deriva-prima.log`, ed e' voluto: e' li' per mostrare la deriva che c'e'
davvero. Quello che ci si puo' aspettare di vedere:

- **`shops_current_plan_fkey` e `shops_last_synced_plan_fkey`**: non sono deriva,
  sono volute — vedi "Le due chiavi esterne sul nome del piano". Il controllo le conosce e non se ne
  lamenta;
- **`supabase_configs.supabase_db_password`**: una colonna aggiunta da una
  migrazione di luglio e mai rimossa, sparita nel frattempo da `schema.prisma`.
  L'app non la legge piu'. E' gia' nella lista delle derive tollerate, con
  scritto che va tolta con una migrazione scritta apposta;
- **`sync_jobs.id` (e le colonne che lo referenziano) di tipo `uuid` invece di
  `text`**: quel pezzo di schema e' nato a mano in Supabase, mentre Prisma per un
  `String @id` scrive `text`. Se compare, **non convertire il tipo**: e' una
  colonna di chiave primaria con delle chiavi esterne addosso, e la conversione
  va pensata a parte;
- **`plans.max_orders`** (solo se il listino e' ancora quello di
  `pricing_alignment`): prima di `migrate deploy` e' atteso, perche' lo toglie
  la migrazione del 26. I controlli prima delle migrazioni girano in fase `pre`
  (`expected-drift.ts --fase=pre`, `bootstrap-check.sql -v fase=pre`), che
  accetta questo stato di partenza e anche i due listini di prima; quelli dopo
  girano in fase `post` e pretendono il listino finale e niente `max_orders`;
- una tabella che `schema.prisma` ha e il database no (per esempio una
  `CREATE TABLE` nell'elenco): una migrazione incollata a meta', o mai
  incollata;
- qualunque altra cosa: fermarsi e guardarla.

Per ogni differenza che compare ci sono tre risposte possibili, e nessuna e'
"applico il diff":

1. il database ha ragione → si aggiorna `schema.prisma`;
2. lo schema ha ragione → si scrive una migrazione;
3. e' una differenza voluta → si aggiunge a `prisma/expected-drift.ts`, con
   scritto **perche'**.

Il workflow ricomincia a passare quando ogni riga ha ricevuto una risposta, e
la linea di base si puo' fare solo da li': la sua prova principale e' proprio
questo confronto.

## La linea di base: come decide

Il database owner ha lo schema, ma non `_prisma_migrations`, il registro in cui
Prisma scrive cosa e' gia' stato applicato: le migrazioni finora sono state
incollate a mano. Senza registro `prisma migrate deploy` si rifiuta di partire
(errore P3005, "the database schema is not empty").

Stabilire la linea di base vuol dire scrivere nel registro "queste ci sono
gia'" con `prisma migrate resolve --applied`, che **non esegue SQL**. E' anche
il punto piu' delicato di tutto il percorso: una migrazione dichiarata
applicata senza esserlo e' **persa per sempre**, perche' da quel momento
`migrate deploy` la salta e nessun controllo chiede piu' se c'e' davvero.

Per questo non si marca a mano e non si marca da un elenco scritto in questo
documento (com'era prima): lo fa `prisma/linea-di-base.ts`, e marca solo cio'
che **dimostra** presente nel database. Per ogni migrazione ha una prova:

- **struttura** — per le migrazioni che creano o cambiano tabelle, colonne,
  indici, chiavi esterne, tipi e RLS. La prova e' che il database corrisponda
  allo schema a cui portano le migrazioni **fino alla linea di base**, che
  Prisma rigioca su un database di appoggio vuoto (lo fornisce il workflow da
  se', non serve niente), con RLS su ogni tabella e le due chiavi esterne sul
  nome del piano. Non contro `schema.prisma`: quello contiene anche le
  migrazioni scritte dopo la linea di base, che il database non ha ancora — e
  dalla prima di esse la prova non passerebbe piu';
- **una domanda sui dati** — per le migrazioni che hanno toccato anche il
  contenuto, che il confronto con lo schema non vede: il partner iniziale,
  il prezzo in dollari di ogni piano, i giorni di prova, e soprattutto il
  listino (23 e 26 settembre).

Poi decide cosi':

1. marca il tratto **iniziale** di migrazioni provate, e si ferma alla prima non
   provata. Tutto cio' che viene dopo resta in attesa e lo applichera'
   `applica`. Mai il contrario: una migrazione non provata che girasse dopo una
   successiva gia' marcata girerebbe sullo stato sbagliato (la migrazione del 23
   rigiocata sopra il listino finale riscrive i limiti del piano Core);
2. se in attesa resterebbe qualcosa che il database **deve** avere — tutto cio'
   che precede il 23 settembre, che l'app usa da settimane — **non marca
   niente** e si ferma: e' uno stato che nessuno ha previsto;
3. dopo aver marcato, attiva RLS sul registro: Prisma lo crea senza, e su
   Supabase una tabella di `public` senza RLS e' leggibile e scrivibile con la
   chiave pubblica del progetto.

**La migrazione del 26 settembre incollata a mano**
(`20260926000000_plans_basic_growth_scale_core`, su Live e su Test). La sua
prova e' il listino finale:
Basic/Growth/Scale/Core e Lifetime, nessun nome vecchio sui piani, sugli
addebiti e sui prezzi riservati, niente `max_orders`, prezzi in euro e in
dollari. Se il database lo ha, la migrazione e' provata e viene marcata, e
insieme a lei quelle del 22 e del 23 (la guardia non avrebbe niente da fare, e
la 23 e' superata dalla 26). Se invece il listino non e' quello finale, la 26
resta in attesa e la applica `applica`: e' scritta per arrivare al listino
finale da tutti e due i listini di prima, e rieseguita su quello finale non
cambia niente.

Il resoconto (`05-linea-di-base-resoconto.log`) elenca migrazione per
migrazione "PROVATA" o "NON PROVATA" e con quale prova: e' la cosa da leggere
prima di lanciare `linea-di-base`.

Se si interrompe a meta' (rete, run annullato), rilanciare `linea-di-base`:
riconosce il registro incompleto e riprende da dove era arrivato.

**Un registro con dei buchi ferma tutto.** Il registro e' sempre un tratto
iniziale delle cartelle: Prisma scrive e applica in ordine. Se una migrazione
non risulta applicata ma una successiva si' (qualcuno ha cancellato o scritto
righe a mano), il resoconto dice `FERMATI` ed elenca i buchi, e `applica` non
parte: `migrate deploy` rigiocherebbe il buco sopra lo stato delle successive —
la migrazione del 23 sopra il listino finale, per esempio. Si decide caso per
caso, con il registro in mano: o si dimostra che il buco c'e' e lo si dichiara
con `migrate resolve --applied`, o si capisce perche' manca.

## Ogni volta: una migrazione nuova

### 1. Scriverla

Una cartella in `prisma/migrations/`, chiamata `AAAAMMGGHHMMSS_nome_breve`, con
dentro un solo file `migration.sql`. Il nome decide **l'ordine di
applicazione**: deve venire dopo l'ultima cartella esistente.

Se la modifica nasce da un cambiamento di `schema.prisma`, l'SQL si fa generare:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL_DI_APPOGGIO" \
  --script
```

`DATABASE_URL_DI_APPOGGIO` e' un database **vuoto e usa e getta** — mai quello di
produzione: Prisma ci rigioca sopra tutte le migrazioni per capire dove sono
arrivate.

Tre regole, e sono quelle che hanno gia' fatto danni quando sono state saltate:

- **Ogni tabella nuova nasce con RLS.** Una riga
  `ALTER TABLE "nuova" ENABLE ROW LEVEL SECURITY;` nella stessa migrazione che la
  crea. Supabase pubblica lo schema `public` attraverso la Data API: senza quella
  riga la tabella e' leggibile con la sola chiave pubblica del progetto, che sta
  nei browser e non e' un segreto. E' successo con `compliance_requests`, che
  conteneva le esportazioni GDPR complete. Il test in `prisma/migrations.test.ts`
  ora si rifiuta di passare se una migrazione crea una tabella e non lo fa.
- **Scriverla idempotente** (`IF NOT EXISTS`, `IF EXISTS`, i controlli su
  `pg_constraint`). Costa una riga e rende la migrazione rieseguibile senza
  pensarci.
- **Non modificare una migrazione gia' applicata.** Prisma conserva l'impronta di
  ogni file e rifiuta di procedere se cambia. Una correzione e' una migrazione
  nuova.

### 2. Provarla

`npx vitest run` e la CI. Il job `migrations` costruisce un Postgres vuoto,
applica tutta la catena, verifica che il risultato sia lo schema dichiarato e
ricontrolla dati iniziali, RLS e chiavi esterne; poi prova la linea di base su
un database costruito con lo script, e confronta i due database fra loro
(`prisma/percorsi-uguali.ts`): lo script e le migrazioni devono arrivare allo
stesso risultato. Se passa li', passa in produzione.

### 3. Applicarla

Con la procedura passo per passo, dall'inizio: backup, `verifica`, `applica`,
controlli dopo, prima su Test e poi su Live. **Quando** farlo rispetto al merge
dipende da cosa fa la migrazione: la sezione qui sotto.

## L'ordine fra migrazione e deploy del codice

**Il merge su `main` e' il deploy.** Vercel pubblica in produzione ogni commit
su `main`, da solo e in un paio di minuti; le migrazioni invece partono solo
quando qualcuno lancia `applica`. Fra le due cose non c'e' nessun legame
automatico, ed e' voluto — quindi l'ordine giusto lo deve tenere chi rilascia.

La regola e' una sola: **in ogni momento il codice in produzione deve funzionare
con il database che ha davanti.** Da qui tre tempi (in gergo
*expand → deploy → contract*):

1. **Allargare** (expand): la migrazione che **aggiunge** — una tabella, una
   colonna, un indice — si applica **prima** del merge. Il codice vecchio non la
   conosce e non se ne accorge.
2. **Deployare**: il merge su `main`, cioe' il codice nuovo in produzione.
3. **Stringere** (contract): quello che va **tolto** — una colonna non piu'
   letta, una tabella vecchia — si toglie **dopo** il merge, quando il codice
   che lo usava non e' piu' in produzione.

### Perche' "prima del merge", e non "subito dopo"

Prisma, per ogni modello, chiede al database **tutte** le colonne che
`schema.prisma` dichiara, anche quelle che il codice non usa. Un merge che
aggiunge un campo a `schema.prisma` mette in produzione, due minuti dopo, un
client che chiede quella colonna: se nel database non c'e' ancora, **ogni**
lettura di quella tabella fallisce (`P2022: column does not exist`), non solo
quelle del codice nuovo. Se `applica` arriva un'ora dopo, o il giorno dopo,
l'app e' rotta per tutto quel tempo.

E non si puo' rimandare l'aggiunta a `schema.prisma`: la CI pretende che le
migrazioni e `schema.prisma` dicano la stessa cosa a ogni commit (job
`migrations`), quindi la migrazione e il campo nello schema viaggiano insieme.

### Una colonna o una tabella nuova (il caso piu' comune)

1. La PR contiene la migrazione, `schema.prisma` e il codice. La CI della PR e'
   verde.
2. Backup, poi il workflow lanciato **dal ramo della PR**: in "Run workflow",
   `Use workflow from:` il nome del ramo invece di `main`. `verifica`, poi
   `applica`, su Test e poi su Live. Il registro (`00-intestazione.log`) annota
   il commit da cui e' partito. In `verifica` la migrazione nuova compare in
   `02-stato-prima.log` come "in attesa" e in `03-deriva-prima.log` fra quelle
   "che non fanno parte del confronto": e' giusto cosi', il confronto prima di
   `applica` e' con le migrazioni gia' registrate, non con lo `schema.prisma`
   del ramo. Dopo `applica` invece `08-deriva-dopo.log` confronta con
   `schema.prisma`, e li' la colonna deve esserci.
3. Il merge, subito dopo, **senza piu' toccare la migrazione**: Prisma ne ha
   registrato l'impronta, e un file cambiato dopo l'applicazione fa fallire i
   controlli successivi.
4. Un `verifica` su Live da `main`: `nessuna migrazione in attesa`.

Due cautele per la migrazione:

- la colonna nuova nasce **facoltativa o con un default**. Fra il passo 2 e il
  passo 3 in produzione gira ancora il codice vecchio, che crea righe senza
  conoscerla: una colonna obbligatoria senza default gliele rifiuterebbe. Se
  deve diventare obbligatoria, lo diventa in un rilascio successivo;
- se la PR non viene unita (cambio di idea), la colonna resta nel database e va
  tolta con una migrazione: una colonna in piu' non rompe niente, ma
  `verifica` la segnalera' come deriva.

### Togliere o rinominare

L'ordine e' il rovescio:

1. La PR toglie l'uso dal codice, toglie il campo da `schema.prisma` e contiene
   la migrazione che toglie la colonna. Il merge, **senza** `applica`: il codice
   nuovo non la chiede piu', la colonna puo' restare dov'e'.
2. Quando il codice nuovo e' in produzione — compresi il worker e i cron, che
   sono "codice in produzione" anche loro — backup, `verifica`, `applica` da
   `main`.

Una rinomina e' sempre "aggiungi il nuovo, copia, sposta il codice, togli il
vecchio", in due rilasci, mai un `RENAME` secco mentre il codice vecchio e'
vivo. `20260825160000_plan_prices_backfill_base` e
`20260825170000_drop_plan_price_columns` sono l'esempio: nei loro commenti c'e'
scritto quale va prima e quale dopo.

Se una modifica deve sia aggiungere sia togliere, sono **due** PR: prima quella
che aggiunge (applicata prima del merge), poi quella che toglie (applicata dopo).

### Come si controlla, prima di ogni merge che tocca il database

- La PR aggiunge una cartella in `prisma/migrations/` che **aggiunge** qualcosa?
  Allora prima del merge c'e' un `applica` verde lanciato da quel ramo, su Live,
  e nel suo `07-stato-dopo.log` c'e' `Database schema is up to date!`.
- La PR aggiunge una migrazione che **toglie** qualcosa? Allora non aggiunge
  anche altro, e l'`applica` si lancia dopo il merge.
- La PR cambia `schema.prisma` senza una migrazione? La CI la ferma: le due cose
  vanno insieme.

## Cambiare il consumatore della coda

Vale per `20260905120000_sync_request_queue`, che porta `sync_requests` e
`shop_locks`, e vale per qualunque cambio futuro di chi drena la coda. Il perche'
della coda su Postgres sta in `docs/architecture/queue-adr.md`.

**La regola che tiene insieme tutto: mai due consumatori accesi insieme.** Due
implementazioni diverse del drenaggio hanno due prese che non si parlano, e
finiscono per lavorare lo stesso item — che e' il guasto da cui la coda nuova
nasce. Un consumatore solo puo' invece girare in piu' invocazioni
contemporanee: la presa e' atomica.

Oggi la coda vecchia e' di fatto vuota (l'app non e' pubblicata e l'unico
negozio e' `coreward-demo`), quindi i passi 2 e 3 non troveranno quasi niente.
Vanno fatti lo stesso: la procedura serve quando la coda **non** e' vuota, e
provarla adesso costa cinque minuti.

### 1. Applicare la migrazione, con il codice vecchio ancora in produzione

E' additiva — due tabelle nuove — quindi si applica **prima** del deploy. Il
codice vecchio non conosce quelle tabelle e non le tocca.

### 2. Fermare l'accodamento e il drenaggio

- Su GitHub: Actions → **sync-cron** → `Disable workflow`. E' il drenaggio ogni
  trenta minuti.
- Su Vercel: Project → Settings → Cron Jobs → disattivare `/api/cron/sync`. E'
  il giro giornaliero.
- Se in locale gira `npm run worker`, fermarlo.

Da questo momento nessuno drena. I gesti manuali dei merchant continuano ad
accodare su Redis: e' voluto, e li si migra al passo dopo.

### 3. Migrare gli item pendenti, una volta sola

Con il worker fermo e i cron spenti, si legge cosa era rimasto in coda su Redis
e lo si riscrive in `sync_requests`. Serve `REDIS_URL` e `DATABASE_URL` in
ambiente:

```bash
npx tsx -e "
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const redis = new IORedis(process.env.REDIS_URL!);
const prisma = new PrismaClient();

// I job in attesa della coda vecchia: BullMQ li tiene in due liste per nome.
const ids = [
  ...(await redis.lrange('bull:sync-queue:wait', 0, -1)),
  ...(await redis.lrange('bull:sync-queue:delayed', 0, -1)),
];

let migrati = 0;
for (const id of ids) {
  const dati = await redis.hget(\`bull:sync-queue:\${id}\`, 'data');
  if (!dati) continue;
  const job = JSON.parse(dati);
  const tipi = ['manual-sync', 'initial-bulk-sync', 'periodic-sync-check', 'compliance-request'];
  if (!tipi.includes(job.type)) { console.warn('saltato, tipo ignoto:', job.type); continue; }

  const esito = await prisma.syncRequest.createMany({
    data: [{
      id: randomUUID(),
      shopId: job.shopId ?? null,
      type: job.type,
      payload: job.requestId ? { requestId: job.requestId } : undefined,
      // La chiave di migrazione porta l'id vecchio: rieseguire questo comando
      // non produce doppioni.
      dedupKey: \`migrazione:\${job.type}:\${id}\`,
      status: 'queued',
    }],
    skipDuplicates: true,
  });
  migrati += esito.count;
}

console.log('Migrati:', migrati, 'su', ids.length, 'trovati.');
await redis.quit();
await prisma.\$disconnect();
"
```

Controllare il risultato prima di proseguire:

```sql
SELECT type, status, count(*) FROM sync_requests GROUP BY 1, 2;
```

### 4. Deployare il codice nuovo

Push su `main`. Da questo istante l'accodamento scrive su `sync_requests` e la
coda su Redis non riceve piu' niente.

### 5. Riaccendere il consumatore, uno solo

- Riabilitare **sync-cron** su GitHub.
- Riabilitare il cron di Vercel.
- Verificare che nessun altro drenaggio sia acceso: nessun worker, nessuno
  script, nessuna rotta che chiami i processor direttamente.

Un giro a vuoto per controllare:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/sync
```

La risposta ha i conteggi: `drained`, `retried`, `deadLettered`,
`skippedLocked`, `lockUnavailable`, `unknownType`. Un `unknownType` maggiore di
zero vuol dire che qualcosa e' stato migrato con un tipo che il codice non
conosce, e sta in lettera morta.

### 6. Cosa guardare nei giorni dopo

```sql
-- Quel che e' fermo e chiede attenzione.
SELECT id, type, shop_id, attempts, last_error, updated_at
FROM sync_requests WHERE status = 'dead_letter' ORDER BY updated_at DESC;

-- Lucchetti rimasti presi piu' del dovuto (dovrebbero essere sempre pochi
-- secondi, e la potatura del cron toglie gli scaduti da oltre un'ora).
SELECT * FROM shop_locks WHERE expires_at < now();
```

Per far ripartire quel che e' in lettera morta, dopo aver aggiustato la causa:

```bash
npm run queue:replay                  # elenca e basta
npm run queue:replay -- <id> <id>     # rimette in coda quelli
npm run queue:replay -- --tutti       # rimette in coda tutto
```

### Se qualcosa va storto

La coda nuova non cancella mai un item fallito: torna in coda distanziato, e
dopo cinque tentativi va in lettera morta. Quindi il modo di "tornare indietro"
e' spegnere il cron, non svuotare la tabella — quello che c'e' dentro e' lavoro
ancora da fare.

## Come si torna indietro

Prisma non ha un `migrate down`: le migrazioni vanno in una direzione sola.

**Se la migrazione fallisce a meta'.** Prisma segna quella migrazione come
fallita e si rifiuta di applicarne altre finche' non si risolve. Si guarda
l'errore, si sistema il database a mano fino allo stato in cui la migrazione
avrebbe dovuto lasciarlo, e poi:

```bash
npx prisma migrate resolve --rolled-back "<nome_cartella>"   # l'ho annullata
# oppure
npx prisma migrate resolve --applied "<nome_cartella>"       # l'ho completata a mano
```

**Se la migrazione riesce ma era sbagliata.** Non si cancella la riga da
`_prisma_migrations`: si scrive una migrazione nuova che disfa quello che ha
fatto. Resta la storia di cosa e' successo, che e' esattamente il punto.

**Se ha distrutto dei dati.** Il ripristino e' il backup preso al passo 1 (il
file `.dump`, o quello giornaliero di Supabase). E' il motivo per cui il
workflow chiede la spunta prima di applicare. Un ripristino sovrascrive anche
cio' che i negozi hanno scritto dopo il backup: va deciso, non fatto d'istinto.

## Le due chiavi esterne sul nome del piano

`shops_current_plan_fkey` e `shops_last_synced_plan_fkey` legano il nome del
piano scritto sul negozio al listino in `plans`. **Non vanno cancellate mai.**

Non sono in `schema.prisma` — Prisma modella le relazioni sull'id, qui il legame
e' sul **nome** — quindi ogni `prisma migrate diff --from-url` le vede come
qualcosa che nel database c'e' e nello schema no, e propone di cancellarle. Chi
applicasse quell'output alla lettera lo farebbe.

Cosa si perderebbe:

- nel Table Editor di Supabase `current_plan` tornerebbe a essere un campo di
  testo libero invece di un elenco a tendina: un refuso passerebbe;
- un piano rinominato non si propagherebbe piu' ai negozi (`ON UPDATE CASCADE`),
  ed e' gia' successo che le ricerche per nome si rompessero per questo;
- un piano in uso si potrebbe cancellare dal listino (`ON DELETE RESTRICT`),
  lasciando negozi con un piano che non esiste.

Sono create in fondo a `owner-bootstrap.sql`, dopo gli `INSERT` sui piani — prima
non ci sarebbe niente a cui puntare — e da
`20260804160000_plan_name_foreign_keys` per chi arriva dalle migrazioni.

Tre controlli le proteggono, e sono tre perche' la prima volta e' bastato un
`migrate diff` letto in fretta:

- `prisma/expected-drift.ts` le conosce e non le segnala come deriva, ma segnala
  se **spariscono**;
- `prisma/bootstrap-check.sql` fallisce se non ci sono;
- il workflow di migrazione esegue entrambi, prima e dopo.

Se dovessero mancare, le ricrea la coda di `owner-bootstrap.sql`.

## `0_init` non si tocca

`0_init` e' la fotografia dello schema alla linea di base, e non cambia piu',
per due motivi:

- da quando un database e' stato messo in linea di base, Prisma confronta il
  contenuto di ogni cartella con l'impronta registrata: modificare
  `prisma/migrations/0_init/migration.sql` fa fallire ogni `migrate deploy`
  successivo con "migration file has been modified";
- la prova di struttura della linea di base confronta il database con lo schema
  delle migrazioni fino alla linea di base, `0_init` compreso. Un `0_init`
  rigenerato con dentro una migrazione successiva renderebbe la linea di base
  impossibile su un database che quella migrazione non l'ha ancora.

Quindi: ogni cambiamento allo schema, anche ai dati iniziali, e' una migrazione
nuova; `owner-bootstrap.sql` si continua a rigenerare per descrivere lo stato
finale (le istruzioni sono nella sua intestazione), e `0_init` resta com'e'. Il
test in `prisma/migrations.test.ts` ne controlla l'impronta, e pretende che
coincida con lo script solo finche' non esistono migrazioni dopo la linea di
base.
