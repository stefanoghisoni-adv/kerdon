import { describe, it, expect } from 'vitest';
import {
  WATERMARK_OVERLAP_MS,
  deltaFloor,
  runStatusFor,
  watermarkToCommit,
} from './watermark';

/**
 * Il confine incrementale, provato senza database.
 *
 * Il guasto che queste prove chiudono e' invisibile a occhio: una corsa che
 * ignorava una manciata di errori si dichiarava `completed`, la corsa dopo
 * prendeva il suo `startedAt` come confine, e le risorse rimaste indietro
 * finivano sotto quel confine per sempre. Qui si verifica che il confine possa
 * avanzare SOLO fin dove la corsa e' davvero arrivata.
 */
describe('il confine da cui rileggere', () => {
  it('senza nessun confine guadagnato riparte dal ripiego', () => {
    const collegamento = new Date('2026-01-01T00:00:00Z');
    expect(deltaFloor(null, collegamento)).toEqual(collegamento);
    expect(deltaFloor(undefined, collegamento)).toEqual(collegamento);
  });

  it('si sovrappone alla finestra precedente invece di appoggiarcisi', () => {
    // Fra due finestre che si toccano esattamente c'e' una fessura: una
    // modifica avvenuta nell'istante in cui la corsa leggeva quella pagina non
    // sta ne' di qua ne' di la'. E i due orologi non sono nemmeno lo stesso —
    // `updated_at` lo scrive Shopify, il confine lo scriviamo noi.
    const confine = new Date('2026-03-01T10:00:00Z');
    const partenza = deltaFloor(confine, new Date('2020-01-01T00:00:00Z'));

    expect(partenza.getTime()).toBe(confine.getTime() - WATERMARK_OVERLAP_MS);
    expect(partenza.getTime()).toBeLessThan(confine.getTime());
  });
});

describe('il confine che una corsa ha diritto di lasciare', () => {
  const inizio = new Date('2026-03-01T10:00:00Z');

  it('senza niente da trattenere arriva fino al proprio inizio', () => {
    expect(watermarkToCommit(inizio, null)).toEqual(inizio);
  });

  it('non scavalca la risorsa rimasta indietro', () => {
    // E' il cuore di tutto: il prodotto e' stato modificato alle 09:30 e non si
    // e' riusciti a scriverlo. Se il confine finisse alle 10:00, la corsa dopo
    // chiederebbe "cosa e' cambiato dopo le 10:00" e quel prodotto non ci
    // sarebbe — ne' allora ne' mai piu', perche' su Shopify non cambiera'.
    const modifica = new Date('2026-03-01T09:30:00Z');
    expect(watermarkToCommit(inizio, modifica)).toEqual(modifica);
  });

  it('non va oltre il proprio inizio nemmeno se il trattenimento e\' piu\' avanti', () => {
    // Una risorsa modificata DOPO l'inizio della corsa non autorizza a
    // dichiarare di essere arrivati piu' in la' di dove si e' letto.
    const dopo = new Date('2026-03-01T11:00:00Z');
    expect(watermarkToCommit(inizio, dopo)).toEqual(inizio);
  });
});

describe('come si chiude una corsa', () => {
  it('senza niente in sospeso e\' completata', () => {
    expect(runStatusFor(0)).toBe('completed');
  });

  it('con anche una sola risorsa indietro e\' parziale, non completata', () => {
    // Una risorsa sola basta: dire "completata" a chi ha un prodotto non
    // allineato e' esattamente la bugia che si e' smesso di raccontare.
    expect(runStatusFor(1)).toBe('completed_with_repairs');
    expect(runStatusFor(42)).toBe('completed_with_repairs');
  });
});
