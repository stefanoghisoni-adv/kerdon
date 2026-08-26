import { useT } from '~/lib/i18n/context';
import { dictionaryForShop } from '~/lib/i18n/server';
import type { Dictionary } from '~/lib/i18n/context';
// app/routes/products.issues.tsx
// Tab dedicata: varianti a cui manca cost_per_item, con campo editabile.
// I valori inseriti restano appunti finche' il merchant non preme "Ricontrolla e
// aggiorna": e' quel pulsante a scriverli su Shopify E su Supabase, a togliere
// dall'elenco le varianti risolte e ad aggiornare il conteggio dei prodotti
// sincronizzabili.
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData, useFetcher } from '@remix-run/react';
import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Card,
  Box,
  IndexTable,
  Banner,
  Text,
  Link,
  TextField,
  InlineStack,
  InlineGrid,
  BlockStack,
  Pagination,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { isAuthorized } from '~/utils/authorization.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import type { ShopifyProduct } from '~/types/shopify';
import type { SupabaseConfig } from '@prisma/client';
import {
  enrichVariantCosts,
  getMissingCostInventoryIds,
} from '~/lib/stats/inventory-cost.server';
import { getReadinessCache, setReadinessCache } from '~/lib/cache/stats-cache.server';
import {
  collectProblemVariants,
  computeProductReadiness,
  type ProblemVariant,
} from '~/lib/stats/product-readiness';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { filterProblemVariants, pageCount, pageSlice } from '~/lib/stats/problem-filter';
import { loadSoldVariantIds } from '~/lib/stats/sold-variants.server';
import {
  costFieldDisabled,
  collectPendingCosts,
  parseStoredCosts,
  costRatioLabel,
} from '~/lib/stats/cost-edit';

const PER_PAGE = 20;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Questa pagina esiste a configurazione conclusa: prima parlerebbe di dati
  // che non ci sono ancora. Chi ci arriva da un indirizzo salvato torna dove
  // il lavoro e' rimasto.
  await requireSetupComplete(session.shop);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response('Shop not found', { status: 404 });
  }

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);

  const allProducts: ShopifyProduct[] = [];
  let pageInfo: string | undefined;
  let error: string | null = null;

  try {
    do {
      const { products, nextPageInfo } = await client.getProducts({
        limit: 250,
        pageInfo,
        fields: 'id,title,variants',
      });
      allProducts.push(...(products ?? []));
      pageInfo = nextPageInfo ?? undefined;
    } while (pageInfo);

    // Popola il costo reale dagli InventoryItem prima di individuare i "problemi".
    await enrichVariantCosts(client, allProducts);
  } catch (err) {
    console.error('[products.issues loader] fetch prodotti fallito:', err);
    error = (await dictionaryForShop(session.shop)).errors.productsFetchFailed;
  }

  const allRows = error ? [] : collectProblemVariants(allProducts);

  // "Solo quelli gia' venduti": ci si arriva dalla tab Clienti, da un cliente
  // il cui profitto e' parziale. Li' la domanda non e' "cosa manca nel
  // catalogo" ma "cosa sta falsando i miei numeri adesso", e sono due elenchi
  // diversi — un prodotto mai ordinato non sporca nessun profitto.
  const soldOnly = new URL(request.url).searchParams.get('sold') === '1';
  const sold = soldOnly ? await loadSoldVariantIds(session.shop) : null;
  const rows = sold ? allRows.filter((row) => sold.has(row.variantId)) : allRows;

  // Quota del piano: serve all'avviso di limite in esaurimento, lo stesso della
  // dashboard. I prodotti sono gia' in memoria, quindi il conteggio non costa
  // una seconda passata su Shopify.
  const plan = await findPlanByName(shop.currentPlan);

  return json({
    rows,
    error,
    shopDomain: shop.shopDomain,
    blocked: !isAuthorized(shop.authorization),
    readyCount: error ? 0 : computeProductReadiness(allProducts).readyCount,
    planLimit: plan?.maxProducts ?? null,
    // Il filtro e' attivo solo se e' stato chiesto E se si e' potuto applicare:
    // senza database collegato la pagina mostra tutto, e dire il contrario
    // farebbe credere che siano quelli i prodotti venduti.
    soldOnly: soldOnly && sold !== null,
    hiddenByFilter: sold ? allRows.length - rows.length : 0,
  });
}

