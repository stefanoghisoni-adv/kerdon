# Da Remix 2 a React Router 7: il piano

Questo documento e' **solo il piano**. Non si esegue qui: la migrazione e' un
progetto a parte, con il suo branch e le sue PR. Serve a chi la fara' per sapere
in che ordine muoversi, dove si rompe e quando si puo' dire finita.

Owner: **Stefano Ghisoni**. Scadenza dura: **31/12/2026**, il giorno in cui
scadono le sette eccezioni di `scripts/audit-exceptions.json` e
`npm run audit:gate` diventa rosso. Stato verificato il 2026-10-01 su `main`
a `63b1f63`.

## In una riga

Si passa a React Router **7.x (>= 7.18.0)** con
`@shopify/shopify-app-react-router` **1.x**, in un solo rilascio, senza mai
mandare in produzione Remix 2 con il single fetch acceso.

## Perche'

Tutti gli high di produzione di `npm audit` sono un solo advisory,
`GHSA-rxv8-25v2-qmq8` (turbo-stream < 3), contato su sette pacchetti della
catena Remix 2. Remix 2.17.5 e react-router 6.30.4 sono le ultime versioni delle
loro linee: una correzione dentro Remix 2 non arrivera'. Oggi il percorso
vulnerabile e' spento (single fetch non attivo, prova in `SECURITY.md`), ma
l'eccezione e' temporanea per scelta. Con React Router 7 si chiudono anche i
tre moderate di react-router (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg,
GHSA-jjmj-jmhj-qwj2, corretti in 7.18.0) e sparisce la catena di sviluppo di
`@remix-run/dev` (vite 5 ed esbuild vecchi annidati in `@vanilla-extract`).

## Le versioni di arrivo

| Oggi | Dopo | Note |
| --- | --- | --- |
| `@remix-run/react` 2.17.5 | `react-router` ^7.18.4 | 7.18.0 e' il minimo per i moderate; 7.14.0 per turbo-stream |
| `@remix-run/node` 2.17.5 | `@react-router/node` ^7.18.4 | gran parte degli import passa a `react-router` |
| `@remix-run/serve` 2.17.5 | `@react-router/serve` ^7.18.4 | solo per `npm start` in locale |
| `@remix-run/dev` 2.17.5 | `@react-router/dev` ^7.18.4 + `@react-router/fs-routes` | vite 6.4.3 resta (peer `^5 \|\| ^6 \|\| ^7 \|\| ^8`) |
| `@shopify/shopify-app-remix` 4.2.1 | `@shopify/shopify-app-react-router` ^1.2.1 | la 1.x usa `@shopify/shopify-api` ^13.1 e `shopify-app-session-storage` ^5, come oggi |
| `@shopify/shopify-app-session-storage-prisma` 9.0.1 | invariato | la 9 vuole `shopify-api` ^13: compatibile con la 1.x |
| React 18.3.1 | invariato | React Router 7 accetta React >= 18; Polaris 13 vuole React 18 |

**Perche' non React Router 8.** Esiste (8.4.0), ma vuole React >= 19.2.7, e
`@shopify/shopify-app-react-router` dichiara `react-router ^7.6.2` in tutte le
versioni, 3.0.1 compresa. React 19 e Polaris sono un altro progetto.

**Perche' la 1.x di `shopify-app-react-router` e non la 3.x.** La 3.x porta
`@shopify/shopify-api` 15 e `shopify-app-session-storage` 7, quindi anche
`shopify-app-session-storage-prisma` 11: tre major di Shopify insieme al cambio
di framework. La 1.x cambia solo il framework. Il passaggio alla 3.x si fa dopo,
a parte, quando la 1.x e' in produzione e stabile.

## Cosa c'e' da toccare (inventario del 2026-10-01)

- 107 file in `app/routes`, ~99 file che importano da `@remix-run/*` o
  `@shopify/shopify-app-remix` (128 import da `@remix-run/node`, 27 da
  `@remix-run/react`, 3 dal pacchetto Shopify).
- `json()` di Remix: importato in 50 file, 276 chiamate. In React Router 7
  `json` non esiste piu'.
- 82 `loader`/`action` tipizzati con `LoaderFunctionArgs`/`ActionFunctionArgs`,
  67 `useFetcher`, 22 `useLoaderData`, 2 `useRouteError`.
- `app/entry.server.tsx` (`RemixServer`, `remixContext`), `app/entry.client.tsx`
  (`RemixBrowser`), `app/root.tsx`, `app/shopify.server.ts`
  (`@shopify/shopify-app-remix/adapters/node`, `unstable_newEmbeddedAuthStrategy`).
- `vite.config.ts`, `vercel.json` (`"framework": "remix"`), `package.json`
  (script `build`, `start`, `typecheck`), `tsconfig.json`
  (`types: ["@remix-run/node", ...]`), `.gitignore`.
- `e2e/server/main.ts`: carica i moduli di rotta con `vite.ssrLoadModule` e si
  aspetta che `loader`/`action` restituiscano una `Response`.
- ~24 file di test che leggono `await risposta.json()` dal risultato di un
  loader o di un'action.
