import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: { birthdateNoticeDismissal: { findUnique, upsert } },
}));

const { birthdateNoticeDismissedFor, dismissBirthdateNotice } = await import(
  './birthdate-dismissal.server'
);

/** L'errore che Prisma solleva quando la tabella non c'e' ancora. */
function tabellaMancante(): Error {
  return new Prisma.PrismaClientKnownRequestError('table does not exist', {
    code: 'P2021',
    clientVersion: 'test',
  });
}

const CAMPO = 'facts.birth_date';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('per quale campo l avviso risulta chiuso', () => {
  it('nessuna riga: non risulta chiuso per nessun campo', async () => {
    findUnique.mockResolvedValue(null);
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBeNull();
  });

  it('la riga dice il campo, e il campo e quello per intero', async () => {
    findUnique.mockResolvedValue({ dismissedFor: CAMPO });
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBe(CAMPO);
  });

  // Il cuore della correzione: la chiusura non vive piu' in un posto legato
  // all'indirizzo da cui arriva la pagina. Cambiando dominio la riga resta.
  it('cambiare dominio non la tocca: sta sul negozio, non sul browser', async () => {
    findUnique.mockResolvedValue({ dismissedFor: CAMPO });
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBe(CAMPO);
    // Nessuna lettura di `localStorage` da nessuna parte in questo percorso.
    expect(findUnique).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      select: { dismissedFor: true },
    });
  });

  // La finestra fra il rilascio del codice e la migrazione lanciata a mano.
  it('tabella non ancora creata: si risponde chiuso, non aperto', async () => {
    findUnique.mockRejectedValue(tabellaMancante());
    // "Chiuso" e non "aperto" perche' le due strade sbagliate non pesano
    // uguale: rispondendo aperto si terrebbe acceso un avviso che il merchant
    // non puo' spegnere — la chiusura scriverebbe sulla stessa tabella che non
    // c'e' — e sparirebbe la card dei campi aggiuntivi, che c'e' solo quando
    // l'avviso tace. Si perde una conferma, si tiene una funzione.
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBe(CAMPO);
  });

  it('database owner che non risponde: stessa risposta prudente', async () => {
    findUnique.mockRejectedValue(new Error('connessione caduta'));
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBe(CAMPO);
    expect(console.warn).toHaveBeenCalled();
  });

  // Se la memoria fosse un si'/no, cambiando campo il merchant non vedrebbe
  // piu' la conferma del campo nuovo.
  it('chiusa per un campo, un campo diverso torna a chiedere conferma', async () => {
    findUnique.mockResolvedValue({ dismissedFor: 'custom.vecchio' });
    expect(await birthdateNoticeDismissedFor('shop-1', CAMPO)).toBe('custom.vecchio');
  });
});

describe('chiudere l avviso', () => {
  it('scrive il campo, e sovrascrive invece di accumulare', async () => {
    upsert.mockResolvedValue({});
    expect(await dismissBirthdateNotice('shop-1', CAMPO)).toBe(true);
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      create: { shopId: 'shop-1', dismissedFor: CAMPO },
      update: { dismissedFor: CAMPO },
    });
  });

  // Non si finge. Un merchant a cui si dicesse "registrato" e che poi rivede
  // l'avviso non avrebbe modo di capire cosa e' andato storto.
  it('senza tabella risponde di no, e non lo nasconde', async () => {
    upsert.mockRejectedValue(tabellaMancante());
    expect(await dismissBirthdateNotice('shop-1', CAMPO)).toBe(false);
    // La tabella che non c'e' ancora e' una finestra prevista, non un guasto:
    // non si sporca il log a ogni clic.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('un guasto vero risponde di no e lascia traccia', async () => {
    upsert.mockRejectedValue(new Error('connessione caduta'));
    expect(await dismissBirthdateNotice('shop-1', CAMPO)).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});
