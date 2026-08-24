import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMetaAuthorizeUrl, metaCredentials, metaRedirectUri } from './oauth.server';

describe('buildMetaAuthorizeUrl', () => {
  it('porta con se stato, indirizzo di ritorno e permessi', () => {
    const url = new URL(
      buildMetaAuthorizeUrl({
        appId: '123',
        redirectUri: 'https://app.example.com/auth/meta/callback',
        state: 'firmato.qui',
      }),
    );

    expect(url.hostname).toBe('www.facebook.com');
    expect(url.searchParams.get('client_id')).toBe('123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/auth/meta/callback',
    );
    expect(url.searchParams.get('state')).toBe('firmato.qui');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('chiede i due permessi che servono, e nessun altro', () => {
    // Ogni permesso in piu' e' una domanda in piu' nella schermata di
    // autorizzazione e una cosa in piu' da giustificare alla revisione di Meta.
    const url = new URL(
      buildMetaAuthorizeUrl({ appId: '1', redirectUri: 'https://x/y', state: 's' }),
    );
    expect(url.searchParams.get('scope')).toBe('ads_management,business_management');
  });
});

describe('metaCredentials', () => {
  const before = { ...process.env };
  beforeEach(() => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });
  afterEach(() => {
    process.env = { ...before };
  });

  it('senza credenziali non si finge di essere configurati', () => {
    expect(metaCredentials()).toBeNull();

    process.env.META_APP_ID = 'solo-id';
    expect(metaCredentials()).toBeNull();
  });

  it('con entrambe le chiavi torna la coppia', () => {
    process.env.META_APP_ID = 'id';
    process.env.META_APP_SECRET = 'secret';
    expect(metaCredentials()).toEqual({ appId: 'id', appSecret: 'secret' });
  });
});

describe('metaRedirectUri', () => {
  it("e' un indirizzo dell'app, non della piattaforma", () => {
    process.env.SHOPIFY_APP_URL = 'https://app.example.com';
    expect(metaRedirectUri()).toBe('https://app.example.com/auth/meta/callback');
  });
});
