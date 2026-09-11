// e2e/server/database.ts
//
// Un Postgres vero, dentro il processo di prova.
//
// LA SCELTA, E PERCHE' NON UN FINTO. Le regole che queste prove devono
// verificare sono quasi tutte regole del DATABASE: l'indice unico che rende una
// consegna ripetuta una riga sola, l'`updateMany` condizionato che fa passare
// una callback su due, l'`INSERT ... ON CONFLICT ... WHERE scaduto` che
// consegna il lucchetto del negozio a uno solo di due lavoratori, la
// transazione che o scrive tutto o non scrive niente. Un finto in memoria
// risponderebbe quello che gli avessi insegnato a rispondere: proverebbe il
// finto, non il vincolo.
//
// PGlite e' Postgres compilato in WebAssembly e messo davanti al protocollo di
// rete da `pg-gateway`: Prisma si collega come a un Postgres qualunque, le
// migrazioni sono LE migrazioni del repository, e i vincoli sono quelli veri.
// Non serve ne' Docker ne' un servizio avviato a parte — conta, perche' una
// prova che pretende un'infrastruttura installata a mano e' una prova che non
// gira mai.
//
// TUTTO IN MEMORIA, E QUINDI USA E GETTA: il database nasce all'avvio del
// server di prova e muore con lui. Non c'e' nessun indirizzo di produzione da
// sbagliare e nessun dato vero da toccare.

import { PGlite } from '@electric-sql/pglite';
import { fromNodeSocket } from 'pg-gateway/node';
import net from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const RADICE = path.resolve(import.meta.dirname, '../..');
const MIGRAZIONI = path.join(RADICE, 'prisma/migrations');

let db: PGlite;
let server: net.Server;

/**
 * Le tabelle che l'azzeramento NON svuota.
 *
 * Si ricavano guardando cosa e' rimasto pieno subito dopo le migrazioni, invece
 * di scriverne l'elenco a mano: i piani e il loro listino arrivano da una
 * migrazione, e un elenco scritto a mano resterebbe indietro alla prima riga
 * iniziale aggiunta — in silenzio, e con l'effetto di cancellare fra due prove
 * dei dati che l'app da' per scontati.
 */
let daTenere: string[] = [];
let tutteLeTabelle: string[] = [];

/** Le tabelle dello schema pubblico, escluso il registro delle migrazioni. */
async function elencaTabelle(): Promise<string[]> {
  const esito = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  return esito.rows.map((r) => r.tablename).sort();
}

/**
 * Avvia il database e lo porta allo schema dichiarato.
 *
 * Le migrazioni si applicano in ordine di nome, che e' l'ordine in cui Prisma
 * le ha scritte e quindi l'unico in cui si tengono in piedi.
 */
export async function startDatabase(port: number): Promise<string> {
  db = new PGlite();
  await db.waitReady;

  for (const cartella of readdirSync(MIGRAZIONI, { withFileTypes: true })
    .filter((v) => v.isDirectory())
    .map((v) => v.name)
    .sort()) {
    const file = path.join(MIGRAZIONI, cartella, 'migration.sql');
    try {
      await db.exec(readFileSync(file, 'utf8'));
    } catch (errore) {
      // Il nome della migrazione e' meta' della diagnosi: senza, il messaggio
      // di Postgres parla di una tabella e non si sa da quale file arrivi.
      throw new Error(
        `migrazione ${cartella} non applicata: ${errore instanceof Error ? errore.message : String(errore)}`,
      );
    }
  }

  tutteLeTabelle = await elencaTabelle();
  daTenere = [];
  for (const tabella of tutteLeTabelle) {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tabella}"`);
    if ((rows[0]?.n ?? 0) > 0) daTenere.push(tabella);
  }

  server = net.createServer((socket) => {
    void fromNodeSocket(socket, {
      serverVersion: '18.0',
      // Nessuna password da sbagliare e nessuna da tenere in giro: il socket
      // ascolta solo su 127.0.0.1 e il database dura quanto il processo.
      auth: { method: 'trust' },
      async onStartup() {
        await db.waitReady;
      },
      async onMessage(data, { isAuthenticated }) {
        if (!isAuthenticated) return;
        return sistemaLaRispostaDopoUnErrore(data, await db.execProtocolRaw(data));
      },
    });
  });

  await new Promise<void>((risolvi) => server.listen(port, '127.0.0.1', risolvi));

  // `pgbouncer=true` non e' un vezzo: PGlite ha un solo backend condiviso fra
  // le connessioni, e i nomi delle istruzioni preparate di Prisma ("s0", "s1")
  // si scontrerebbero fra una connessione e l'altra — l'errore e' "prepared
  // statement s0 already exists", e arriva a caso a seconda di chi parte prima.
  // In questa modalita' Prisma non le tiene in cache e il conflitto non si pone.
  return `postgresql://postgres:prova@127.0.0.1:${port}/postgres?schema=public&connection_limit=1`;
}


