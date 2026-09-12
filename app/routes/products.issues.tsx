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
import { useLoaderData, useFetcher, useNavigate } from '@remix-run/react';
import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Card,
  Box,
  Button,
  ButtonGroup,
  Tag,
  IndexTable,
  Banner,
  Text,
  Link,
  TextField,
  InlineStack,
  InlineGrid,
  BlockStack,
  Modal,
  Pagination,
} from '@shopify/polaris';
import { PlanChangeBanner } from '~/components/Dashboard/PlanChangeBanner';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import type { ShopifyProduct } from '~/types/shopify';
import type { SupabaseConfig } from '@prisma/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  costScopeEffect,
  costToFreeze,
  isCostScope,
  type CostScope,
} from '~/lib/products/cost-scope';
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
import { filterProblemVariants } from '~/lib/stats/problem-filter';
import { PER_PAGE, pageCount, pageSlice } from '~/lib/table/pagination';
import { TablePagination } from '~/components/Dashboard/TablePagination';
import {
  selectSoldProblemVariants,
  soldVariantsMissingFromCatalog,
} from '~/lib/stats/sold-without-cost';
import { useFilterNav } from '~/components/Dashboard/filter-nav';
import { loadSoldVariantIds } from '~/lib/stats/sold-variants.server';
import {
  costFieldDisabled,
  collectPendingCosts,
  parseStoredCosts,
  costRatioLabel,
} from '~/lib/stats/cost-edit';
import {
  requireShopCapability,
  shopCapabilityOutcome,
} from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // IL CANCELLO, PRIMA DI PARLARE CON SHOPIFY.
  //
  // Qui sotto si legge il catalogo intero, pagina per pagina, con i costi di
  // ogni variante. Fino a ieri il permesso si chiedeva DOPO — serviva solo a
  // spegnere i campi a schermo — e il catalogo era gia' stato letto e spedito
  // al browser di un negozio che l'app non puo' piu' usare. Un campo spento
  // non e' un dato negato.
  //
  // Rifiuto come ritorno alla dashboard, come per i clienti: e' li' che il
  // merchant legge che cosa e' successo e che cosa puo' fare.
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });

  // Questa pagina esiste a configurazione conclusa: prima parlerebbe di dati
  // che non ci sono ancora. Chi ci arriva da un indirizzo salvato torna dove
  // il lavoro e' rimasto.
  await requireSetupComplete(session.shop);

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

  // Due filtri che si sommano.
  //
  // "Solo prodotti negli ordini": un prodotto senza costo che nessuno ha mai
  // ordinato non sporca nessun profitto, mentre uno che compare in venti ordini
  // sta rendendo parziale il profitto di venti clienti adesso.
  //
  // E il singolo cliente, per chi arriva dalla tab Clienti premendo "Risolvi
  // problemi": li' la domanda non e' nemmeno "cosa sta falsando i miei numeri"
  // ma "cosa sta falsando i numeri di QUESTO cliente", ed e' un elenco ancora
  // piu' corto.
  const params = new URL(request.url).searchParams;
  const askedCustomer = Number(params.get('customer'));
  const customerId = Number.isSafeInteger(askedCustomer) && askedCustomer > 0
    ? askedCustomer
    : null;
  const soldOnly = params.get('sold') === '1' || customerId != null;

  const sold = soldOnly
    ? await loadSoldVariantIds(session.shop, { customerId })
    : { ids: null, customerName: null };

  // La stessa funzione che il conteggio dell'avviso usa per contare: e' cio'
  // che impedisce all'avviso e a questo elenco di tornare a dire numeri diversi.
  const rows = selectSoldProblemVariants(allRows, sold.ids);

  // Quota del piano: serve all'avviso di limite in esaurimento, lo stesso della
  // dashboard. I prodotti sono gia' in memoria, quindi il conteggio non costa
  // una seconda passata su Shopify.
  const plan = await findPlanByName(shop.currentPlan);

  return json({
    rows,
    error,
    shopDomain: shop.shopDomain,
    // Sempre false da quando il cancello sta in cima: chi arriva qui il
    // permesso ce l'ha. Resta nel payload perche' i componenti sotto lo
    // leggono, e toglierlo vorrebbe dire riscrivere la pagina per una
    // costante.
    blocked: false,
    readyCount: error ? 0 : computeProductReadiness(allProducts).readyCount,
    planLimit: plan?.maxProducts ?? null,
    // Il filtro e' attivo solo se e' stato chiesto E se si e' potuto applicare:
    // senza database collegato la pagina mostra tutto, e dire il contrario
    // farebbe credere che siano quelli i prodotti venduti.
    soldOnly: soldOnly && sold.ids !== null,
    // Vendute ma non piu' nel catalogo: l'unica differenza che puo' restare fra
    // il numero annunciato e le righe mostrate, e va detta invece che subita.
    soldMissingFromCatalog: error
      ? 0
      : soldVariantsMissingFromCatalog(allProducts, sold.ids),
    hiddenByFilter: sold.ids ? allRows.length - rows.length : 0,
    // L'etichetta del cliente si mostra solo se si e' potuto leggerne il nome:
    // un'etichetta senza nome non dice a chi si riferisce.
    customerId: sold.customerName ? customerId : null,
    customerName: sold.customerName,
  });
}

