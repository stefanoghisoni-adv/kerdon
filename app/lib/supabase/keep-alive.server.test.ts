import { describe, it, expect, vi } from 'vitest';
import type { Shop, SupabaseConfig } from '@prisma/client';
import { keepMerchantDbAwake } from './keep-alive.server';

// Mock del modulo supabase.server
vi.mock('../supabase.server', () => ({
  createSupabaseClient: vi.fn(),
}));

// Mock del console.error per non sporcare l'output dei test
vi.spyOn(console, 'error').mockImplementation(() => {});

describe('keepMerchantDbAwake', () => {
  const mockShop = {
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
  } as unknown as Shop;

  const mockConfig = {
    id: 'config-1',
    shopId: 'shop-1',
    supabaseUrl: 'https://test.supabase.co',
    supabasePublicKey: 'public-key',
    supabaseServiceRoleKey: 'encrypted-service-role-key',
    supabaseProjectRef: 'test-ref',
    supabaseProjectName: 'Test Project',
    tableNameProducts: 'products',
    tableNameCustomers: 'customers',
    syncIntervalHours: 24,
    connectionVerifiedAt: new Date(),
    schemaVersion: 1,
  } as unknown as SupabaseConfig;

  it('restituisce skipped quando supabaseConfig è null', async () => {
    const shop = { ...mockShop, supabaseConfig: null };
    const result = await keepMerchantDbAwake(shop);
    expect(result).toBe('skipped');
  });

  it('restituisce ok quando la lettura sulla tabella prodotti riesce', async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };

    const { createSupabaseClient } = await import('../supabase.server');
    vi.mocked(createSupabaseClient).mockReturnValue(mockClient as any);

    const shop = { ...mockShop, supabaseConfig: mockConfig };
    const result = await keepMerchantDbAwake(shop);

    expect(result).toBe('ok');
    expect(mockClient.from).toHaveBeenCalledWith('products');
  });

  it('fa fallback sulla tabella clienti quando quella prodotti non esiste', async () => {
    let callCount = 0;
    const mockClient = {
      from: vi.fn().mockImplementation((table: string) => {
        callCount++;
        if (table === 'products') {
          return {
            select: vi.fn().mockRejectedValue(new Error('Table not found')),
          };
        }
        return {
          select: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }),
    };

    const { createSupabaseClient } = await import('../supabase.server');
    vi.mocked(createSupabaseClient).mockReturnValue(mockClient as any);

    const shop = { ...mockShop, supabaseConfig: mockConfig };
    const result = await keepMerchantDbAwake(shop);

    expect(result).toBe('ok');
    expect(mockClient.from).toHaveBeenCalledWith('products');
    expect(mockClient.from).toHaveBeenCalledWith('customers');
    expect(callCount).toBe(2);
  });

  it('restituisce failed quando entrambe le tabelle falliscono', async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockRejectedValue(new Error('Connection failed')),
      }),
    };

    const { createSupabaseClient } = await import('../supabase.server');
    vi.mocked(createSupabaseClient).mockReturnValue(mockClient as any);

    const shop = { ...mockShop, supabaseConfig: mockConfig };
    const result = await keepMerchantDbAwake(shop);

    expect(result).toBe('failed');
  });

  it('restituisce failed quando createSupabaseClient lancia un errore', async () => {
    const { createSupabaseClient } = await import('../supabase.server');
    vi.mocked(createSupabaseClient).mockImplementation(() => {
      throw new Error('Invalid credentials');
    });

    const shop = { ...mockShop, supabaseConfig: mockConfig };
    const result = await keepMerchantDbAwake(shop);

    expect(result).toBe('failed');
  });

  it('rispetta il timeout configurato', async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              // Simula una query che impiega 100ms
              setTimeout(() => resolve({ data: [], error: null }), 100);
            }),
        ),
      }),
    };

    const { createSupabaseClient } = await import('../supabase.server');
    vi.mocked(createSupabaseClient).mockReturnValue(mockClient as any);

    const shop = { ...mockShop, supabaseConfig: mockConfig };

    // Con timeout di 50ms dovrebbe fallire
    const result = await keepMerchantDbAwake(shop, 50);
    expect(result).toBe('failed');
  });
});