/**
 * Scrive il costo di una variante su Shopify e allinea subito la riga su
 * Supabase, senza attendere la sincronizzazione.
 *
 * Restituisce il messaggio da mostrare al merchant se qualcosa non e' andato, e
 * null se e' filato tutto liscio: qui si sta salvando un elenco, e una riga che
 * fallisce non deve impedire alle altre di essere scritte.
 */
async function applyCost(
  supabaseConfig: SupabaseConfig | null,
  client: ShopifyAPIClient,
  entry: { variantId: number; inventoryItemId: number; cost: string },
  t: Pick<Dictionary, 'errors'>,
): Promise<string | null> {
  const parsed = Number(entry.cost);
  if (!Number.isInteger(entry.inventoryItemId) || entry.inventoryItemId <= 0) {
    return t.errors.variantInvalid;
  }
  if (entry.cost === '' || !Number.isFinite(parsed) || parsed < 0) {
    return t.errors.costInvalid;
  }

  // 1) Shopify (fonte di verità del cost_per_item, sull'InventoryItem)
  try {
    await client.updateInventoryItemCost(entry.inventoryItemId, entry.cost);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    console.error('[products.issues save] update Shopify fallito:', err);
    // 401/403 = permesso mancante: lo scope write_inventory non è stato ancora
    // concesso dal merchant (serve riautorizzare l'app dopo l'aggiunta dello scope).
    const permission = /\b(401|403)\b/.test(msg);
    return permission ? t.errors.costWritePermission : t.errors.costWriteFailed;
  }

  // 2) Supabase (se collegato): allinea subito la riga, senza attendere la sync
  if (supabaseConfig?.connectionVerifiedAt && Number.isInteger(entry.variantId)) {
    try {
      const supabase = createSupabaseClient(supabaseConfig);

      // Il prezzo dalla riga esistente, non dal form: il client non deve poter
      // decidere un valore che finisce in tabella. Se la riga non c'è ancora
      // (prodotto non idoneo, quindi mai sincronizzato) non si aggiorna nulla.
      const { data: existing, error: readError } = await supabase
        .from(supabaseConfig.tableNameProducts)
        .select('price')
        .eq('shopify_variant_id', entry.variantId)
        .maybeSingle();
      if (readError) throw readError;

      if (existing) {
        const price = Number(existing.price);
        const { error: sbError } = await supabase
          .from(supabaseConfig.tableNameProducts)
          .update({
            cost_per_item: parsed,
            net_value: Math.round((price - parsed) * 100) / 100,
          })
          .eq('shopify_variant_id', entry.variantId);
        if (sbError) throw sbError;
      }
    } catch (err) {
      console.error('[products.issues save] update Supabase fallito:', err);
      return t.errors.costHalfSaved;
    }
  }

  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (!shop) {
    return json({ ok: false, error: 'Negozio non trovato.' }, { status: 404 });
  }
  if (!isAuthorized(shop.authorization)) {
    return json(
      { ok: false, error: (await dictionaryForShop(session.shop)).errors.suspended },
      { status: 403 },
    );
  }

  const body = (await request.json()) as {
    intent?: string;
    inventoryItemIds?: number[];
    updates?: { variantId?: number | string; inventoryItemId?: number | string; cost?: string }[];
  };

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);

  if (body.intent !== 'recheck') {
    return json({ ok: false, error: 'Richiesta non riconosciuta.' }, { status: 400 });
  }

  // --- Conferma dei costi inseriti, poi re-check mirato ---
  // I due passaggi stanno insieme di proposito: il merchant preme un pulsante
  // solo, e il conteggio dei prodotti sincronizzabili deve riflettere i costi
  // appena scritti, non quelli di prima.
  const updates = (body.updates ?? []).map((entry) => ({
    variantId: Number(entry.variantId),
    inventoryItemId: Number(entry.inventoryItemId),
    cost: String(entry.cost ?? '').trim().replace(',', '.'),
  }));

  // Il dizionario si legge una volta sola: i messaggi di riga sono tanti quante
  // le varianti, e non ha senso richiederlo per ognuna.
  const t = await dictionaryForShop(session.shop);

  // In sequenza: le API di Shopify hanno un tetto di chiamate al secondo e una
  // raffica parallela si farebbe rifiutare a meta' elenco.
  const failures: { variantId: number; error: string }[] = [];
  for (const entry of updates) {
    const error = await applyCost(shop.supabaseConfig, client, entry, t);
    if (error) failures.push({ variantId: entry.variantId, error });
  }

  const ids = (body.inventoryItemIds ?? [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);

  try {
    const stillProblematic = await getMissingCostInventoryIds(client, ids);

    // Aggiorna SUBITO la cache readiness della Dashboard: ogni variante risolta
    // passa da "problema" a "pronta". Cosi', tornando in Dashboard, il conteggio
    // e' gia' corretto senza attendere il ricalcolo live.
    const resolved = ids.length - stillProblematic.length;
    if (resolved > 0) {
      const cached = await getReadinessCache(shop.id);
      if (cached) {
        await setReadinessCache(shop.id, {
          totalProducts: cached.totalProducts,
          readyCount: cached.readyCount + resolved,
          problemCount: Math.max(0, cached.problemCount - resolved),
        });
      }
    }

    return json({ ok: true, stillProblematic, failures });
  } catch (err) {
    console.error('[products.issues recheck] fallito:', err);
    // I costi salvati prima dell'errore restano salvati: il messaggio parla solo
    // del ricontrollo, e le righe restano in elenco fino al tentativo dopo.
    return json(
      { ok: false, error: t.errors.recheckFailed, failures },
      { status: 502 },
    );
  }
}

