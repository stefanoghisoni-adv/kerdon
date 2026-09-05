// app/lib/webhooks/processors.server.ts
//
// Chi sa lavorare quale topic, dichiarato in un posto solo.
//
// Sta separato dalla posta in arrivo perche' i due consumatori sono due — la
// rotta subito dopo la ricevuta e il drenaggio del cron — e un elenco scritto
// due volte e' il modo in cui uno dei due impara a lavorare un topic e l'altro
// no. La posta in arrivo non conosce nessun processore: li riceve.

import type { WebhookProcessor } from './inbox.server';
import type { WebhookTopic } from './inbox-model';
import { handleAppUninstalled } from './handle-uninstall.server';
import { handleSubscriptionUpdate } from './handle-subscription-update.server';

export const WEBHOOK_PROCESSORS: Record<WebhookTopic, WebhookProcessor> = {
  'app/uninstalled': handleAppUninstalled,
  'app_subscriptions/update': handleSubscriptionUpdate,
};
