// e2e/server/main.ts
//
// Il server delle prove end-to-end. Lo avvia Playwright, non una persona.
//
// COSA E', IN UNA RIGA: le rotte VERE dell'app, davanti a un Postgres VERO, con
// finti solo dove dall'altra parte ci sarebbe un servizio di qualcun altro.
//
// LE TRE REGOLE CHE QUESTO FILE ESISTE PER TENERE.
//
//  1. NESSUNA CREDENZIALE VERA E NESSUNA CHIAMATA FUORI. Le variabili
//     d'ambiente stanno in `e2e/ambiente.ts`, a valori palesemente finti, e si
//     scrivono PRIMA di caricare qualunque modulo dell'app: `.env` non viene
//     letto, e non c'e' nessun indirizzo di produzione che possa entrare per
//     sbaglio da una variabile ereditata dalla shell di chi lancia le prove.
//
//  2. SI FINGE IL MENO POSSIBILE. Shopify e l'eliminazione dei dati dal
//     database del merchant, e basta. Le rotte, il database, la verifica delle
//     firme, le transazioni e gli indici unici sono quelli veri: e' li' che
//     stanno le regole che queste prove devono verificare, e un finto
//     risponderebbe cio' che gli e' stato insegnato a rispondere.
//
//  3. OGNI PROVA PARTE DA UN DATABASE PULITO. L'azzeramento e' un comando
//     esplicito (`/__test/reset`), non un effetto collaterale dell'avvio: le
//     prove girano in parallelo contro lo stesso server, e una che azzerasse
//     per conto suo cancellerebbe i dati di un'altra a meta' corsa. Chi azzera
//     lo dichiara, e il file che lo fa gira in serie.

import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

const RADICE = path.resolve(import.meta.dirname, '../..');

// PRIMA DI TUTTO IL RESTO. Ogni variabile che l'app legge viene dichiarata in
// `e2e/ambiente.ts`, con un valore finto ma della forma giusta, e scritta qui
// prima di caricare qualunque modulo dell'app: `.env` non viene letto, e non
// c'e' nessun indirizzo di produzione che possa entrare da una variabile
// ereditata dalla shell di chi lancia le prove.
const { applicaAmbienteDiProva, PORTA, PORTA_DB } = await import('../ambiente');
applicaAmbienteDiProva();

const { startDatabase, resetDatabase, stopDatabase } = await import('./database');
const { installShiftableClock, advanceBy, resetClock, currentShift } = await import('./clock');
const { resetFinti, stato } = await import('./fakes/state');

process.env.DATABASE_URL = await startDatabase(PORTA_DB);
installShiftableClock();

/**
 * Le rotte dell'app che le prove attraversano, con l'export che le serve.
 *
 * E' un elenco scritto a mano e non il router di Remix, di proposito: montare
 * Remix intero vorrebbe dire portarsi dentro il rendering delle pagine
 * embedded, che senza App Bridge non si apre. Qui serve un'altra cosa — che il
 * `loader` e l'`action` VERI vedano una richiesta HTTP vera e rispondano una
 * Response vera — e per quello basta chiamarli.
 */
const ROTTE: { pattern: RegExp; modulo: string; tipo: 'loader' | 'action'; parametri?: string[] }[] = [
  { pattern: /^\/billing\/callback$/, modulo: '/app/routes/billing.callback.tsx', tipo: 'loader' },
  { pattern: /^\/api\/supabase\/disconnect$/, modulo: '/app/routes/api.supabase.disconnect.tsx', tipo: 'action' },
  { pattern: /^\/api\/plan\/limits$/, modulo: '/app/routes/api.plan.limits.tsx', tipo: 'loader' },
  { pattern: /^\/webhooks\/orders$/, modulo: '/app/routes/webhooks.orders.tsx', tipo: 'action' },
  { pattern: /^\/webhooks\/app\/uninstalled$/, modulo: '/app/routes/webhooks.app.uninstalled.tsx', tipo: 'action' },
  { pattern: /^\/tracking\/bridge\.js$/, modulo: '/app/routes/tracking.bridge[.]js.tsx', tipo: 'loader' },
  {
    pattern: /^\/privacy\/export\/([^/]+)$/,
    modulo: '/app/routes/privacy.export.$id.tsx',
    tipo: 'loader',
    parametri: ['id'],
  },
];

const vite: ViteDevServer = await createViteServer({
  root: RADICE,
  // Niente vite.config.ts: quello monta il plugin di Remix, che tratta i file
  // sotto app/routes come moduli di rotta e ne riscrive gli export. Qui le
  // rotte si caricano come moduli normali, e l'unica configurazione che conta
  // e' quella scritta qui sotto.
  configFile: false,
  appType: 'custom',
  server: { middlewareMode: true, host: '127.0.0.1' },
  // L'ordine conta: la voce piu' specifica va prima, altrimenti `~` cattura
  // tutto e i finti non vengono mai montati.
  resolve: {
    alias: [
      { find: '~/shopify.server', replacement: path.join(RADICE, 'e2e/server/fakes/shopify.server.ts') },
      {
        find: '~/lib/supabase/delete-merchant-data.server',
        replacement: path.join(RADICE, 'e2e/server/fakes/delete-merchant-data.server.ts'),
      },
      { find: '~', replacement: path.join(RADICE, 'app') },
    ],
  },
});