- `worker.ts` e `build-worker.mjs` non importano Remix: non si toccano.

## I passi

Ogni passo e' una PR con CI verde (vitest, typecheck, build, e2e, audit gate)
prima di unire. I passi 1 e 2 possono andare in produzione da soli; dal passo 3
al 7 e' un unico rilascio.

### 1. Le future flag innocue, su Remix 2 (deployabile)

In `vite.config.ts`, una alla volta, con i test a ogni flag:
`v3_fetcherPersist`, `v3_relativeSplatPath`, `v3_throwAbortReason`,
`v3_lazyRouteDiscovery`, `v3_routeConfig` (quest'ultima richiede
`app/routes.ts` con `flatRoutes()` di `@remix-run/fs-routes` e
`ignoredRouteFiles` spostato li'). Nessuna di queste tocca turbo-stream.

**`v3_singleFetch` NO.** La guida ufficiale la mette fra le flag da accendere
prima del salto, ma accenderla su Remix 2 rende raggiungibile proprio
`GHSA-rxv8-25v2-qmq8` e fa decadere la mitigazione su cui reggono le eccezioni.
Il single fetch arriva insieme a React Router 7, che lo ha sempre attivo con il
suo turbo-stream corretto. Se serve provarlo prima, solo su un branch di prova
mai distribuito in produzione.

### 2. Togliere `json()` dove non serve (deployabile)

Le **resource route** (`api.*`, `rest.v1.*`, `feed.$file`, `billing.*`,
`privacy.export.$id`, `[robots.txt]`, webhook) passano da `json(x, init)` a
`Response.json(x, init)`: e' lo standard web, funziona gia' su Remix 2, e in
React Router 7 una resource route che restituisce una `Response` la consegna
cosi' com'e'. I test che leggono `.json()` e l'harness e2e restano validi.

Le route con UI (`_index`, `customers`, `products.issues`, `plan`, `logs`,
`settings.supabase`, `spedizioni`, `catalogs.*`, `privacy.my-data`) restano su
`json()` fino al passo 4: e' li' che il cambio di formato si vede.

### 3. Il salto dei pacchetti (inizio del rilascio unico)

- Codemod ufficiale `npx codemod remix/2/react-router/upgrade`, poi revisione a
  mano del diff (il codemod non conosce i pacchetti Shopify).
- `package.json`: via i quattro `@remix-run/*` e `@shopify/shopify-app-remix`,
  dentro le versioni della tabella. Script: `build` →
  `prisma generate && react-router build`, `start` →
  `react-router-serve ./build/server/index.js`, `typecheck` →
  `react-router typegen && tsc`.
- `vite.config.ts`: `reactRouter()` da `@react-router/dev/vite` al posto di
  `remix()`; l'alias `~` resta. Nuovo `react-router.config.ts` con
  `ssr: true`.
- `app/routes.ts` con `flatRoutes({ ignoredRouteFiles: ["**/*.css", "**/*.test.{ts,tsx}"] })`.
- `entry.server.tsx`: `ServerRouter` e `routerContext`; `entry.client.tsx`:
  `HydratedRouter`. La gestione di `vite:preloadError` in `entry.client.tsx`
  resta com'e'.
- `tsconfig.json`: `types` senza `@remix-run/node`, `rootDirs` per i tipi
  generati in `.react-router/`; `.react-router/` in `.gitignore`.

### 4. Single fetch e formato dei dati

- Le route con UI restituiscono oggetti semplici, o `data(x, { status, headers })`
  quando servono stato o header.
- `useLoaderData<typeof loader>()` e `fetcher.data` cambiano tipo: con
  turbo-stream `Date`, `Map`, `Set`, `BigInt` arrivano al client come tali, non
  come stringhe JSON. Va cercato ogni punto che faceva `new Date(stringa)` o
  confronti su stringhe ISO.
- `headers()` delle route: in single fetch gli header dei loader si combinano
  diversamente; vanno verificati quelli di Shopify (`boundary.headers`) e gli
  header di cache.
- I 67 `useFetcher`: per ognuno, la route che chiama e' una resource route
  (passo 2: `Response` passa intatta) o una route con UI (formato turbo-stream)?
  Va verificato con un test, non dedotto.

### 5. Shopify

- `app/shopify.server.ts`: import da `@shopify/shopify-app-react-router/server`
  e adapter `@shopify/shopify-app-react-router/adapters/node`. Verificare se
  `unstable_newEmbeddedAuthStrategy` esiste ancora o e' diventato il default, e
  che il log con le gravita' (`SEVERITA`) riceva gli stessi numeri.
- `AppProvider` da `@shopify/shopify-app-react-router/react`;
  `boundary.error`/`boundary.headers` in `root.tsx` e nelle route embedded.
- `authenticate.admin`, `authenticate.webhook`, billing: stessa API sulla
  carta, da provare davvero (passo 7).

### 6. Test ed e2e

- I test unitari che leggono `.json()` da route con UI si adattano al nuovo
  valore restituito (oggetto o `data()`), non il contrario.
- `e2e/server/main.ts`: `rispondi()` deve accettare, oltre a una `Response`,
  un oggetto semplice e il risultato di `data()`; il commento "Un loader che
  lancia una Response..." resta vero.
- `vitest.config.ts` non cambia; `build:verified` deve restare il cancello di
  Vercel.

### 7. Vercel e prova sul negozio di sviluppo

- `vercel.json`: `"framework": "react-router"`. **Niente `vercelPreset()`** in
  questa migrazione: oggi l'app e' una funzione sola senza preset (vedi il
  commento in `app/routes/spedizioni.tsx` su `maxDuration`), e il preset
  spezzerebbe l'app in funzioni per rotta, cambiando tetti, avvio a freddo e
  limiti. Si valuta dopo, a parte.
- Deploy di anteprima, poi sul negozio di sviluppo: installazione OAuth,
  caricamento embedded, una sincronizzazione, un webhook prodotti e uno ordini, i
  webhook GDPR, `/api/cron/sync`, billing (`billing.subscribe` e
  `billing.callback`), `rest.v1.*` con la chiave di ingest, il feed dei
  cataloghi.
- Produzione, poi 48 ore di log senza errori nuovi.

### 8. Chiusura

- Togliere le sette eccezioni da `scripts/audit-exceptions.json`: il cancello
  deve passare senza.
- Aggiornare `SECURITY.md`.

## I rischi

| Rischio | Dove | Cosa si fa |
| --- | --- | --- |
| Accendere `v3_singleFetch` su Remix 2 riapre l'advisory | passo 1 | flag esclusa dai deploy; arriva solo con React Router 7 |
| `@shopify/shopify-app-react-router` diverso da `-remix` in punti non documentati (auth embedded, `boundary`, log) | passo 5 | versione 1.x per non cambiare anche `shopify-api`; prova completa sul negozio di sviluppo |
| La 3.x di Shopify trascina tre major (`shopify-api` 15, session storage 7, prisma storage 11) | dopo la migrazione | progetto separato, non dentro questo |
| Preset Vercel: con `vercelPreset()` l'app diventa piu' funzioni con tetti diversi; senza, va verificato che `framework: react-router` impacchetti come oggi | passo 7 | niente preset; verificare in anteprima dimensione della funzione, cron e regione `cdg1` |
| Adapter: `@react-router/node` al posto di `@remix-run/node`, `adapters/node` di Shopify (crypto web, `fetch`) | passi 3, 5 | i test del webhook e dell'OAuth girano contro l'adapter vero |
| `fetcher.data` cambia forma per le route con UI; 67 `useFetcher` | passo 4 | resource route su `Response.json` al passo 2; test per ogni fetcher verso una route con UI |
| `Date` e tipi ricchi arrivano al client come oggetti, non stringhe | passo 4 | ricerca dei punti che parsano date ISO; typegen li fa emergere in `tsc` |
| L'harness e2e conosce solo `Response` | passo 6 | `rispondi()` esteso, prima di toccare le route |
| Test unitari che leggono `.json()` (~24 file) | passi 2, 6 | il passo 2 ne salva la maggior parte |
| Tempo: il cancello diventa rosso il 31/12 | tutto | inizio entro il 2/11; produzione entro il 4/12; rinnovo dell'eccezione solo con una prova nuova |

## La stima

| Passo | Giorni |
| --- | --- |
| 1. Future flag innocue | 0,5 |
| 2. `Response.json` nelle resource route | 1 |
| 3. Salto dei pacchetti | 1 |
| 4. Single fetch e formato dei dati | 1,5 |
| 5. Shopify | 1 |
| 6. Test ed e2e | 1,5 |
| 7. Vercel, anteprima, negozio di sviluppo, produzione | 1,5 |
| 8. Chiusura | 0,5 |
| **Totale** | **8,5 giorni di lavoro**, con margine fino a 12 |

Calendario: inizio entro il **2/11/2026**, rilascio in produzione entro il
**4/12/2026**. Le quattro settimane prima della scadenza sono il margine, non
il piano.

## Quando e' fatto

La migrazione e' finita quando tutte queste cose sono vere insieme:

1. `package.json` e `package-lock.json` non contengono `@remix-run/*` ne'
   `@shopify/shopify-app-remix`.
2. `npm ls turbo-stream` non mostra nessuna versione < 3.0.0, e `react-router`
   e' >= 7.18.0.
3. `npm audit --omit=dev` non riporta high ne' critical, e nessuno dei quattro
   advisory GHSA-rxv8-25v2-qmq8, GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg,
   GHSA-jjmj-jmhj-qwj2.
4. Le sette eccezioni sono tolte da `scripts/audit-exceptions.json` e
   `npm run audit:gate` passa.
5. In CI sono verdi vitest, typecheck, `build:verified`, e2e e audit gate.
6. Sul negozio di sviluppo funzionano installazione, app embedded, una
   sincronizzazione, webhook (compresi GDPR), cron, billing, `rest.v1.*` e feed.
7. La produzione gira da 48 ore senza errori nuovi nei log.
8. `SECURITY.md` riporta i numeri nuovi.
