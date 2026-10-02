# Sicurezza delle dipendenze

Lo stato di `npm audit` per Kerdon, le eccezioni che la CI accetta e la prova
che le regge. Si aggiorna ogni volta che cambia `scripts/audit-exceptions.json`
o il risultato di `npm audit`.

Ultima verifica: **2026-10-02**, su `main` a `6abcef9`, con lo stesso
`package-lock.json`. Owner di tutte le eccezioni: **Stefano Ghisoni**.

## In una riga

In produzione ci sono **7 pacchetti high e 3 moderate**, tutti nella catena di
Remix 2 tranne uno (`morgan`). Gli high sono un solo advisory,
`GHSA-rxv8-25v2-qmq8` (turbo-stream), che colpisce solo con il single fetch
attivo: da noi e' spento, e il build lo conferma. Le eccezioni scadono il
**31/12/2026**; prima di quella data va fatta la migrazione a React Router 7
(`docs/migrazione-react-router-7.md`), che le chiude tutte.

## Come funziona il cancello

`npm run audit:gate` (job `audit` in `.github/workflows/ci.yml`) esegue
`scripts/audit-gate.mjs`, che blocca:

1. una **critical** ovunque, anche fra gli strumenti di build;
2. una **high** o **critical** nel grafo di produzione (`npm audit --omit=dev`);
3. un'eccezione **scaduta**;
4. un'eccezione **scritta male**: senza ID GHSA reali, senza `mitigazione`,
   senza `owner`, senza `scadenza` valida, o con il pacchetto ripetuto;
5. un advisory che raggiunge un pacchetto coperto **senza essere nominato**
   nella sua eccezione. Gli advisory si ricavano risalendo la catena `via` di
   `npm audit --json`: per `@remix-run/node` l'ID da nominare e' quello di
   turbo-stream. Cosi' un advisory nuovo nella stessa catena non passa sotto
   un'eccezione scritta per un altro.

Le moderate e le high confinate negli strumenti di sviluppo vengono stampate ma
non bloccano. Eccezioni e advisory che non servono piu' vengono segnalati, senza
bloccare. Le regole stanno in `scripts/audit-gate-regole.mjs`, provate da
`scripts/audit-gate.test.ts`.

## I numeri

| Grafo | Comando | Critical | High | Moderate | Low | Totale |
| --- | --- | --- | --- | --- | --- | --- |
| Produzione | `npm audit --omit=dev` | 0 | 7 | 3 | 0 | 10 |
| Completo | `npm audit` | 0 | 10 | 9 | 0 | 19 |

I conteggi sono per pacchetto, come li stampa npm: i sette high di produzione
sono un solo advisory contato su ogni pacchetto della catena.

## Produzione: high (coperte da eccezione)

| Pacchetto | Versione | Advisory | Perche' e' vulnerabile |
| --- | --- | --- | --- |
| `turbo-stream` | 2.4.1 | GHSA-rxv8-25v2-qmq8 | radice: DoS via input riflesso nel single fetch, corretto solo in 3.x |
| `@remix-run/server-runtime` | 2.17.5 | GHSA-rxv8-25v2-qmq8 | dipende da turbo-stream |
| `@remix-run/node` | 2.17.5 | GHSA-rxv8-25v2-qmq8 | via server-runtime |
| `@remix-run/react` | 2.17.5 | GHSA-rxv8-25v2-qmq8 (+ i tre moderate di react-router sotto) | via server-runtime, turbo-stream, react-router |
| `@remix-run/serve` | 2.17.5 | GHSA-rxv8-25v2-qmq8 | via express e node |
| `@remix-run/express` | 2.17.5 | GHSA-rxv8-25v2-qmq8 | via node |
| `@shopify/shopify-app-remix` | 4.2.1 | GHSA-rxv8-25v2-qmq8 | via server-runtime; anche la 6.0.1 dipende da `@remix-run/server-runtime ^2.17.5` |

Tutte scadono il **2026-12-31**. Nessuna ha una correzione nella linea Remix 2:
Remix 2.17.5 e react-router 6.30.4 sono le ultime versioni delle loro linee.

## Produzione: moderate (non bloccano)