function CostRow({
  row,
  index,
  shopDomain,
  disabled,
  value,
  onChangeValue,
  error,
}: {
  row: ProblemVariant;
  index: number;
  shopDomain: string;
  disabled: boolean;
  value: string;
  onChangeValue: (variantId: number, value: string) => void;
  /** Esito dell'ultimo aggiornamento per questa riga, se non e' andato a buon fine. */
  error: string | undefined;
}) {
  return (
    <IndexTable.Row id={String(row.variantId)} position={index}>
      <IndexTable.Cell>
        <Link
          url={`https://${shopDomain}/admin/products/${row.productId}/variants/${row.variantId}`}
          target="_blank"
        >
          {row.productTitle}
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{row.variantTitle}</IndexTable.Cell>
      <IndexTable.Cell>{row.sku ?? '—'}</IndexTable.Cell>
      <IndexTable.Cell>{row.price ?? '—'}</IndexTable.Cell>
      <IndexTable.Cell>
        {/* Nessun salvataggio qui dentro: il valore resta un appunto finche' il
            merchant non preme "Ricontrolla e aggiorna". */}
        <div style={{ maxWidth: 120 }}>
          <TextField
            label="cost_per_item"
            labelHidden
            type="number"
            inputMode="decimal"
            min={0}
            step={0.01}
            value={value}
            onChange={(v) => onChangeValue(row.variantId, v)}
            placeholder="0.00"
            autoComplete="off"
            disabled={disabled}
            error={error}
          />
        </div>
      </IndexTable.Cell>
      {/* Quanto pesa il costo appena digitato sul prezzo di vendita: si aggiorna
          a ogni tasto, cosi' il merchant vede il margine mentre decide invece di
          doverlo calcolare a parte. */}
      <IndexTable.Cell>
        <Text as="span" tone="subdued" numeric>
          {costRatioLabel(value, row.price)}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

export default function ProblemProducts() {
  const t = useT();
  const loaderData = useLoaderData<typeof loader>();
  const { error, shopDomain, blocked, readyCount, planLimit, soldOnly, hiddenByFilter } =
    loaderData;

  const [rows, setRows] = useState<ProblemVariant[]>(loaderData.rows);
  const [values, setValues] = useState<Record<number, string>>({});
  // Messaggio per riga: valore da correggere o salvataggio non riuscito.
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [removedCount, setRemovedCount] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  // I costi digitati sono lavoro del merchant e non sono ancora salvati da
  // nessuna parte: se lascia la tab e torna, deve ritrovarli dove li aveva
  // lasciati. Restano nella sessione del browser finche' non li conferma.
  const storageKey = `problemCosts:${shopDomain}`;
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setValues(parseStoredCosts(sessionStorage.getItem(storageKey)));
    setRestored(true);
  }, [storageKey]);

  useEffect(() => {
    // Prima del recupero i valori sono vuoti per forza: scriverli cancellerebbe
    // quelli messi da parte.
    if (!restored) return;
    if (Object.keys(values).length === 0) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, JSON.stringify(values));
  }, [values, restored, storageKey]);

  const filtered = filterProblemVariants(rows, query);
  const totalPages = pageCount(filtered.length, PER_PAGE);
  const visibleRows = pageSlice(filtered, page, PER_PAGE);

  // Cambiando la ricerca si riparte da pagina 1: restare a pagina 4 su un
  // risultato di 2 pagine mostrerebbe una tabella vuota senza spiegazione.
  useEffect(() => {
    setPage(1);
  }, [query]);

  // Le righe risolte vengono rimosse dall'elenco: se cosi' la pagina corrente
  // resta oltre la fine, si arretra.
  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const recheckFetcher = useFetcher<{
    ok?: boolean;
    stillProblematic?: number[];
    failures?: { variantId: number; error: string }[];
    error?: string;
  }>();
  const updating = recheckFetcher.state !== 'idle';

  const onChangeValue = useCallback((variantId: number, value: string) => {
    setValues((prev) => ({ ...prev, [variantId]: value }));
    setRowErrors((prev) => {
      if (prev[variantId] === undefined) return prev;
      const next = { ...prev };
      delete next[variantId];
      return next;
    });
  }, []);

  // Il pulsante e' attivo quando c'e' almeno un costo da confermare.
  const hasChanges = Object.values(values).some((v) => v.trim() !== '');

  // Un solo passaggio: scrive i costi inseriti e poi ricontrolla l'elenco. E'
  // qui che i valori diventano definitivi — prima di questo clic non tocca
  // niente ne' su Shopify ne' sul conteggio dei prodotti sincronizzabili.
  const runRecheck = () => {
    const { updates, rejected } = collectPendingCosts(rows, values);

    if (rejected.length > 0) {
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const item of rejected) {
          next[item.variantId] =
            item.reason === 'invalid'
              ? t.issues.rowError.invalid
              : t.issues.rowError.noInventoryItem;
        }
        return next;
      });
      setFormError(t.issues.fixHighlighted);
      return;
    }

    setFormError(null);
    setRowErrors({});
    setRemovedCount(0);
    const inventoryItemIds = rows
      .map((r) => r.inventoryItemId)
      .filter((x): x is number => x != null);
    recheckFetcher.submit(
      { intent: 'recheck', inventoryItemIds, updates },
      { method: 'post', encType: 'application/json' },
    );
  };

  // Esito: le varianti risolte spariscono dalla tabella (e il conteggio in
  // Dashboard si aggiorna al ritorno). Restano quelle ancora senza costo e
  // quelle il cui salvataggio non e' riuscito, con il valore digitato al suo
  // posto, cosi' il merchant puo' riprovare.
  useEffect(() => {
    const data = recheckFetcher.data;
    if (!data) return;

    const failures = data.failures ?? [];
    if (failures.length > 0) {
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const failure of failures) next[failure.variantId] = failure.error;
        return next;
      });
    }

    if (!data.ok || !data.stillProblematic) return;
    const still = new Set(data.stillProblematic);
    const failed = new Set(failures.map((f) => f.variantId));
    setRows((prev) => {
      const kept = prev.filter(
        (r) =>
          r.inventoryItemId == null ||
          still.has(r.inventoryItemId) ||
          failed.has(r.variantId),
      );
      setRemovedCount(prev.length - kept.length);
      const keptIds = new Set(kept.map((r) => r.variantId));
      // Ripulisci i valori delle righe rimosse: sono ormai su Shopify.
      setValues((v) => {
        const next: Record<number, string> = {};
        for (const id of keptIds) if (v[id] !== undefined) next[id] = v[id];
        return next;
      });
      return kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckFetcher.data]);

  return (
    <Page
      fullWidth
      title={t.issues.title}
      backAction={{ url: '/' }}
      primaryAction={{
        content: t.issues.recheck,
        onAction: runRecheck,
        loading: updating,
        disabled: !hasChanges || blocked,
      }}
    >
      <BlockStack gap="400">
        <ProductOverflowBanner disabled={blocked} />

        {error && <Banner tone="critical">{error}</Banner>}

        {/* Si arriva qui da un cliente col profitto parziale, e l'elenco e' gia'
            ristretto ai prodotti che lo riguardano. Va detto: un elenco piu'
            corto del previsto, senza spiegazione, si legge come un elenco
            incompleto. Il link toglie il filtro senza far cercare come. */}
        {soldOnly && (
          <Banner tone="info">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Text as="span">{t.issues.soldOnly(hiddenByFilter)}</Text>
              <Link url="/products/issues" removeUnderline>
                {t.issues.showAll}
              </Link>
            </InlineStack>
          </Banner>
        )}

        {blocked && !error && (
          <Banner tone="warning">{t.issues.suspended}</Banner>
        )}

        {formError && (
          <Banner tone="critical" onDismiss={() => setFormError(null)}>
            {formError}
          </Banner>
        )}

        {recheckFetcher.data?.ok === false && (
          <Banner tone="critical">{recheckFetcher.data.error}</Banner>
        )}

        {/* I costi scritti su Shopify sono definitivi: se qualcuno non e'
            passato va detto, altrimenti il merchant crede di aver finito. */}
        {(recheckFetcher.data?.failures?.length ?? 0) > 0 && (
          <Banner tone="warning">{t.issues.someFailed}</Banner>
        )}

        {removedCount > 0 && (
          <Banner tone="success" onDismiss={() => setRemovedCount(0)}>
            {t.issues.resolved(removedCount)}
          </Banner>
        )}

        {!error && rows.length === 0 && (
          <Banner tone="success">
            {t.issues.allGood} <code>cost_per_item</code>.
          </Banner>
        )}

        {rows.length > 0 && (
          <Card padding="0">
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {t.issues.listTitle}
                </Text>
                {/* Descrizione e ricerca affiancate a meta' larghezza ciascuna:
                    la ricerca finisce a destra senza doverla dimensionare a mano.
                    alignItems="center" le allinea sull'asse verticale, altrimenti
                    il testo si appoggerebbe in cima al campo. */}
                <InlineGrid columns={2} gap="400" alignItems="center">
                  {/* Con una ricerca senza risultati la tabella resta vuota: senza
                      questa riga sembrerebbe che i problemi siano finiti, mentre
                      e' solo la ricerca a non aver trovato nulla. */}
                  {query.trim() && filtered.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {t.issues.noResults(query.trim(), rows.length)}
                    </Text>
                  ) : (
                    <Text as="p" tone="subdued">
                      {t.issues.intro.before}
                      <code>cost_per_item</code>
                      {t.issues.intro.after}
                    </Text>
                  )}
                  {/* Tre quarti della colonna, allineata a destra: a piena
                      larghezza il campo pesava come la descrizione accanto, e
                      una ricerca non e' il contenuto principale della card. */}
                  <InlineStack align="end">
                    <Box width="75%">
                      <TextField
                        label={t.issues.search}
                        labelHidden
                        value={query}
                        onChange={setQuery}
                        autoComplete="off"
                        placeholder={t.issues.searchPlaceholder}
                        clearButton
                        onClearButtonClick={() => setQuery('')}
                      />
                    </Box>
                  </InlineStack>
                </InlineGrid>
              </BlockStack>
            </Box>
            <IndexTable
              resourceName={t.issues.resource}
              itemCount={visibleRows.length}
              selectable={false}
              headings={[
                { title: t.issues.columns.product },
                { title: t.issues.columns.variant },
                { title: t.issues.columns.sku },
                { title: t.issues.columns.price },
                { title: 'cost_per_item' },
                { title: '%' },
              ]}
            >
              {visibleRows.map((r, i) => (
                <CostRow
                  key={r.variantId}
                  row={r}
                  index={i}
                  shopDomain={shopDomain}
                  disabled={costFieldDisabled({ updating, blocked })}
                  value={values[r.variantId] ?? ''}
                  onChangeValue={onChangeValue}
                  error={rowErrors[r.variantId]}
                />
              ))}
            </IndexTable>
            {totalPages > 1 && (
              <Box padding="400">
                {/* Numeri fuori dalle frecce, a destra: la label integrata di
                    Pagination starebbe in mezzo ai due pulsanti, qui invece la
                    rendiamo come Text accanto al gruppo di frecce. */}
                <InlineStack align="center" blockAlign="center" gap="300">
                  <Pagination
                    hasPrevious={page > 1}
                    onPrevious={() => setPage((p) => p - 1)}
                    hasNext={page < totalPages}
                    onNext={() => setPage((p) => p + 1)}
                  />
                  <Text as="span" tone="subdued">
                    {t.issues.pageOf(page, totalPages)}
                  </Text>
                </InlineStack>
              </Box>
            )}
          </Card>
        )}
        {/* Respiro in fondo: senza, il bordo della card/tabella tocca il fondo dell'iframe. */}
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
