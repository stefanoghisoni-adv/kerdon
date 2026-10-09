import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { klaviyoCredentials, klaviyoRedirectUri, KLAVIYO_SCOPES } from './config.server';

const salvate = { ...process.env };

describe('configurazione Klaviyo', () => {
  beforeEach(() => {
    process.env.KLAVIYO_CLIENT_ID = 'cid';
    process.env.KLAVIYO_CLIENT_SECRET = 'segreto';
    process.env.SHOPIFY_APP_URL = 'https://api.kerdon.io/';
  });
  afterEach(() => {
    process.env = { ...salvate };
  });

  it('legge le credenziali dall ambiente', () => {
    expect(klaviyoCredentials()).toEqual({ clientId: 'cid', clientSecret: 'segreto' });
  });

  it('lancia se manca una credenziale', () => {
    delete process.env.KLAVIYO_CLIENT_SECRET;
    expect(() => klaviyoCredentials()).toThrow();
  });

  it('costruisce il redirect sull URL dell app senza doppia barra', () => {
    expect(klaviyoRedirectUri()).toBe('https://api.kerdon.io/auth/klaviyo/callback');
  });

  it('chiede solo lettura di profili e account', () => {
    expect(KLAVIYO_SCOPES).toBe('profiles:read accounts:read');
  });
});