/**
 * I messaggi del protocollo dentro un buffer: dove comincia ognuno e di che
 * tipo e'.
 *
 * Il formato e' quello di Postgres: un byte di tipo, quattro byte di lunghezza
 * — che si conta da se stessa, non dal byte di tipo — poi il corpo. Restituire
 * anche l'OFFSET e non solo il tipo non e' un lusso: e' l'unico modo di tagliare
 * l'ultimo messaggio nel punto giusto, e il conto fatto a mano sulla coda del
 * buffer e' gia' stato sbagliato una volta — tagliava un byte piu' in la' e si
 * portava via l'errore insieme al saluto, facendo sembrare riuscita una INSERT
 * che il database aveva rifiutato.
 */
function messaggi(buffer: Buffer): { tipo: string; inizio: number }[] {
  const trovati: { tipo: string; inizio: number }[] = [];
  let i = 0;
  while (i + 5 <= buffer.length) {
    const lunghezza = buffer.readInt32BE(i + 1);
    if (lunghezza < 4) return trovati;
    trovati.push({ tipo: String.fromCharCode(buffer[i]), inizio: i });
    i += 1 + lunghezza;
  }
  return trovati;
}

/**
 * Toglie il "pronto per un'altra" che PGlite manda di troppo dopo un errore.
 *
 * IL DIFETTO, che si e' visto solo guardando i byte. Quando un'istruzione del
 * protocollo esteso fallisce — un indice unico violato, per dire — PGlite
 * risponde con l'errore E SUBITO con un `ReadyForQuery`, senza aspettare il
 * `Sync` del client. Poi il `Sync` arriva davvero, e PGlite ne manda un
 * secondo: due "pronto" per una domanda sola. Il driver di Prisma legge il
 * primo dove non se lo aspetta e CHIUDE LA CONNESSIONE — nei log compare
 * "Server has closed the connection" sulla query subito successiva.
 *
 * Cosa costava, in pratica: la deduplica degli webhook si regge proprio su
 * quell'errore. La seconda consegna dello stesso evento deve sollevare P2002,
 * farsi riconoscere come doppione e rispondere "ricevuto". Con la connessione
 * caduta la rilettura falliva, la rotta rispondeva 500, e Shopify avrebbe
 * ritentato all'infinito una consegna gia' scritta.
 *
 * Si toglie solo quando il client non ha chiesto ne' un `Sync` ne' una query
 * semplice: in quei due casi il `ReadyForQuery` e' dovuto, ed e' lui che chiude
 * il giro.
 */
function sistemaLaRispostaDopoUnErrore(
  richiesta: Uint8Array,
  risposta: Uint8Array,
): Uint8Array {
  const inviati = messaggi(Buffer.from(richiesta)).map((m) => m.tipo);
  if (inviati.includes('S') || inviati.includes('Q')) return risposta;

  const buffer = Buffer.from(risposta);
  const ricevuti = messaggi(buffer);
  if (ricevuti.length < 2) return risposta;
  if (ricevuti[ricevuti.length - 1].tipo !== 'Z') return risposta;
  if (!ricevuti.some((m) => m.tipo === 'E')) return risposta;

  return buffer.subarray(0, ricevuti[ricevuti.length - 1].inizio);
}

/**
 * Rimette il database com'era appena dopo le migrazioni.
 *
 * `TRUNCATE ... CASCADE` in un colpo solo e non una tabella per volta: le
 * chiavi esterne fra le tabelle rendono impossibile un ordine giusto, e
 * disattivarle temporaneamente vorrebbe dire azzerare con regole diverse da
 * quelle con cui l'app scrive.
 */
export async function resetDatabase(): Promise<void> {
  const daSvuotare = tutteLeTabelle.filter((t) => !daTenere.includes(t));
  if (daSvuotare.length === 0) return;
  await db.exec(
    `TRUNCATE TABLE ${daSvuotare.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/** Una lettura diretta, per le asserzioni che guardano il database e non la pagina. */
export async function queryRows<T>(sql: string): Promise<T[]> {
  const esito = await db.query<T>(sql);
  return esito.rows;
}

export async function stopDatabase(): Promise<void> {
  await new Promise<void>((risolvi) => server.close(() => risolvi()));
  await db.close();
}