/**
 * Applica alle righe d'ordine gia' scritte la scelta del merchant.
 *
 * COSA FA `future`. Chiude il conto: ogni riga di quella variante che non era
 * ancora stata fissata si tiene il costo con cui e' stata calcolata finora —
 * che qui, dove i costi si inseriscono la prima volta, di solito e' nessuno. E
 * "nessuno" e' un esito, non un buco da riempire: quelle vendite sono sempre
 * state senza costo, restano senza, e continuano a non entrare nel profitto
 * invece di ereditare un valore deciso mesi dopo.
 *
 * Non si scrive MAI il costo nuovo sulle righe vecchie. Sarebbe il modo piu'
 * comodo di far quadrare tutto e sarebbe una bugia: il costo di allora non lo
 * sa nessuno, Shopify compreso — `InventoryItem.unitCost` e' solo l'attuale.
 *
 * COSA FA `all`. Riapre il conto: le righe tornano a seguire il costo corrente,
 * cioe' il comportamento che c'e' sempre stato. Serve, ed e' la scelta giusta
 * quando il costo di prima era semplicemente sbagliato e il merchant vuole i
 * suoi conti rifatti per bene.
 *
 * Best effort di proposito: se questa scrittura non riesce, il costo su Shopify
 * e' comunque quello nuovo e i conti tornano al comportamento di sempre. E'
 * meno di quel che il merchant ha chiesto, ma non e' un dato perso — e far
 * fallire l'intero salvataggio per questo gli lascerebbe il costo vecchio, che
 * e' peggio.
 */
