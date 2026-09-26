// Verifica che gli scope siano identici ovunque siano dichiarati.
//
// La fonte di verità è `shopify.app.toml`. Ogni altra dichiarazione — le
// variabili d'ambiente, il README, i documenti legali, le prove — deve ripetere
// quella riga parola per parola. Una divergenza fa sì che l'app chieda un
// consenso diverso da quello che il dashboard mostra al merchant, o che il
// modulo Protected Customer Data del revisore non combaci con gli scope veri.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Legge `scopes` da shopify.app.toml (la fonte di verità).
 */
function leggiScopesDalToml(): string {
  const tomlPath = path.join(REPO_ROOT, 'shopify.app.toml');
  const contenuto = fs.readFileSync(tomlPath, 'utf-8');
  const match = contenuto.match(/^scopes\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('Campo `scopes` non trovato in shopify.app.toml');
  }
  return match[1];
}

/**
 * Estrae SHOPIFY_SCOPES da .env.example.
 */
function leggiScopesDaEnvExample(): string {
  const envPath = path.join(REPO_ROOT, '.env.example');
  const contenuto = fs.readFileSync(envPath, 'utf-8');
  const match = contenuto.match(/^SHOPIFY_SCOPES=(.+)$/m);
  if (!match) {
    throw new Error('SHOPIFY_SCOPES non trovato in .env.example');
  }
  return match[1].trim();
}

/**
 * Estrae SHOPIFY_SCOPES dal README.md.
 */
function leggiScopesDaReadme(): string {
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const contenuto = fs.readFileSync(readmePath, 'utf-8');
  // Cerca il blocco delle variabili d'ambiente dove compare SHOPIFY_SCOPES
  const match = contenuto.match(/SHOPIFY_SCOPES=([^\n]+)/);
  if (!match) {
    throw new Error('SHOPIFY_SCOPES non trovato in README.md');
  }
  return match[1].trim();
}

/**
 * Estrae SHOPIFY_SCOPES da e2e/ambiente.ts.
 */
function leggiScopesDaE2e(): string {
  const e2ePath = path.join(REPO_ROOT, 'e2e', 'ambiente.ts');
  const contenuto = fs.readFileSync(e2ePath, 'utf-8');
  const match = contenuto.match(/SHOPIFY_SCOPES:\s*['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error('SHOPIFY_SCOPES non trovato in e2e/ambiente.ts');
  }
  return match[1];
}

/**
 * Estrae la riga degli scope da docs/legal/protected-customer-data.md.
 */
function leggiScopesDaProtectedCustomerData(): string {
  const docPath = path.join(
    REPO_ROOT,
    'docs',
    'legal',
    'protected-customer-data.md',
  );
  const contenuto = fs.readFileSync(docPath, 'utf-8');
  // Cerca "Oggi sono: `read_products`, ..." e cattura tutto fino al punto finale
  const match = contenuto.match(/Oggi sono:\s*(.+?)\./s);
  if (!match) {
    throw new Error(
      'Elenco scope non trovato in docs/legal/protected-customer-data.md',
    );
  }
  // Estrae tutti gli scope (sono fra backtick) e li unisce con la virgola
  const scopes = match[1].match(/`([^`]+)`/g);
  if (!scopes) {
    throw new Error('Nessuno scope trovato nel blocco');
  }
  return scopes.map((s) => s.replace(/`/g, '')).join(',');
}

describe('Scope OAuth Shopify', () => {
  const scopesCanonical = leggiScopesDalToml();

  it('shopify.app.toml definisce gli scope', () => {
    expect(scopesCanonical).toBeTruthy();
    expect(scopesCanonical.split(',').length).toBeGreaterThan(0);
  });

  it('.env.example ripete gli scope del TOML', () => {
    expect(leggiScopesDaEnvExample()).toBe(scopesCanonical);
  });

  it('README.md ripete gli scope del TOML', () => {
    expect(leggiScopesDaReadme()).toBe(scopesCanonical);
  });

  it('e2e/ambiente.ts ripete gli scope del TOML', () => {
    expect(leggiScopesDaE2e()).toBe(scopesCanonical);
  });

  it('docs/legal/protected-customer-data.md ripete gli scope del TOML', () => {
    expect(leggiScopesDaProtectedCustomerData()).toBe(scopesCanonical);
  });

  it('non include write_products (rimosso)', () => {
    expect(scopesCanonical).not.toContain('write_products');
  });

  it('include read_shipping e read_returns', () => {
    expect(scopesCanonical).toContain('read_shipping');
    expect(scopesCanonical).toContain('read_returns');
  });
});
