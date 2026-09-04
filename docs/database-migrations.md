# Il database owner: come si cambia

Questo documento e' per chi eseguira' una migrazione sul database owner di
produzione. Non serve aver scritto il codice: serve seguire i passi nell'ordine
e fermarsi dove il documento dice di fermarsi.

## In una riga

Le migrazioni si applicano **da GitHub Actions**, a mano, con
un'approvazione — mai incollando SQL nell'editor di Supabase, e mai in
automatico insieme al deploy dell'app.

## Le tre strade, e a cosa servono

| Strada | Quando | Cosa fa |
| --- | --- | --- |
| `prisma/owner-bootstrap.sql` | si ricostruisce un ambiente da zero | crea tutto: tabelle, piani, listino, RLS, chiavi esterne |
| `prisma migrate deploy` | il database esiste gia' e deve cambiare | applica le sole migrazioni non ancora applicate |
| `.github/workflows/migrate-production.yml` | il database e' quello di produzione | fa la stessa cosa, ma dietro un'approvazione e con i controlli prima e dopo |

`prisma/migrations/0_init/migration.sql` e' la **copia identica** di
`owner-bootstrap.sql`: le due strade partono dallo stesso testo, e un test
(`prisma/migrations.test.ts`) non le lascia divergere. E' il motivo per cui un
database costruito con lo script e uno costruito con le migrazioni sono lo
stesso database.

## Prima di tutto: la connessione diretta, non il pooler

Supabase espone due porte. Il pooler (**6543**, `pgbouncer=true`) in modalita'
transaction **non esegue DDL**: e' il motivo per cui finora le migrazioni si
incollavano a mano nell'SQL editor. Tutto quello che segue vuole la connessione
**diretta**, porta **5432**.

Il workflow si rifiuta di partire se l'indirizzo che riceve punta al pooler.

## Una volta sola: la linea di base

Il database owner ha lo schema di oggi, ma non ha la tabella `_prisma_migrations`
che dice a Prisma cosa e' gia' stato applicato: le migrazioni finora sono state
eseguite a mano. Senza quella tabella `prisma migrate deploy` proverebbe a
rieseguirle tutte dalla prima.

Stabilire la linea di base vuol dire scrivere in quella tabella "queste ci sono
gia'", **senza eseguirle**. E' un'operazione che non tocca lo schema.

### 1. Preparare i segreti

Su GitHub, **Settings → Environments → New environment → `production`**:

- spuntare **Required reviewers** e mettersi in elenco (e' questo che fa fermare
  il workflow in attesa di approvazione);
- aggiungere due segreti **dell'environment**, non del repository:

| Segreto | Valore | Nota |
| --- | --- | --- |
| `PRODUCTION_DATABASE_URL` | `postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres?schema=public` | lo usa Prisma |
| `PRODUCTION_PSQL_URL` | `postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres` | lo usa `psql` |

Sono lo stesso indirizzo scritto in due modi, e servono entrambi: Prisma vuole
`?schema=public`, `psql` quel parametro non lo conosce e rifiuta l'intero
indirizzo con `invalid URI query parameter: schema`.

### 2. Guardare com'e' messo il database, prima di toccarlo

Lanciare il workflow **Migrazione del database di produzione** con azione
`verifica`. Non applica niente: stampa cosa Prisma vede e si ferma sulla prima
differenza inattesa fra il database e `schema.prisma`.

La prima volta questo passo **fallira' quasi certamente**, ed e' voluto: e' li'
per mostrare la deriva che c'e' davvero. Quello che ci si aspetta di vedere:

- **`shops_current_plan_fkey` e `shops_last_synced_plan_fkey`**: non sono deriva,
  sono volute — vedi l'ultima sezione. Il controllo le conosce e non se ne
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
- qualunque altra cosa: fermarsi e guardarla.

Per ogni differenza che compare ci sono tre risposte possibili, e nessuna e'
"applico il diff":

1. il database ha ragione → si aggiorna `schema.prisma`;
2. lo schema ha ragione → si scrive una migrazione;
3. e' una differenza voluta → si aggiunge a `prisma/expected-drift.ts`, con
   scritto **perche'**.