| Pacchetto | Versione | Advisory | Stato |
| --- | --- | --- | --- |
| `react-router` | 6.30.4 | GHSA-wrjc-x8rr-h8h6 (open redirect con backslash in `<Link>`/`useNavigate`), GHSA-337j-9hxr-rhxg (constructor injection in `deserializeErrors`) | corretti in react-router >= 7.18.0: si chiudono con la migrazione. Nominati nell'eccezione di `@remix-run/react` |
| `react-router-dom` | 6.30.4 | GHSA-jjmj-jmhj-qwj2 (open redirect verso XSS) | come sopra |
| `morgan` | 1.12.0 | GHSA-9f6g-j8ch-79g4 (log injection) | **nuovo** rispetto all'ultima revisione. Arriva da `@remix-run/serve`, che in produzione non gira (vedi sotto). La correzione (1.12.1) e' disponibile e compatibile con `^1.10.1`: va presa con un aggiornamento del lockfile in una PR a parte, non qui (questa revisione non cambia dipendenze). **Owner:** Stefano Ghisoni. **Obiettivo:** 2026-11-02 |

## La prova di mitigazione

L'advisory `GHSA-rxv8-25v2-qmq8` dice testualmente che colpisce "Remix v2.9.0+
with Single Fetch enabled". La domanda e' quindi una sola: il single fetch e'
attivo? Verifica del 2026-10-01:

```text
$ grep -n "future\|v3_" vite.config.ts
(nessun risultato: nessun future flag dichiarato)

$ npm run build
...
build/server/assets/server-build-Q5wcpade.js  1,385.66 kB
✓ built in 1.68s

$ grep -o 'future *= *{[^}]*}' build/server/assets/server-build-*.js
future = { "v3_fetcherPersist": false, "v3_relativeSplatPath": false, "v3_throwAbortReason": false, "v3_routeConfig": false, "v3_singleFetch": false, "v3_lazyRouteDiscovery": false, "unstable_optimizeDeps": false }

$ grep -c turbo-stream build/server/assets/server-build-*.js
0
```

L'ultimo `0`, da solo, **non e' una prova**, e la versione precedente di questo
documento e delle eccezioni lo presentava come tale. Il bundle server non
contiene turbo-stream perche' le dipendenze restano esterne: il bundle importa
`@remix-run/node` e `@remix-run/react` da `node_modules`, e
`@remix-run/server-runtime/dist/single-fetch.js` fa `require('turbo-stream')`
all'avvio. Il modulo quindi **e' caricato** in produzione. Quello che non viene
eseguito e' il codice vulnerabile: in `@remix-run/server-runtime/dist/server.js`
ogni chiamata a `encodeViaTurboStream` (righe 144-160, 316, 383, 437) sta dietro
`_build.future.v3_singleFetch`, e le richieste `.data` vengono servite in single
fetch solo con quel flag. Con `v3_singleFetch: false` nel build, nessuna
risposta passa da turbo-stream.

Lato client turbo-stream e' nel bundle (`build/client/assets/components-*.js`,
dentro `@remix-run/react`), ma decodifica solo risposte single fetch, che il
server non produce.

Per i moderate di react-router: i redirect lato server (loader/action) vanno solo
ad admin.shopify.com (host fisso) o a percorsi relativi; `<Link>` e `navigate()`
lato client usano percorsi fissi, salvo `navigate('/products/issues?' + query)`
in `app/routes/products.issues.tsx` che costruisce solo la query. Nessun percorso
arriva da input esterno.
`deserializeErrors` richiede codice che lasci all'attaccante riscrivere gli
errori catturati in SSR; gli ErrorBoundary dell'app li leggono soltanto.

`@remix-run/serve` ed `@remix-run/express` non servono la produzione: su Vercel
l'handler lo costruisce il preset del framework `remix` (`vercel.json`). Restano
perche' `npm start` li usa in locale.

**Quando la prova smette di valere.** Se qualcuno attiva `v3_singleFetch` in
`vite.config.ts` (anche come passo della migrazione), il percorso vulnerabile
diventa raggiungibile e l'eccezione non e' piu' vera. Il piano di migrazione
tiene il flag fuori da qualunque deploy di produzione finche' Remix 2 e' ancora
installato.

## Solo sviluppo (non bloccano)

