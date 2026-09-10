// app/lib/webhooks/processors.server.ts
//
// Chi sa lavorare quale topic, dichiarato in un posto solo.
//
// Sta separato dalla posta in arrivo perche' i due consumatori sono due — la
// rotta subito dopo la ricevuta e il drenaggio del cron — e un elenco scritto
// due volte e' il modo in cui uno dei due impara a lavorare un topic e l'altro
// no. La posta in arrivo non conosce nessun processore: li riceve.
//
// Il tipo `Record<WebhookTopic, ...>` e' la garanzia che conta: un topic
// aggiunto all'elenco senza il suo processore non compila. E' il difetto che la
// coda ha pagato una volta — un lavoro accodato che nessuno sapeva lavorare
// resta in attesa per sempre — e qui non puo' ripetersi.
//
// Piu' topic sullo stesso processore non e' una svista: `orders/create`,
// `orders/updated` e `refunds/create` dicono la stessa cosa — quale ordine
// rileggere — e tre strade separate che devono restare uguali sono tre strade
// che prima o poi divergono.

import type { WebhookProcessor } from './inbox.server';
import type { WebhookTopic } from './inbox-model';
import { handleAppUninstalled } from './handle-uninstall.server';
import { handleSubscriptionUpdate } from './handle-subscription-update.server';
import { handleProductUpsert, handleProductDelete } from './handle-product.server';
import { handleCustomerUpsert, handleCustomerDelete } from './handle-customer.server';
import { handleOrderUpsert, handleOrderDelete } from './handle-order.server';

export const WEBHOOK_PROCESSORS: Record<WebhookTopic, WebhookProcessor> = {
  'app/uninstalled': handleAppUninstalled,
  'app_subscriptions/update': handleSubscriptionUpdate,
  'products/create': handleProductUpsert,
  'products/update': handleProductUpsert,
  'products/delete': handleProductDelete,
  'customers/create': handleCustomerUpsert,
  'customers/update': handleCustomerUpsert,
  'customers/delete': handleCustomerDelete,
  'orders/create': handleOrderUpsert,
  'orders/updated': handleOrderUpsert,
  'refunds/create': handleOrderUpsert,
  'orders/delete': handleOrderDelete,
};
