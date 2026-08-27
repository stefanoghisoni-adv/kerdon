// Shopify app initialization: OAuth, session management, and authenticated
// request helpers. Provides `authenticate` used by every embedded route loader.
import '@shopify/shopify-app-remix/adapters/node';
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from '@shopify/shopify-app-remix/server';
import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import { prisma } from '~/db.server';
import { encrypt } from '~/utils/crypto.server';
import { shopCreateData } from '~/utils/shop.server';

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || '',
  apiVersion: ApiVersion.July26,
  scopes: process.env.SHOPIFY_SCOPES?.split(','),
  appUrl: process.env.SHOPIFY_APP_URL || '',
  authPathPrefix: '/auth',
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // Obbligatorio per le app create dopo il 1 aprile 2026: Shopify risponde 403
    // ("Non-expiring access tokens are no longer accepted") a chi presenta un
    // token perpetuo. Con il flag attivo la libreria chiede token a scadenza e
    // li rinnova da sola prima che scadano, usando il refresh token in sessione.
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Runs after a successful install/auth. Upserts the merchant record so the
    // rest of the app (dashboard, sync, billing) can resolve the shop by domain.
    // Product/customer/GDPR webhooks are app-managed (declared in
    // shopify.app.toml), so no runtime webhook registration is needed here.
    afterAuth: async ({ session }) => {
      // NON deve bloccare l'installazione: se l'upsert fallisce (es. problema DB
      // transitorio), il self-heal `getOrCreateShop` nei loader materializza
      // comunque lo shop. Un throw qui, non gestito, farebbe fallire l'intero
      // OAuth callback con un generico "Unexpected Server Error". Logghiamo lo
      // stack completo per la diagnosi.
      try {
        await prisma.shop.upsert({
          where: { shopDomain: session.shop },
          create: await shopCreateData(session),
          update: {
            accessToken: encrypt(session.accessToken ?? ''),
            scopes: session.scope ?? '',
            uninstalledAt: null,
          },
        });
      } catch (err) {
        console.error('[afterAuth] upsert shop fallito:', err);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
