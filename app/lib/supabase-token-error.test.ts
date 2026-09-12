import { describe, it, expect } from 'vitest';
import { SupabaseTokenError, isSupabaseCredentialDead } from './supabase-management.server';

// Il 12 settembre i log di produzione hanno mostrato "Supabase token error: 404"
// su profit e products: il permesso non valeva piu', e al merchant arrivava una
// card senza numeri con scritto "sara' disponibile dopo la prima
// sincronizzazione" — una frase falsa, perche' quella sincronizzazione non
// sarebbe mai avvenuta.
describe('il rinnovo del permesso Supabase', () => {
  it('un permesso revocato o sconosciuto non si aggiusta da se', () => {
    for (const stato of [400, 401, 403, 404]) {
      expect(new SupabaseTokenError(stato).credenzialeMorta).toBe(true);
      expect(isSupabaseCredentialDead(new SupabaseTokenError(stato))).toBe(true);
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
