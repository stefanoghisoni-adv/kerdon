import { describe, it, expect, afterEach } from 'vitest';

import {
  ERASURE_PROCEDURE_VERSION,
  ZERO_COUNTS,
  shopErasureRef,
  verifyShopErasureRef,
} from './erasure-proof.server';

/**
 * L'impronta con cui un negozio cancellato resta riconoscibile.
 *
 * La proprieta' che questo file difende e' una sola, ed e' quella che rende
 * lecito conservare la prova: dall'impronta non si torna al negozio. Se un
 * giorno qualcuno ci scrivesse dentro il dominio "per comodita' di debug", il
 * registro delle cancellazioni diventerebbe l'elenco di chi ha chiesto di
 * sparire — cioe' il modo piu' elegante di non aver cancellato niente.
 */

const SHOP = 'negozio-di-prova.myshopify.com';
const ALTRO = 'un-altro-negozio.myshopify.com';

afterEach(() => {
  delete process.env.SHOP_ERASURE_SECRET;
  process.env.ENCRYPTION_SECRET ??= 'chiave-di-prova-solo-per-i-test';
});

describe('l impronta del negozio', () => {
  it('non contiene il dominio, ne un suo pezzo', () => {
    const ref = shopErasureRef(SHOP);

    expect(ref).not.toContain('negozio-di-prova');
    expect(ref).not.toContain('myshopify');
    expect(ref.toLowerCase()).not.toContain(SHOP.toLowerCase());
    // Nemmeno codificato: una base64 del dominio sarebbe leggibile quanto il
    // dominio, e sarebbe il modo piu' facile di sbagliare questa tabella.
    expect(ref).not.toContain(Buffer.from(SHOP).toString('base64url'));
  });

  it('e stabile: lo stesso negozio da sempre la stessa impronta', () => {
    expect(shopErasureRef(SHOP)).toBe(shopErasureRef(SHOP));
  });

  it('distingue due negozi', () => {
    expect(shopErasureRef(SHOP)).not.toBe(shopErasureRef(ALTRO));
  });

  it('porta la versione, cosi una firma futura non si confonde con questa', () => {
    expect(shopErasureRef(SHOP).startsWith('v1:')).toBe(true);
  });

  /**
   * E' il senso di tutta la tabella: verificabile senza essere leggibile. Chi
   * arriva con la domanda "questo negozio e' stato cancellato?" ricalcola e
   * cerca; chi apre la tabella non ci legge nessun negozio.
   */
  it('si puo verificare da chi gia sa di quale negozio parla', () => {
    const ref = shopErasureRef(SHOP);
    expect(verifyShopErasureRef(ref, SHOP)).toBe(true);
    expect(verifyShopErasureRef(ref, ALTRO)).toBe(false);
  });

  it('un riferimento di lunghezza diversa e falso, non un errore', () => {
    // `timingSafeEqual` solleverebbe su due buffer di lunghezza diversa: chi
    // verifica deve ricevere `false`, non un'eccezione da propagare.
    expect(() => verifyShopErasureRef('troppo-corto', SHOP)).not.toThrow();
    expect(verifyShopErasureRef('troppo-corto', SHOP)).toBe(false);
  });

  /**
   * La chiave dedicata serve a ruotare la firma delle cancellazioni senza
   * toccare quella con cui sono cifrati i token dei negozi.
   */
  it('cambia se cambia la chiave', () => {
    const conDerivata = shopErasureRef(SHOP);
    process.env.SHOP_ERASURE_SECRET = 'una-chiave-tutta-sua';
    expect(shopErasureRef(SHOP)).not.toBe(conDerivata);
  });

  /**
   * Senza nessuna chiave si solleva invece di firmare con una costante: una
   * firma che chiunque puo' ricalcolare non e' una firma, ed e' peggio di un
   * errore perche' non si vede.
   */
  it('senza nessun segreto configurato solleva', () => {
    const ereditato = process.env.ENCRYPTION_SECRET;
    delete process.env.ENCRYPTION_SECRET;
    try {
      expect(() => shopErasureRef(SHOP)).toThrow(/SHOP_ERASURE_SECRET|ENCRYPTION_SECRET/);
    } finally {
      process.env.ENCRYPTION_SECRET = ereditato;
    }
  });
});

describe('la forma della prova', () => {
  it('i conteggi partono da zero su ogni tabella dichiarata', () => {
    expect(ZERO_COUNTS).toEqual({
      sessions: 0,
      supabase_configs: 0,
      supabase_oauth_tokens: 0,
      customer_data_access_logs: 0,
      shops: 0,
    });
  });

  /**
   * Il numero di versione esiste per chi rileggera' una prova vecchia: senza,
   * una tabella assente dai conteggi non si distinguerebbe da una che nessuno
   * ha cancellato.
   */
  it('la procedura ha un numero di versione', () => {
    expect(ERASURE_PROCEDURE_VERSION).toBeGreaterThan(0);
  });
});