Il workflow ricomincia a passare quando ogni riga ha ricevuto una risposta.

### 3. Dichiarare applicato quello che c'e' gia'

Dalla propria macchina, con l'indirizzo **diretto** del database di produzione.
Questo passo va fatto una volta sola.

```bash
export DATABASE_URL='postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres?schema=public'

# Tutte le migrazioni tranne l'ultima, che sul database owner non e' mai passata.
for cartella in prisma/migrations/*/; do
  nome=$(basename "$cartella")
  [ "$nome" = "20260904120000_row_level_security_everywhere" ] && continue
  npx prisma migrate resolve --applied "$nome"
done
```

`migrate resolve --applied` **non esegue SQL**: scrive una riga in
`_prisma_migrations` e basta. Se il comando viene interrotto a meta' lo si
rilancia: le cartelle gia' dichiarate danno un errore innocuo e si va avanti.

L'esclusione riguarda `20260904120000_row_level_security_everywhere`, che e' la
prima migrazione che passera' davvero da questo percorso. Attiva RLS su ogni
tabella dello schema `public`: sul database owner alcune tabelle create dalle
migrazioni ne sono rimaste senza — fra le altre `meta_connections`, che porta il
token di accesso a Meta del negozio, e `product_feeds`, che porta il token con
cui si scarica un feed senza autenticarsi. Senza RLS quelle righe sono leggibili
da chiunque abbia la chiave pubblica del progetto.

### 4. Controllare che la linea di base sia giusta

```bash
npx prisma migrate status
```

Deve dire che c'e' **una sola** migrazione da applicare
(`20260904120000_row_level_security_everywhere`). Se ne elenca di piu', qualcosa
non e' stato dichiarato: rifare il passo 3 prima di andare avanti.

### 5. Applicarla

Lanciare il workflow con azione `applica` e la spunta sul backup. Da qui in poi
il percorso e' quello di ogni rilascio.

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
ricontrolla dati iniziali, RLS e chiavi esterne. Se passa li', passa in
produzione.

### 3. Applicarla

1. la migrazione e' su `main`;
2. Actions → **Migrazione del database di produzione** → `Run workflow`;
3. azione `verifica`: leggere cosa verrebbe applicato, e fermarsi se c'e' altro;
4. backup: Supabase → Database → Backups;
5. azione `applica` con la spunta sul backup;
6. approvare quando GitHub lo chiede;
7. leggere i controlli finali.

**L'ordine rispetto al deploy del codice conta.** Una migrazione additiva
(colonne o tabelle nuove) va applicata **prima** che il codice nuovo arrivi su
Vercel. Una migrazione che toglie qualcosa va applicata **dopo** che il codice
vecchio non e' piu' in produzione — altrimenti il codice ancora vivo legge una
colonna che non c'e' piu'. Quando entrambe servono, sono due migrazioni in due
momenti: `20260825160000_plan_prices_backfill_base` e
`20260825170000_drop_plan_price_columns` sono l'esempio, e nei loro commenti c'e'
scritto quale va prima e quale dopo.

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

**Se ha distrutto dei dati.** Il ripristino e' il backup di Supabase. E' il
motivo per cui il workflow chiede la spunta prima di applicare.

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
- il workflow di produzione esegue entrambi, prima e dopo.

Se dovessero mancare, le ricrea la coda di `owner-bootstrap.sql`.

## `0_init` non si tocca

Da quando un database e' stato messo in linea di base, Prisma confronta il
contenuto di ogni cartella con l'impronta registrata: modificare
`prisma/migrations/0_init/migration.sql` fa fallire ogni `migrate deploy`
successivo con "migration file has been modified".

Quindi: `owner-bootstrap.sql` si continua a rigenerare quando lo schema cambia
(le istruzioni sono nella sua intestazione), ma **la copia in `0_init` resta
ferma**. Il test che pretende che i due file siano identici va aggiornato
insieme: quando arrivera' quel momento, il modo giusto e' far si' che `0_init`
resti la fotografia del giorno della linea di base, e che tutto il resto sia una
migrazione.
