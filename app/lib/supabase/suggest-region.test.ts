import { describe, it, expect } from 'vitest';
import { suggestRegion, DEFAULT_REGION } from './suggest-region';
import { SUPABASE_REGIONS } from '~/lib/supabase-management.server';

const ALL = SUPABASE_REGIONS;

describe('suggestRegion', () => {
  it('manda ogni continente dalla parte giusta del mondo', () => {
    const cases: Array<[string, string]> = [
      ['Europe/Rome', 'eu-central-1'],
      ['Europe/London', 'eu-west-1'],
      ['Europe/Paris', 'eu-west-3'],
      ['Europe/Moscow', 'eu-central-1'],
      ['America/New_York', 'us-east-1'],
      ['America/Los_Angeles', 'us-west-1'],
      ['America/Toronto', 'ca-central-1'],
      ['America/Sao_Paulo', 'sa-east-1'],
      ['Asia/Tokyo', 'ap-northeast-1'],
      ['Asia/Kolkata', 'ap-south-1'],
      ['Asia/Singapore', 'ap-southeast-1'],
      ['Australia/Sydney', 'ap-southeast-1'],
      ['Africa/Lagos', 'eu-west-1'],
    ];

    for (const [zone, expected] of cases) {
      expect(suggestRegion(zone, ALL), zone).toBe(expected);
    }
  });

  it('un negozio italiano non viene servito dall Ohio', () => {
    // E' il senso di tutto: la region si sceglie per distanza, e la distanza
    // decide quanto tempo passa fra la domanda e la risposta.
    expect(suggestRegion('Europe/Rome', ALL)).not.toMatch(/^us-/);
  });

  it('senza fuso si ripiega, non si tira a indovinare', () => {
    expect(suggestRegion(null, ALL)).toBe(DEFAULT_REGION);
    expect(suggestRegion('', ALL)).toBe(DEFAULT_REGION);
    expect(suggestRegion('   ', ALL)).toBe(DEFAULT_REGION);
  });

  it('un fuso che non conosciamo vale come nessun fuso', () => {
    expect(suggestRegion('Marte/Olympus', ALL)).toBe(DEFAULT_REGION);
  });

  it('non consiglia una region che non si puo scegliere', () => {
    // Le region disponibili cambiano nel tempo: suggerirne una assente
    // metterebbe il badge accanto a una voce che nella tendina non c'e'.
    const solo = [{ id: 'ap-southeast-1' }];
    expect(suggestRegion('Europe/Rome', solo)).toBe('ap-southeast-1');
  });

  it('senza region disponibili non si consiglia niente', () => {
    expect(suggestRegion('Europe/Rome', [])).toBeNull();
  });

  it('quello che consiglia e sempre una region esistente', () => {
    for (const zone of ['Europe/Rome', 'America/New_York', 'Asia/Tokyo', 'sconosciuto']) {
      const suggested = suggestRegion(zone, ALL);
      expect(ALL.some((r) => r.id === suggested)).toBe(true);
    }
  });
});