/** Una Request del web a partire da una richiesta di Node. */
async function richiestaWeb(req: http.IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORTA}`);
  const intestazioni = new Headers();
  for (const [nome, valore] of Object.entries(req.headers)) {
    if (typeof valore === 'string') intestazioni.set(nome, valore);
    else if (Array.isArray(valore)) for (const v of valore) intestazioni.append(nome, v);
  }

  let corpo: Uint8Array | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const pezzi: Buffer[] = [];
    for await (const pezzo of req) pezzi.push(pezzo as Buffer);
    corpo = new Uint8Array(Buffer.concat(pezzi));
  }

  // I byte grezzi, non una stringa: la firma degli webhook si verifica sul
  // corpo COM'E' ARRIVATO, e un giro attraverso una stringa lo cambierebbe nel
  // caso peggiore — quello in cui il corpo non e' UTF-8 valido — facendo
  // risultare falsa una consegna vera.
  //
  // Il cast c'e' perche' il `BodyInit` dichiarato dalle librerie di questo
  // repository e' piu' stretto di quello che Node accetta davvero: un
  // `Uint8Array` a runtime va benissimo, nel tipo no.
  return new Request(url, {
    method: req.method,
    headers: intestazioni,
    body: corpo as unknown as BodyInit,
  });
}

async function rispondi(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((valore, nome) => res.setHeader(nome, valore));
  const corpo = Buffer.from(await response.arrayBuffer());
  res.end(corpo);
}

/**
 * Il testo, reso innocuo dentro dell'HTML.
 *
 * Prima qui i caratteri speciali si CANCELLAVANO invece di sfuggirli, e la
 * differenza non e' teorica: la destinazione e' un indirizzo pieno di `&`, e
 * toglierli faceva leggere alla prova `billing=okfirst=1` — cioe' un valore che
 * nessuno aveva mai scritto.
 */
function sfuggi(testo: string): string {
  return testo
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(res: http.ServerResponse, dati: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // I BigInt non passano da JSON, e nello schema ce ne sono — l'id
  // dell'addebito, per esempio. Senza questo la prova riceverebbe un 500 al
  // posto della riga che voleva guardare.
  res.end(JSON.stringify(dati, (_chiave, valore) => (typeof valore === 'bigint' ? String(valore) : valore)));
}

/** Il client Prisma vero, caricato dentro il grafo di Vite come lo caricano le rotte. */
async function prismaVero() {
  const modulo = (await vite.ssrLoadModule('/app/db.server.ts')) as {
    prisma: Record<string, Record<string, (args?: unknown) => Promise<unknown>>>;
  };
  return modulo.prisma;
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORTA}`);

    try {
      // ---- Il pannello di comando delle prove ----------------------------
      if (url.pathname.startsWith('/__test/')) {
        // Un POST senza corpo e' normale qui: `/__test/reset` non ha niente da
        // dire. Senza il ripiego, il parse falliva e l'azzeramento rispondeva
        // un errore pur avendo da fare la cosa piu' semplice di tutte.
        const corpo =
          req.method === 'POST'
            ? (((await (await richiestaWeb(req)).json().catch(() => ({}))) ?? {}) as Record<
                string,
                unknown
              >)
            : {};

        switch (url.pathname) {
          case '/__test/reset': {
            await resetDatabase();
            resetClock();
            resetFinti();
            // I moduli dell'app tengono delle cache in memoria — il listino
            // delle valute, per dirne una. Fra due prove vanno buttate, o la
            // seconda erediterebbe cio' che ha scaldato la prima. `db.server`
            // sopravvive perche' tiene il client su `globalThis`: senza, ogni
            // azzeramento aprirebbe una connessione nuova e non ne chiuderebbe
            // nessuna.
            vite.moduleGraph.invalidateAll();
            return json(res, { ok: true });
          }

          case '/__test/clock': {
            advanceBy(Number(corpo.advanceMs ?? 0));
            return json(res, { ok: true, shiftMs: currentShift() });
          }

          case '/__test/fakes': {
            const s = stato();
            if (req.method === 'POST') {
              if (Array.isArray(corpo.graphql)) s.graphql = corpo.graphql as typeof s.graphql;
              if (Array.isArray(corpo.sessioni)) s.sessioni = corpo.sessioni as string[];
              if (corpo.eliminazione) s.eliminazione = corpo.eliminazione as typeof s.eliminazione;
              return json(res, { ok: true });
            }
            return json(res, {
              graphqlLog: s.graphqlLog,
              eliminazioniChieste: s.eliminazioniChieste,
            });
          }

          // Una scrittura o una lettura sul database, fatta con il client
          // Prisma vero: cosi' le prove seminano con gli stessi valori di
          // default, gli stessi nomi di colonna e gli stessi vincoli che usa
          // l'app, invece che con dell'SQL scritto a parte che prima o poi
          // diverge dallo schema.
          case '/__test/db': {
            const prisma = await prismaVero();
            const modello = String(corpo.model);
            const operazione = String(corpo.op);
            const delegato = prisma[modello];
            if (!delegato || typeof delegato[operazione] !== 'function') {
              return json(res, { error: `modello/operazione sconosciuti: ${modello}.${operazione}` }, 400);
            }
            return json(res, { data: await delegato[operazione](corpo.args) });
          }

          // Due lavorazioni che chiedono insieme il lucchetto dello stesso
          // negozio. Chiama il modulo VERO: quello che decide chi passa e'
          // l'INSERT ... ON CONFLICT su Postgres, non questa riga.
          case '/__test/lock-race': {
            const modulo = (await vite.ssrLoadModule('/app/lib/queue/shop-lock.server.ts')) as {
              runWithShopLease: (
                shopId: string,
                run: () => Promise<void>,
                opts?: Record<string, unknown>,
              ) => Promise<string>;
            };
            const shopId = String(corpo.shopId);
            const durataMs = Number(corpo.holdMs ?? 300);
            const lavoro = () =>
              modulo.runWithShopLease(shopId, async () => {
                await new Promise((r) => setTimeout(r, durataMs));
              });
            const esiti = await Promise.all([lavoro(), lavoro()]);
            return json(res, { esiti });
          }

          // L'admin di Shopify, al suo posto.
          //
          // Serve a una prova sola, ma e' la prova che sta in piedi solo qui:
          // il ritorno dall'approvazione di un addebito e' un rimando di PRIMO
          // LIVELLO, fuori dall'iframe, e l'unico modo di sapere che quel giro
          // arriva davvero e' farlo fare a un browser. L'indirizzo vero e'
          // `https://admin.shopify.com/...`, e non lo si chiama: la prova
          // riscrive il rimando qui sopra, portandosi dietro la destinazione
          // che l'app aveva scritto. Questa pagina la mostra, cosi' si puo'
          // verificare che sia quella giusta.
          case '/__test/admin-finto': {
            const destinazione = url.searchParams.get('destinazione') ?? '';
            const params = destinazione ? [...new URL(destinazione).searchParams.entries()] : [];
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end(
              `<!doctype html><meta charset="utf-8"><title>admin finto</title>` +
                `<p data-testid="admin-finto">riquadro dell'app dentro l'admin</p>` +
                `<code data-testid="admin-finto-destinazione">${sfuggi(destinazione)}</code>` +
                `<ul>${params
                  .map(([nome, valore]) => `<li data-param="${nome}">${valore}</li>`)
                  .join('')}</ul>`,
            );
          }

          default:
            return json(res, { error: 'comando sconosciuto' }, 404);
        }
      }

      // ---- Le pagine del banco di prova ----------------------------------
      if (url.pathname === '/' || url.pathname.endsWith('.html')) {
        const nome = url.pathname === '/' ? '/e2e/harness/index.html' : url.pathname;
        const file = path.join(RADICE, nome);
        const html = await vite.transformIndexHtml(url.pathname, readFileSync(file, 'utf8'));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(html);
      }

      // ---- Le rotte vere dell'app ----------------------------------------
      for (const rotta of ROTTE) {
        const trovato = rotta.pattern.exec(url.pathname);
        if (!trovato) continue;

        const params: Record<string, string> = {};
        rotta.parametri?.forEach((nome, i) => (params[nome] = decodeURIComponent(trovato[i + 1])));

        const modulo = (await vite.ssrLoadModule(rotta.modulo)) as Record<
          string,
          (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<Response>
        >;
        const funzione = modulo[rotta.tipo];
        if (!funzione) return json(res, { error: `${rotta.modulo} non esporta ${rotta.tipo}` }, 500);

        try {
          const risposta = await funzione({ request: await richiestaWeb(req), params, context: {} });
          return await rispondi(res, risposta);
        } catch (errore) {
          // Un loader che lancia una Response non ha fallito: e' il modo in cui
          // Remix dice 404 o 401. Trattarlo come un guasto nasconderebbe proprio
          // le prove sull'autorizzazione, che su quel lancio si reggono.
          if (errore instanceof Response) return await rispondi(res, errore);
          throw errore;
        }
      }

      // ---- Tutto il resto: i moduli e gli asset del banco ------------------
      vite.middlewares(req, res);
    } catch (errore) {
      console.error('[e2e-server]', errore);
      json(res, { error: errore instanceof Error ? errore.message : String(errore) }, 500);
    }
  })();
});

server.listen(PORTA, '127.0.0.1', () => {
  console.log(`[e2e-server] in ascolto su http://127.0.0.1:${PORTA}`);
});

for (const segnale of ['SIGINT', 'SIGTERM'] as const) {
  process.on(segnale, () => {
    void (async () => {
      server.close();
      await vite.close();
      await stopDatabase();
      process.exit(0);
    })();
  });
}