| Pacchetto | Gravita' | Advisory | Da dove arriva |
| --- | --- | --- | --- |
| `@remix-run/dev` | high | catena Remix 2 + esbuild/vite | strumento di build |
| `vite` 5.4.21 | high | GHSA-fx2h-pf6j-xcff (bypass di `server.fs.deny` su Windows), GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3 | copia annidata in `@vanilla-extract/integration` (via `@remix-run/dev`); il vite del progetto e' 6.4.3 e non e' segnalato |
| `brace-expansion` 2.1.4 | high | GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p (high), GHSA-q2hr-2g5m-vwhr (moderate) | correzione disponibile (2.1.7): aggiornamento del lockfile in una PR a parte. **Owner:** Stefano Ghisoni. **Obiettivo:** 2026-11-02 |
| `esbuild` 0.17/0.19/0.21 | moderate | GHSA-67mh-4wv8-2f99 (dev server leggibile da altri siti) | copie annidate in `@remix-run/dev` e `@vanilla-extract/integration`; l'esbuild del progetto e' 0.28.2 |
| `@vanilla-extract/integration`, `vite-node` 1.6.1 | moderate | via esbuild e vite | `@remix-run/dev` |
| `vitest` 3.2.7, `@vitest/mocker`, `@vitest/ui` | moderate | GHSA-82fw-gwwq-j7x9 (lettura di file arbitrari via mock) | correzione solo in vitest 4.1.11 (major) |

Gli high di sviluppo girano sulla macchina che costruisce, non in produzione. La
regola che conta qui e' tenere il dev server su `localhost`. La catena
`@remix-run/dev` sparisce con la migrazione (`@react-router/dev` porta vite e
esbuild del progetto).

## Cosa non si fa

- **Non si forza turbo-stream 3 con un override.** La 3 cambia il formato di
  codifica fra server e client e Remix 2 non la sa leggere: ogni navigazione
  si romperebbe. La correzione e' React Router 7, che porta il suo turbo-stream.
- **Non si aggiorna `@shopify/shopify-app-remix` per far tacere l'audit**: anche
  la 6.0.1 dipende da Remix 2.
- **Non si rinnova la scadenza senza un motivo nuovo.** Se al 31/12/2026 la
  migrazione non e' in produzione, il cancello diventa rosso: rinnovare richiede
  una mitigazione verificata di nuovo e una data nuova motivata in
  `audit-exceptions.json`, non un cambio di data e basta.

## Come si rifa' questa verifica

```bash
npm audit --json > /tmp/audit.json            # grafo completo
npm audit --json --omit=dev > /tmp/prod.json  # produzione
npm run audit:gate                             # il cancello
npm run build && grep -o 'v3_singleFetch[^,}]*' build/server/assets/server-build-*.js
```

Poi si aggiornano le tabelle qui sopra e la data in cima.

## Secret scanning e push protection

GitHub offre **secret scanning** (rilevamento di credenziali nei commit) e **push
protection** (blocco di push contenenti segreti). Dal 2025 per i repository
**privati** queste funzionalita' fanno parte di **GitHub Secret Protection**, un
prodotto venduto a parte (per utente attivo che fa commit), acquistabile su
piani **Team** ed Enterprise:

- non e' disponibile su repository privati di un account o piano Free;
- non serve piu' l'intera GitHub Advanced Security: Secret Protection si compra
  da sola, separata da Code Security.

Per repository **pubblici**, secret scanning e push protection sono gratuiti.

**Come abilitarle** (se il piano lo consente):

1. Andare su Settings → **Advanced Security**
2. Attivare **Secret Protection** (secret scanning sulle credenziali gia' nel
   repository)
3. Attivare **Push protection** (blocca push contenenti nuove credenziali)

Per il repository Kerdon (privato su piano Free), queste protezioni non sono
disponibili. La scansione avviene manualmente con `gitleaks` (vedi
`.gitleaks.toml`, che estende le regole di default e allowlista solo i file di
test con credenziali finte):

```
gitleaks git --redact -c .gitleaks.toml .
```

## Segnalare una vulnerabilita'

Scrivere a Stefano Ghisoni (owner del repository) invece di aprire una issue
pubblica.