async function applyCostScope(
  supabase: SupabaseClient,
  variantId: number,
  previousCost: unknown,
  scope: CostScope,
): Promise<void> {
  const effetto = costScopeEffect(scope);

  try {
    if (effetto.freezeExisting) {
      const { error } = await supabase
        .from('order_lines')
        .update({
          unit_cost_at_sale: costToFreeze(previousCost),
          unit_cost_frozen_at: new Date().toISOString(),
        })
        .eq('shopify_variant_id', variantId)
        // Solo le righe non ancora fissate: una riga gia' chiusa da una
        // modifica precedente porta il costo di ALLORA, e riscriverlo adesso
        // vorrebbe dire spostarle il passato a ogni correzione successiva.
        .is('unit_cost_frozen_at', null);
      if (error) throw error;
      return;
    }

    if (effetto.clearFrozen) {
      const { error } = await supabase
        .from('order_lines')
        .update({ unit_cost_at_sale: null, unit_cost_frozen_at: null })
        .eq('shopify_variant_id', variantId);
      if (error) throw error;
    }
  } catch (err) {
    console.warn(
      `[products.issues save] estensione della modifica di costo non applicata (variante ${variantId}):`,
      err instanceof Error ? err.message : err,
    );
  }
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
  // Fin dove arriva questa modifica. Non ha un valore predefinito: chi chiama
  // l'ha gia' chiesto al merchant, perche' decidere al posto suo cosa succede
  // ai numeri che ha gia' letto e' precisamente la cosa da non fare.
  scope: CostScope,
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
      //
      // Con il prezzo si legge anche il costo di PRIMA, e si legge adesso
      // perche' fra un attimo non ci sara' piu': e' il valore con cui gli
      // ordini gia' registrati sono stati calcolati fino a questo istante, e
      // l'unico che si possa fermare senza inventare niente.
      const { data: existing, error: readError } = await supabase
        .from(supabaseConfig.tableNameProducts)
        .select('price, cost_per_item')
        .eq('shopify_variant_id', entry.variantId)
        .maybeSingle();
      if (readError) throw readError;

      await applyCostScope(supabase, entry.variantId, existing?.cost_per_item, scope);

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
  // Il rifiuto si restituisce e non si solleva: lo legge il fetcher che ha
  // mandato i costi da salvare, e la pagina resta dov'e' invece di lasciare il
  // posto alla schermata d'errore.
  const cancello = await shopCapabilityOutcome(request, 'use_app');
  if (!cancello.ok) return json({ ok: false, error: cancello.message }, { status: 403 });
  const { session, shop } = cancello.grant;

  const body = (await request.json()) as {
    intent?: string;
    inventoryItemIds?: number[];
    updates?: { variantId?: number | string; inventoryItemId?: number | string; cost?: string }[];
    costScope?: string;
  };

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);

  if (body.intent !== 'recheck') {
    return json({ ok: false, error: 'Richiesta non riconosciuta.' }, { status: 400 });
  }

  // Fin dove arriva la modifica: sul passato o solo da adesso.
  //
  // Senza una scelta riconoscibile non si scrive niente, e non e' pignoleria.
  // Un valore predefinito qui vorrebbe dire decidere al posto del merchant se i
  // profitti che ha gia' letto — e magari esportato, o usato per decidere —
  // debbano riscriversi da soli. E' una domanda a cui deve rispondere lui, ed
  // e' l'unica ragione per cui esiste il dialogo che gliela fa.
  const scope = body.costScope;
  if ((body.updates ?? []).length > 0 && !isCostScope(scope)) {
    return json(
      { ok: false, error: (await dictionaryForShop(session.shop)).errors.costScopeMissing },
      { status: 400 },
    );
  }
  const costScope: CostScope = isCostScope(scope) ? scope : 'all';

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
    const error = await applyCost(shop.supabaseConfig, client, entry, t, costScope);
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
        // `soldWithoutCost` resta deliberatamente fuori: di quelle varianti
        // risolte non sappiamo quali fossero gia' state vendute, e tramandare il
        // numero di prima significherebbe rimandare il merchant in dashboard con
        // un avviso che annuncia problemi appena sistemati. Omesso, l'avviso non
        // compare finche' il ricalcolo live non dice quanti ne restano.
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
  // Serve solo per l'etichetta del campo, che e' nascosta e vive per chi legge
  // con un lettore di schermo: senza, quella persona sente il nome del campo API
  // invece di quello che tutti gli altri vedono in cima alla colonna.
  const t = useT();

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
            label={t.issues.columns.cost}
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
  const {
    error,
    shopDomain,
    blocked,
    readyCount,
    planLimit,
    soldOnly,
    soldMissingFromCatalog,
    hiddenByFilter,
    customerId,
    customerName,
  } = loaderData;
  const navigate = useNavigate();

  // Il filtro premuto mostra il suo caricamento, e nel frattempo nessuno dei
  // due si puo' premere. La lettura non e' istantanea — l'elenco si ricostruisce
  // dai prodotti di Shopify — e senza un segno il primo clic sembra non aver
  // fatto niente, cosi' si preme di nuovo.
  //
  // Ma il segno deve accendersi solo per chi ha premuto qui: la sola
  // `useNavigation` non distingue un filtro premuto dal merchant che sta
  // uscendo dalla tab col menu dell'admin, e li' i filtri si spegnevano da soli
  // mentre si stava gia' andando altrove.
  const filterNav = useFilterNav('/products/issues');
  const { switching, loadingAll, loadingSold } = filterNav;

  // I filtri stanno nell'indirizzo e non in uno stato: cosi' l'elenco che si
  // sta guardando ha un link, e tornare indietro col browser riporta al filtro
  // di prima invece che alla pagina intera.
  const goTo = (next: { sold?: boolean; customer?: number | null }) => {
    // Il consenso di chi il clic l'ha ricevuto davvero: da qui in poi la
    // navigazione che parte e' di questi filtri, e loro possono mostrarlo.
    filterNav.start();
    const params = new URLSearchParams();
    // Il cliente implica gia' "solo negli ordini": tenere anche il primo
    // parametro non cambierebbe niente e allungherebbe l'indirizzo.
    if (next.customer) params.set('customer', String(next.customer));
    else if (next.sold) params.set('sold', '1');
    const query = params.toString();
    navigate(query ? `/products/issues?${query}` : '/products/issues');
  };

  // L'elenco vive in uno stato perche' salvando un costo la riga risolta se ne
  // va senza ricaricare la pagina. Ma il valore iniziale di useState vale solo
  // al primo montaggio: passando da ?sold=1 all'elenco completo Remix rilegge il
  // loader senza rimontare il componente, e restavano a schermo le righe
  // filtrate — il banner spariva e sotto non cambiava niente. Qui lo stato
  // segue il loader ogni volta che porta righe nuove.
  const [rows, setRows] = useState<ProblemVariant[]>(loaderData.rows);
  useEffect(() => {
    setRows(loaderData.rows);
  }, [loaderData.rows]);
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
  const runRecheck = (costScope: CostScope) => {
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
      { intent: 'recheck', inventoryItemIds, updates, costScope },
      { method: 'post', encType: 'application/json' },
    );
  };

  /**
   * La domanda prima di scrivere: fin dove arriva questo costo.
   *
   * Perche' si chiede invece di decidere. Il costo si legge dai prodotti nel
   * momento in cui si guarda, quindi scriverne uno oggi riscrive anche il
   * profitto degli ordini di sei mesi fa — numeri che il merchant ha gia'
   * letto, magari esportati, magari usati per decidere un prezzo. Finora
   * succedeva e basta, senza che nessuno lo dicesse. Non e' una cosa che si
   * possa scegliere al posto suo: a volte e' proprio quel che vuole (il costo
   * di prima era sbagliato), a volte e' l'ultima cosa che vuole.
   *
   * Il dialogo non ha un'opzione preselezionata: sceglie premendo, e le due
   * risposte sono due pulsanti con scritto cosa fanno.
   */
  const [costScopeOpen, setCostScopeOpen] = useState(false);

  const askCostScope = () => {
    // Le righe rifiutate si vedono subito, senza passare dal dialogo: chiedere
    // "fin dove?" per poi rispondere "il valore non e' valido" farebbe fare due
    // giri per un errore che si vedeva gia' al primo.
    const { rejected } = collectPendingCosts(rows, values);
    if (rejected.length > 0) {
      runRecheck('all');
      return;
    }
    setCostScopeOpen(true);
  };

  const chooseCostScope = (scope: CostScope) => {
    setCostScopeOpen(false);
    runRecheck(scope);
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
    >
      <BlockStack gap="400">
        {/* Il cambio di piano si legge da ogni tab, non solo da dove e' stato
            fatto: chi lo cambia e va dritto qui deve sapere lo stesso cosa e'
            cambiato. Il contenuto lo calcola la dashboard e lo lascia nel
            sessionStorage; se non c'e' niente da dire, questo non rende nulla. */}
        <PlanChangeBanner />

        <ProductOverflowBanner disabled={blocked} />

        {error && <Banner tone="critical">{error}</Banner>}

        {/* I filtri, sopra la tabella e allineati a sinistra: si leggono prima
            dell'elenco che governano, non dopo.

            L'etichetta del cliente sta accanto e non dentro i due filtri
            perche' e' un'altra cosa: quelli scelgono FRA due elenchi, questa
            ne restringe uno. Togliendola resta il filtro che c'era sotto. */}
        {!error && (
          <InlineStack gap="200" blockAlign="center" align="space-between" wrap>
            <InlineStack gap="200" blockAlign="center" wrap>
              <ButtonGroup variant="segmented">
              <Button
                pressed={!soldOnly}
                loading={loadingAll}
                disabled={switching}
                onClick={() => goTo({ sold: false })}
              >
                {t.issues.filterAll}
              </Button>
              {/* Premuto anche con l'etichetta del cliente: quella restringe
                  questo filtro, non ne apre un terzo. Vederlo spento mentre si
                  guarda un elenco di soli prodotti venduti faceva credere di
                  stare su "Tutti". */}
              <Button
                pressed={soldOnly}
                loading={loadingSold}
                disabled={switching}
                onClick={() => goTo({ sold: true })}
              >
                {t.issues.filterSold}
              </Button>
            </ButtonGroup>

            {customerId && customerName && (
              <Tag onRemove={() => goTo({ sold: true })}>{customerName}</Tag>
            )}

              {soldOnly && hiddenByFilter > 0 && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.issues.hiddenCount(hiddenByFilter)}
                </Text>
              )}
            </InlineStack>

            {/* Il comando scende dalla barra del titolo alla riga dei filtri,
                all'estremita' opposta: e' la stessa riga in cui si decide cosa
                guardare, ed e' li' che si finisce di lavorare — dopo aver
                compilato i costi, non prima di scegliere il filtro. In alto
                restava lontano dal punto in cui il lavoro si conclude. */}
            <Button
              variant="primary"
              onClick={askCostScope}
              loading={updating}
              disabled={!hasChanges || blocked}
            >
              {t.issues.recheck}
            </Button>
          </InlineStack>
        )}

        {/* La domanda che prima nessuno faceva: fin dove arriva il costo
            appena scritto. Le due risposte sono due pulsanti, e ognuno dice
            cosa fa — non c'e' niente di preselezionato, perche' l'una e l'altra
            portano a due verita' diverse sui numeri gia' letti. */}
        <Modal
          open={costScopeOpen}
          onClose={() => setCostScopeOpen(false)}
          title={t.costScope.title}
          primaryAction={{
            content: t.costScope.futureAction,
            onAction: () => chooseCostScope('future'),
          }}
          secondaryActions={[
            {
              content: t.costScope.allAction,
              onAction: () => chooseCostScope('all'),
            },
            { content: t.costScope.cancel, onAction: () => setCostScopeOpen(false) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p">{t.costScope.intro}</Text>
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  {t.costScope.futureAction}
                </Text>
                {' — '}
                {t.costScope.futureBody}
              </Text>
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  {t.costScope.allAction}
                </Text>
                {' — '}
                {t.costScope.allBody}
              </Text>
              {/* Il limite, detto invece che nascosto: per gli ordini gia'
                  registrati il costo di allora non esiste da nessuna parte, e
                  fingere di conoscerlo sarebbe il modo piu' comodo di far
                  quadrare i conti. */}
              <Text as="p" tone="subdued">
                {t.costScope.noHistory}
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>

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
            {t.issues.allGood}
          </Banner>
        )}

        {/* Fra i filtri e la tabella: e' li' che ci si accorge che i numeri non
            tornano, ed e' li' che va spiegato perche'. Solo quando il filtro
            delle vendite e' attivo — altrove non si sta confrontando niente. */}
        {soldOnly && soldMissingFromCatalog > 0 && (
          <Banner tone="info">
            {t.issues.soldMissingFromCatalog(soldMissingFromCatalog)}
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
                      {t.issues.intro}
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
            {/* Vedi il gemello nella tab Clienti: le larghezze stanno in
                `dashboard.css`, nell'ordine delle intestazioni qui sotto. */}
            <div className="stable-columns stable-columns--issues">
            <IndexTable
              resourceName={t.issues.resource}
              itemCount={visibleRows.length}
              selectable={false}
              headings={[
                { title: t.issues.columns.product },
                { title: t.issues.columns.variant },
                { title: t.issues.columns.sku },
                { title: t.issues.columns.price },
                { title: t.issues.columns.cost },
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
            </div>
            <TablePagination total={filtered.length} page={page} onPage={setPage} />
          </Card>
        )}
        {/* Respiro in fondo: senza, il bordo della card/tabella tocca il fondo dell'iframe. */}
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
