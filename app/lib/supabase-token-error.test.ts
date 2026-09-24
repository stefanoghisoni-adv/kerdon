import { describe, it, expect } from 'vitest';
import { SupabaseTokenError, isSupabaseCredentialDead } from './supabase-management.server';

// Il 12 settembre i log di produzione hanno mostrato "Supabase token error: 404"
// su profit e products: il permesso non valeva piu', e al merchant arrivava una
// card senza numeri con scritto "sara' disponibile dopo la prima
// sincronizzazione" — una frase falsa, perche' quella sincronizzazione non
// sarebbe mai avvenuta.
//
// Il 20 settembre gli stessi log hanno mostrato che il 404 sa mentire anche
// nell'altro senso: sei chiamate della dashboard nello stesso secondo, tutte
// con lo stesso refresh token, e quelle che perdono la corsa si prendono un 404
// da un permesso perfettamente valido — due minuti dopo le stesse rotte
// rispondevano pulite. Da li' la distinzione qui sotto: il 404 pesa come
// "ricollega" solo dopo che chi lo ha ricevuto e' tornato a leggere la riga del
// token e non ci ha trovato niente di buono.
describe('il rinnovo del permesso Supabase', () => {
  it('un permesso revocato non si aggiusta da se', () => {
    for (const stato of [400, 401, 403]) {
      expect(new SupabaseTokenError(stato).credenzialeMorta).toBe(true);
      expect(isSupabaseCredentialDead(new SupabaseTokenError(stato))).toBe(true);
    }
  });

  it('un 404 da solo non basta a mandare il merchant a ricollegare', () => {
    // Puo' essere una corsa persa, e chiedere di rifare l'autorizzazione per
    // una condizione che passa da sola e' un costo che non deve pagare.
    expect(new SupabaseTokenError(404).credenzialeMorta).toBe(false);
    expect(isSupabaseCredentialDead(new SupabaseTokenError(404))).toBe(false);
  });

  it('un 404 confermato dalla rilettura invece e un permesso che non c e piu', () => {
    // Nessun token valido sulla riga dopo il fallimento: la corsa e' esclusa,
    // resta il permesso revocato.
    expect(new SupabaseTokenError(404, true).credenzialeMorta).toBe(true);
    expect(isSupabaseCredentialDead(new SupabaseTokenError(404, true))).toBe(true);
  });

  it('la conferma non promuove uno stato che non sia il 404', () => {
    for (const stato of [429, 500, 503]) {
      expect(new SupabaseTokenError(stato, true).credenzialeMorta).toBe(false);
    }
  });

  it('un guasto di Supabase invece passa da solo, e non si chiede niente al merchant', () => {
    for (const stato of [429, 500, 502, 503, 504]) {
      expect(new SupabaseTokenError(stato).credenzialeMorta).toBe(false);
      expect(isSupabaseCredentialDead(new SupabaseTokenError(stato))).toBe(false);
    }
  });

  it('lo stato resta leggibile nel messaggio, per chi guarda i log', () => {
    expect(new SupabaseTokenError(404).message).toBe('Supabase token error: 404');
    expect(new SupabaseTokenError(404).name).toBe('SupabaseTokenError');
  });

  it('un errore qualunque non viene scambiato per un permesso morto', () => {
    expect(isSupabaseCredentialDead(new Error('Supabase token error: 404'))).toBe(false);
    expect(isSupabaseCredentialDead(null)).toBe(false);
    expect(isSupabaseCredentialDead('404')).toBe(false);
  });
});
