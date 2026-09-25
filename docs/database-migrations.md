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

> **`0_init` si puo' modificare solo PRIMA della linea di base di produzione, mai
> dopo.** Finche' la produzione non ha la riga di `0_init` in
> `_prisma_migrations`, `0_init` e `owner-bootstrap.sql` si aggiornano insieme
> (e' successo il 26 settembre 2026, per seminare il listino Basic/Growth/Scale/
> Core). Dal momento in cui si esegue `migrate resolve --applied 0_init` Prisma
> ne registra l'impronta: modificarlo dopo vuol dire un database di produzione
> che non corrisponde piu' alla storia scritta. Da li' in poi ogni cambiamento,
> anche ai dati iniziali, e' una migrazione nuova; `owner-bootstrap.sql` si
> aggiorna per descrivere lo stato finale e `0_init` resta com'era — a quel
> punto il test che li vuole identici va rivisto insieme.

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
- **`plans.max_orders`** (solo se la produzione e' nello stato di
  `pricing_alignment`): prima di `migrate deploy` e' atteso, perche' lo toglie
  la migrazione del 26. I controlli prima delle migrazioni girano in fase `pre`
  (`expected-drift.ts --fase=pre`, `bootstrap-check.sql -v fase=pre`), che
  accetta questo stato di partenza e anche i due listini di prima; quelli dopo
  girano in fase `post` e pretendono il listino finale e niente `max_orders`;
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

# Tutte le migrazioni tranne quelle che sul database owner non sono mai passate.
for cartella in prisma/migrations/*/; do
  nome=$(basename "$cartella")
  case "$nome" in
    20260904120000_row_level_security_everywhere) continue ;;
    20260904160000_supabase_managed_resources) continue ;;
    20260905120000_sync_request_queue) continue ;;
    20260905190000_sync_repairs) continue ;;
    20260922000000_pricing_alignment_guard) continue ;;
    20260926000000_plans_basic_growth_scale_core) continue ;;
  esac
  npx prisma migrate resolve --applied "$nome"
done
```

`migrate resolve --applied` **non esegue SQL**: scrive una riga in
`_prisma_migrations` e basta. Se il comando viene interrotto a meta' lo si
rilancia: le cartelle gia' dichiarate danno un errore innocuo e si va avanti.

Le esclusioni sono le migrazioni che passeranno davvero da questo percorso, ed
e' importante che restino fuori dal ciclo: dichiararle applicate senza
eseguirle vorrebbe dire perderle per sempre, perche' da quel momento
`migrate deploy` le salta.

`20260904120000_row_level_security_everywhere` e' la prima. Attiva RLS su ogni
tabella dello schema `public`: sul database owner alcune tabelle create dalle
migrazioni ne sono rimaste senza — fra le altre `meta_connections`, che porta il
token di accesso a Meta del negozio, e `product_feeds`, che porta il token con
cui si scarica un feed senza autenticarsi. Senza RLS quelle righe sono leggibili
da chiunque abbia la chiave pubblica del progetto.

`20260904160000_supabase_managed_resources` e' la seconda, e va dopo: aggiunge
`supabase_managed_resources` (il registro di quali tabelle, nel database di quale
merchant, le ha create l'app) e `supabase_data_deletions` (l'esito di ogni
tentativo di eliminarle). Nasce dallo scollegamento con eliminazione, che faceva
`DROP` su due nomi soli — presi dalla configurazione, quindi anche su tabelle che
erano del merchant — e cancellava comunque token e credenziali, pure quando il
`DROP` era fallito. Nasce gia' con RLS attiva, come tutte.

`20260905120000_sync_request_queue` e' la terza, e va per ultima: porta
`sync_requests` (la coda dei lavori) e `shop_locks` (il lucchetto per negozio).
La coda stava su Redis e nessuno ne prendeva possesso — due drenaggi
simultanei lavoravano lo stesso job, e su eccezione il job veniva rimosso, cosi'
un errore di rete perdeva la sincronizzazione per sempre. Il perche' per esteso
sta in `docs/architecture/queue-adr.md`; la procedura per accendere il
consumatore nuovo, in "Cambiare il consumatore della coda" piu' sotto. Nasce
gia' con RLS attiva, come tutte.

`20260905190000_sync_repairs` e' la quarta e va per ultima: porta la tabella
`sync_repairs` (le risorse che una corsa non e' riuscita a scrivere) e due
colonne su `sync_jobs`, `watermark_at` e `repairs_opened`.

Nasce da un guasto che non lasciava traccia. Nei processor una quantita' di
errori veniva registrata e ignorata, e la corsa si dichiarava `completed` lo
stesso; il confine incrementale della corsa successiva si calcolava dall'ultima
corsa completata, quindi passava sopra le risorse che nessuno era riuscito a
scrivere. Se su Shopify quelle risorse non venivano piu' toccate non tornavano
nel delta mai piu': il difetto diventava permanente e nessun registro sapeva
dire quale riga fosse rimasta indietro.

Va dopo `sync_request_queue` solo perche' e' piu' recente: non dipende da
quella. Nasce gia' con RLS attiva, come tutte.

Le ultime due esclusioni riguardano il listino.

`20260926000000_plans_basic_growth_scale_core` porta il listino a Basic/Growth/
Scale/Core, toglie `plans.max_orders` e riallinea negozi, addebiti e prezzi
riservati. Dichiararla applicata senza eseguirla lascerebbe la produzione sui
nomi di prima per sempre, con l'app che si aspetta quelli nuovi. Deve girare
davvero, e non importa da dove parte: arriva al listino finale sia da
Free/Pro/Business/Enterprise sia da Free/Core/Growth/Scale.

Per lo stesso motivo **`20260923000000_pricing_alignment` si puo' dichiarare
applicata** anche se in produzione non e' mai passata: la migrazione del 26
va dallo stato di prima direttamente a quello finale, senza bisogno del passo
intermedio.

`20260922000000_pricing_alignment_guard` resta fuori perche' e' comunque
innocua: sul listino di produzione non fa niente (crea una riga provvisoria
solo su un database nuovo, dove il listino e' gia' quello finale e ne' la
migrazione del 23 ne' quella del 26 risultano passate). Lasciarla girare
costa zero; dichiararla applicata non servirebbe a niente.

Se la migrazione del 26 e' stata incollata a mano nell'editor di Supabase, va
comunque lasciata fuori dal ciclo: rieseguita, non cambia niente.

### 4. Controllare che la linea di base sia giusta

```bash
npx prisma migrate status
```

Deve elencare **sei** migrazioni da applicare, in questo ordine:

1. `20260904120000_row_level_security_everywhere`
2. `20260904160000_supabase_managed_resources`
3. `20260905120000_sync_request_queue`
4. `20260905190000_sync_repairs`
5. `20260922000000_pricing_alignment_guard`
6. `20260926000000_plans_basic_growth_scale_core`

Se ne elenca altre, qualcosa non e' stato dichiarato: rifare il passo 3 prima di
andare avanti.

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
