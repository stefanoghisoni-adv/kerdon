import type { it } from "./it";

/**
 * I testi dell'app in inglese.
 *
 * Il tipo e' quello dell'italiano: una voce aggiunta di la' e non qui non
 * compila. Non e' pedanteria — una chiave che manca si vedrebbe a schermo come
 * uno spazio vuoto, e solo nella lingua che nessuno di noi due usa ogni giorno.
 */
export const en: typeof it = {
  common: {
    confirm: "Confirm",
    cancel: "Cancel",
    dashboard: "Dashboard",
    settings: "Settings",
    plan: "Plan",
    logs: "Logs",
    productIssues: "Products not eligible",
    never: "Never",
    notSet: "—",
    active: "Active",
    inactive: "Not active",
    connected: "Connected",
    notConnected: "Not connected",
  },

  nav: {
    /** L'unica voce di menu finche' la configurazione e' aperta. */
    configuration: "Configuration",
  },

  language: {
    label: "Language/currency",
    languageColumn: "Language",
    currency: "Currency",
    searchPlaceholder: "Search for a language…",
    translating: "Give it a moment while the translation finishes…",
    saving: "Saving…",
  },

  settings: {
    title: "Settings",
    noProject: {
      before: "No Supabase project connected. Go to the",
      link: "Dashboard",
      after: "to connect your database.",
    },
    missingReadKey:
      "Read key unavailable: tracking cannot read your data. Write to us and we will put it back in place.",
    missingProxyUrl:
      "Read address unavailable: the app domain is not configured. Contact support before setting up tracking.",
  },

  account: {
    title: "Account",
    plan: "Plan",
    productsSync: "Product sync",
    customersSync: "Customer sync",
    productFeeds: "Product feeds",
    upgradeTo: (planName: string) => `Upgrade to ${planName}`,
  },

  database: {
    name: "Database name",
    title: "Database",
    status: "Status",
    appUrl: "App URL",
    readKey: "Publishable API key",
    notConfigured: "Not configured",
    ownerUrl: "Your database URL",
    open: "Open database",
    copy: "Copy",
    copied: "Copied!",
  },

  logs: {
    title: "Logs",
    nextSync: (countdown: string) => `Next sync in ${countdown}`,
    status: { completed: "Completed", failed: "Failed", running: "Running" },
    tableCreated: "Database tables created",
    unknownError: "Unknown error",
    missingCustomersTable: "No customers table was found",
    missingProductsTable: "No products table was found",
    columns: {
      state: "Status",
      description: "Description",
      date: "Date",
      details: "",
    },
    seeDetails: "See details",
    empty: "No sync recorded yet.",
    logTitle: "Sync log",
    noActivity: "No activity recorded",
    dateTime: "Date and time",
    detailsColumn: "Details",
    summaryAdded: (n: number) => `${n} added`,
    summaryRemoved: (n: number) => `${n} removed`,
    summaryUpdated: (n: number) => `${n} updated`,
    summarySuspended: (n: number) => `${n} suspended`,
    partialList: "Partial list: showing the first 500 entries.",
    details: {
      title: "Sync detail",
      close: "Close",
      products: "Products",
      customers: "Customers",
      loadFailed: "The details of this sync could not be loaded.",
      none: "No detail recorded for this sync.",
      noCustomers: "No customer changed in this sync.",
      customersElsewhere:
        "The list of individual customers stays in your database: here you get the totals.",
      action: "Action",
      name: "Name",
      shopifyId: "Shopify ID",
      added: "Added",
      removed: "Removed",
      updated: "Updated",
      suspended: "Suspended",
      truncated: (shown: number, total: number) =>
        `Showing ${shown} of ${total} rows.`,
    },
  },

  steps: {
    badge: { complete: "Completed", active: "In progress", locked: "Locked" },
    connectAccount: {
      title: "Connect Supabase",
      complete: "Completed",
      notConnected: "Not connected",
      failed: "Failed",
      inProgress: "In progress",
    },
    connectDatabase: {
      title: "Create or connect a database",
      complete: "Completed",
      locked: "Sign in to Supabase to pick the database to connect.",
    },
    trackingCheck: {
      title: "Channels and theme check",
      complete: "Completed",
      locked: "Connect a database to check what already sends data.",
    },
    plan: {
      choose: "Choose your plan",
      confirm: "Confirm your plan",
      locked: "Answer the question above to choose your plan.",
    },
  },

  connect: {
    account: {
      intro:
        "Sign in to Supabase or create a new account. Right after signing in you will be asked to accept the integration and, from there, you can select or create a database to connect.",
      connect: "Connect Supabase",
      retry: "I created the database",
      failed: "Could not connect to Supabase. Try again.",
      popupsBlocked: "Allow pop-ups to connect Supabase.",
      connectedWith: (email: string) => `Account connected with ${email}.`,
      connectedRow: "Account connected with",
      noEmail: "—",
      connectedNoEmail: "Account connected.",
      loadingEmail: "Loading the email connected to the account",
      windowTitle: "Finish signing in from the Supabase window",
      windowBody:
        "If Supabase asks you to create the account or the organisation first, complete that step: the authorisation request stays behind and needs reopening. This page updates itself as soon as you are signed in.",
      reopen: "Reopen the authorisation page",
      almostTitle: "One step left",
      almostBody:
        "If you have just created the account or the database on Supabase, the connection still needs accepting: it is one click, in the Supabase window.",
    },
    database: {
      label: "Database",
      placeholder: "Select a database…",
      loading: "Loading the databases in your account…",
      none: "No database found in your Supabase account. You can create one below.",
      create: "Create new database",
      newName: "Name of the new database",
      region: "Region",
      regionPlaceholder: "Select a region…",
      regionsLoading: "Loading regions…",
      creating: "Creating the database… (this can take 1-2 minutes)",
      disconnectTitle: "Disconnect Supabase?",
      deleteData: "Delete tables and data",
      keepData: "Keep the data",
      disconnectBody: {
        before: "You can ",
        delete: "delete",
        middle:
          " the tables and the synced data from your Supabase project, or ",
        keep: "keep them",
        after: " (only the sync stops). Either way the connection is removed.",
      },
      typeName: "Type the project name below",
      typeNameHelp: "Deletion only starts if the name matches.",
      projectName: "Project name",
      syncDisabled: "Sync disabled.",
      syncSuspended: "Sync suspended.",
      limitKnown: (plan: string) =>
        `You have reached the maximum number of databases allowed by your ${plan} plan.`,
      limitUnknown:
        "You have reached the maximum number of databases allowed by your Supabase plan.",
      limitBefore: "",
      limitUpgradeLink: "Upgrade your plan now",
      limitUpgradePlain: "Upgrade your plan",
      limitAfter: " on Supabase to create more databases.",
      connectedTo: "Database connected:",
      limitReached:
        "You’ve reached the maximum number of databases for your Supabase plan.",
      deleteProject: "Delete a database",
      deleteTitle: "Delete a database?",
      deleteIntro:
        "Permanently deletes a database you’re not using, with everything in it. The connected database isn’t listed: to remove that one, disconnect it first.",
      deleteChoose: "Which database",
      deleteNone: "You have no other databases to delete.",
      deleteTypeName: "To confirm, type the database name:",
      deleteConfirm: "Delete permanently",
      inUse: "In use",
      deleteConfirmTitle: "Sure you want to continue?",
      deleteConfirmBody: (n: number) =>
        n === 1
          ? "The database and everything in it will be permanently deleted. This can’t be undone."
          : `The ${n} databases and everything in them will be permanently deleted. This can’t be undone.`,
      deleteProceed: "Continue and delete",
      manage: "Manage",
      change: "Change database",
      disconnect: "Disconnect",
    },
  },

  tracking: {
    checking:
      "Checking whether any sales channel or code snippet in your theme sends data to the platforms",
    checkingLabel: "Checking",
    nothingFound:
      "I found no sales channel and no theme code sending events to the platforms.",
    partialNote:
      "Custom pixels added under Settings → Customer events stay outside this check: those are worth a look by hand.",
    conflicts: {
      title: "Other event sources on this store",
      intro:
        "Every conversion should be sent once. If one of these sends the same events you send, purchases and value get counted twice and your campaigns get optimised on inflated numbers.",
      channelHarmless: "Only handles shop and catalogues",
      codeHarmless: "Ignore this",
      uninstall: "Uninstall",
      removeSnippet: "Remove snippet",
      declaredChannel: "This app does not do any tracking",
      declaredCode: "This code does not do any tracking",
      incomplete:
        "This list may not be complete: custom pixels added under Settings → Customer events are not visible from here. They are worth checking alongside these.",
    },
    serverSide: {
      intro:
        "Server-side tracking sends conversions from the server rather than the browser: they arrive even when the browser blocks them, and with the catalogue and customer data this app keeps in sync they become attributable and measurable. Tell us which platforms you collect data for.",
      needs: "I need a server-side infrastructure",
      has: "I already have a server-side setup",
      receivedTitle: "Request received",
      receivedBody:
        "We will get back to you with a proposal for the platforms you picked.",
      hasBody:
        "You told us you already have a server-side setup. If anything changes, write to us any time.",
      failed: "Could not record your answer. Try again.",
      categories: {
        social: "Social & Browser",
        email: "Email",
        crm: "CRM",
        analytics: "Analytics",
      },
    },
  },

  planStep: {
    introChoose:
      "Your plan sets how many products come in and how often they refresh.",
    introConfirm:
      "Confirm your active plan, or pick another one: the sync starts right after.",
    monthly: "Monthly",
    yearly: "Yearly",
    yearlyHint: (amount: string) =>
      `Going yearly saves you up to ${amount} a year`,
    saving: (amount: string) => `You save ${amount}`,
    current: "Current",
    recommended: "Recommended",
    free: "Free",
    perMonth: (price: string) => `${price}/month`,
    perYear: (price: string) => `${price}/year`,
    yourPlan: "Your plan:",
    confirmAndSync: "Confirm and sync",
    syncing:
      "Sync running: it continues in the background, you can close this page.",
  },

  dashboard: {
    profit: {
      title: "Profit this month",
      hint: "Revenue minus the cost of goods sold, on this month’s orders.",
      orders: (n: number) => `${n} ${n === 1 ? "order" : "orders"}`,
      reliability: (percent: number) => `Based on ${percent}% of order lines`,
      complete: "Based on every order line",
      fix: "Fill in the costs",
      noOrders: "No orders this month.",
      unavailable: "Profit becomes available after the first order sync.",
    },
    margin: {
      title: "Margin per order",
      detail: (profit: string, value: string) =>
        `${profit} of ${value} per order`,
      hint: "What’s left of an average order after the cost of goods.",
      noOrders: "No orders to work from yet.",
    },
    profitability: {
      title: "Value and profit",
      subtitle: "Across the orders in the selected period.",
      perOrder: "Per order",
      perCustomer: "Per customer",
      value: "Value",
      profit: "Profit",
      partial: (covered: number, total: number) =>
        `Profit worked out from ${covered} of ${total} order lines: the rest have no product cost yet.`,
      empty: "Synced orders are needed to work this out.",
    },
    coverage: {
      productsTitle: "Products ready",
      customersTitle: "Customers with consent",
      productsHint:
        "Products with a cost filled in — the only ones profit can be worked out on.",
      customersHint:
        "Customers who opted into marketing: the ones the app syncs.",
      ready: (ready: number, total: number) => `${ready} of ${total} ready`,
      optedIn: (optIn: number, total: number) =>
        `${optIn} of ${total} opted in`,
      fix: "Fix products",
      none: "No data",
    },
    freshness: {
      title: "Data freshness",
      fresh: "Up to date",
      stale: "Needs a look",
      never: "Never synced",
      lastSync: (when: string) => `Last sync ${when}`,
      nextSync: (countdown: string) => `Next one in ${countdown}`,
      noSyncYet: "The first sync hasn’t happened yet.",
    },
    title: "Dashboard",
    products: {
      title: "Products",
      total: "Total products",
      notEligible: "Not eligible",
      seeProducts: "See products",
      eligible: "Eligible products",
    },
    customers: {
      title: "Customers",
      total: "Total customers",
      optIn: "Opted-in customers",
      optOut: "Opted-out customers",
      optInInfo: "These are the customers who consented to marketing",
      optOutInfo: "These are the customers who did not consent to marketing",
      upsell:
        "Get more out of your user data by tracking Lifetime Value (LTV) and Lifetime Profit (LTP) too.",
      upgrade: "Upgrade plan",
    },
    connection: { title: "Connection" },
    topProducts: {
      title: "The products that earn most",
      metric: { cm: "CM", aop: "AOP", acp: "ACP", ltp: "LTP" },
      help: {
        cm: "Contribution margin: total profit brought in over the period. Rewards what sells a lot.",
        aop: "Average order profit: what it earns each time it is bought. Rewards the expensive product, even a rare one.",
        acp: "Average cart profit: what the whole order it sits in earns. Rewards the product that brings others with it.",
        ltp: "Profit per customer: what each customer who bought it brought in. Rewards the product that makes people come back.",
      },
      orders: (n: number) => (n === 1 ? "1 order" : `${n} orders`),
      singleVariant: "Single variant",
      empty:
        "No orders with a filled-in product cost in this period. Without a cost there is no profit to compute.",
    },
    recentRuns: {
      title: "Recent syncs",
      seeAll: "See all",
      empty: "No sync yet.",
      run: {
        done: "Sync completed",
        running: "Sync",
      },
    },
    soldWithoutCost: {
      body: (count: number) =>
        count === 1
          ? "There is 1 product included in fulfilled and/or paid orders (not cancelled) with no product cost set, which makes real profit impossible to work out."
          : `There are ${count} products included in fulfilled and/or paid orders (not cancelled) with no product cost set, which makes real profit impossible to work out.`,
      fix: "Fix issues",
    },
    manualSync: {
      button: "Manual sync",
      running:
        "We are running a manual sync of your order, product and customer data. It will only take a moment…",
    },
    chart: {
      title: "Syncable products",
      eligible: "Eligible",
      limit: "Plan limit",
    },
    willSync: "What will be synced",
    customersLocked: "Upgrade now to include customer sync",
    disconnect: {
      deletedTitle: "Tables and data deleted",
      keptTitle: "Connection removed",
      deletedBody:
        "The connection has been removed and the tables the app created, with the synced data, have been deleted from the project.",
      keptBody:
        "The connection has been removed. The tables and the synced data stay in the project: reconnect it and the sync picks up from there.",
    },
  },

  plan: {
    currentPlan: "Current plan",
    choose: (plan: string) => `Choose ${plan}`,
    successBanner: {
      title: "Plan updated",
      message:
        "Your plan is active: limits and sync frequency have already been applied.",
    },
    errorBanner: {
      title: "Plan change not completed",
      message:
        "The plan change didn’t go through. Nothing changed and there are no charges.",
    },
    title: "Plan",
    blocked: {
      title: "There’s nothing to upgrade",
      body:
        "Your plan has no limits and no renewals: there’s nothing to upgrade. Head back to the " +
        "dashboard to carry on.",
    },
    errorTitle: "Error",
    reserved: {
      title: "You have a reserved price",
      before: "This app has an active partnership with ",
      after:
        ", which is why the plans cost you less than list price — monthly and yearly alike. " +
        "You’ll find your price on each plan below",
      forRenewals: (n: number) =>
        `, for the first ${n} ${n === 1 ? "renewal" : "renewals"}.`,
      end: ".",
    },
    intro: {
      title: "Pick the plan that fits your store",
      body:
        "More products covered, more frequent updates and customer data always in step: the " +
        "higher the plan, the fresher and more complete the information your tracking works on, " +
        "and the more dependable your campaigns and reports.",
      keepData:
        "Changing plan doesn’t lose what you’ve already collected: only the limits, the update " +
        "frequency and the included features change.",
    },
    monthly: "Monthly",
    yearly: "Yearly",
    yearlyHint: (amount: string) =>
      `Going yearly saves you up to ${amount} a year`,
    reservedFor: (n: number) =>
      `Your reserved price applies for ${n} ${
        n === 1 ? "renewal" : "renewals"
      }`,
    recommended: "Recommended",
    perYear: "/year",
    perMonth: "/month",
    billedByShopify:
      "Billing goes through Shopify, alongside your store’s invoice, and you can change or " +
      "cancel your plan whenever you like.",
    features: {
      products: (amount: string) => `Up to ${amount} products`,
      productsUnlimited: "Unlimited products",
      sync: (frequency: string) => `Sync ${frequency}`,
      email: "Email support",
      customers: (amount: string) => `Up to ${amount} customers`,
      customersUnlimited: "Unlimited customers",
      customersSync: "Customer sync",
      feeds: "Multi product feed",
      feedsHelp: "Create and manage product catalogues via CSV, XML or URL",
      push: "Manual push",
      chat: "Dedicated chat",
    },
  },

  authBanners: {
    trackingStillOn:
      " Tracking stays on and keeps using the data already synced, which will no longer be updated.",
    appDisabled: {
      title: "App disabled",
      message:
        "This store’s access to the app has been disabled: every feature and sync is suspended.",
    },
    trialEnded: {
      title: "Trial ended",
      message:
        "Your trial has ended: the app’s features and syncs are suspended. Upgrade your plan to turn them back on.",
    },
    trackingSuspended: {
      title: "Tracking suspended",
      disabled:
        "Tracking is suspended for this store: the data already synced can’t be used by your tracking tool right now. Contact support.",
      pending:
        "Tracking is suspended: the data already synced can’t be used by your tracking tool right now. Upgrade your plan to turn it back on.",
    },
  },

  syncCta: {
    running: "Syncing…",
    updating: "Updating…",
    start: "Start sync",
    completed: "Sync complete",
  },

  planChange: {
    changedTitle: "Plan changed",
    updatedTitle: "Plan updated",
    capUnlimited: "no limit",
    capPhraseUnlimited: "no product limit",
    capPhrase: (products: string) => `${products} products`,
    downgradeWithCustomers: {
      before: "Your plan’s limit on synced products is now ",
      after:
        " and customer data syncing has been suspended. Your customer data won’t be deleted, " +
        "but it will no longer be updated — neither the customer details nor the orders and " +
        "profitability data tied to them.",
    },
    upgradeBack: (plan: string) =>
      `Upgrade to ${plan} or above again and syncing resumes as before.`,
    productsDowngrade: (cap: string) =>
      `Some products will be removed to stay within your plan’s limit: ${cap} products synced.`,
    productsUpdated: (cap: string) =>
      `Syncing will follow your plan’s new limits automatically: ${cap} products synced.`,
    customersGained:
      "The table of customers who opted into marketing is created and filled right away, " +
      "with nothing for you to do: from here on it updates by itself alongside the periodic " +
      "product sync.",
    customersResumed:
      "Customer syncing resumes: the data you already collected goes back to updating by " +
      "itself alongside your products, with nothing for you to do.",
    customersLost:
      "Customer syncing stops. The data you already collected isn’t deleted and stays in your " +
      "project, but it will no longer be updated and can’t be used for tracking.",
  },

  schemaUpdate: {
    title: "Database update available",
    body:
      "An update to your database tables is available. You don’t need to open your database, " +
      "touch tables or columns, or reconfirm the integration: one click and the update runs for " +
      "you. The data already synced stays where it is.",
    action: "Run the update on my database",
  },

  overflow: {
    title: "Product limit reached",
    body: (excluded: number, plan: string) =>
      `${excluded} ${
        excluded === 1 ? "product won’t be synced" : "products won’t be synced"
      } ` +
      `because you’ve reached your plan’s limit. Counting all your products, the plan that fits ` +
      `you best would be ${plan}.`,
    upgradeNow: (plan: string) => `Upgrade to ${plan} now`,
    modalTitle: (plan: string) => `You’re switching to ${plan}`,
    confirm: "Confirm and continue",
    cancel: "Cancel",
    whatChanges: "What changes",
  },

  planCompare: {
    products: "Products synced",
    customers: "Customers synced",
    monthlyCost: "Monthly cost",
    notIncluded: "Not included",
    unlimited: "Unlimited",
    free: "Free",
    perMonth: (price: string) => `${price}/month`,
  },

  issues: {
    title: "Products not eligible",
    filterAll: "All",
    filterSold: "Only products in orders",
    hiddenCount: (hidden: number) =>
      hidden === 1 ? "1 product hidden by the filter" : `${hidden} products hidden by the filter`,
    recheck: "Recheck and update",
    listTitle: "Products not eligible",
    suspended:
      "The app is suspended for this store: you can read the list but not change costs until " +
      "it’s reactivated.",
    fetchFailed:
      "Couldn’t fetch your products from Shopify. Try again shortly.",
    fixHighlighted:
      "Check the costs flagged in red: they must be numbers of zero or more.",
    someFailed:
      "Some costs weren’t saved: the rows involved stay in the list with the reason next to " +
      "the field.",
    resolved: (n: number) =>
      `${n} ${
        n === 1 ? "variant fixed and removed" : "variants fixed and removed"
      } from the list. ` + "The count on your dashboard is up to date.",
    allGood: "No products with issues: every variant has a value for",
    intro: {
      before: "The products listed here have no value for ",
      after:
        " (product cost), so they can’t be synced until you fill it in. The value is written " +
        "both to your database and to Shopify once you click «Recheck and update».",
    },
    noResults: (query: string, total: number) =>
      `No results for «${query}». There are ${total} variants with issues: try a different search.`,
    search: "Search",
    searchPlaceholder: "Search by title, variant, SKU, product ID or price",
    resource: { singular: "variant", plural: "variants" },
    columns: {
      product: "Product",
      variant: "Variant",
      sku: "SKU",
      price: "Price",
    },
    pageOf: (page: number, total: number) => `${page} of ${total}`,
    rowError: {
      invalid: "Invalid cost",
      noInventoryItem: "Variant without an inventory item",
    },
  },

  errors: {
    suspended: "This store’s access to the app is suspended.",
    appDisabled:
      "This store’s access to the app has been disabled. Contact support.",
    trialEnded:
      "Your trial has ended: the app’s features and syncs are suspended. Upgrade your plan to " +
      "turn them back on.",
    noOrganization: "No Supabase organisation found.",
    createProjectScope:
      "Not enough permissions to create projects. Reconnect Supabase.",
    createProjectFailed: "Couldn’t create the project. Try again.",
    linkFailed: "Couldn’t finish connecting. Try again.",
    projectsFailed: "Couldn’t fetch your Supabase projects.",
    planChangeFailed: "Couldn’t start the plan change. Try again.",
    planNoPurchases: "Your plan doesn’t include purchases or renewals.",
    planPickOne: "Pick a plan to continue.",
    planUnavailable: "The plan you picked isn’t available.",
    planAlreadyActive: "You’re already on this plan.",
    trackingAnswerFailed: "Couldn’t record your answer. Try again.",
    productsFetchFailed:
      "Couldn’t fetch your products from Shopify. Try again shortly.",
    costInvalid: "Enter a valid cost (0 or more).",
    variantInvalid: "Invalid variant.",
    costWritePermission:
      "The app doesn’t have permission to change costs on Shopify. Reopen or reinstall the app " +
      "to grant it, then try again.",
    costWriteFailed: "Couldn’t save to Shopify. Try again.",
    costHalfSaved:
      "The cost was saved to Shopify but not to your database. Try again to line them up.",
    deleteConnected:
      "This is the connected database: disconnect it first to delete it.",
    deleteUnknown: "This database is no longer in your Supabase account.",
    deleteFailed: "Couldn’t delete the database. Try again.",
    recheckFailed: "The recheck didn’t go through. Try again.",
  },

  chart: {
    title: "Product data coverage",
    currentMonth: "This month",
    building: "The history builds up from here, one point a day.",
    unavailable:
      "The chart isn’t available right now. Reload the page to try again.",
    planLimit: "Plan limit",
  },

  errorPage: {
    title: "Something went wrong",
    unknown: "Unknown error",
    status: (status: number, text: string) => `Error ${status} ${text}`,
    offlineTitle: "No connection",
    offlineBody:
      "The connection check didn’t go through: check your network and refresh the page.",
    refresh: "Refresh page",
  },

  customers: {
    title: "Customers",
    intro: "What each customer is worth, after the cost of what they bought.",
    range: "Period",
    apply: "Apply",
    columns: {
      customer: "Customer",
      orders: "Orders",
      aop: "Average order profit",
      ltp: "Lifetime profit",
      status: "Sync",
      actions: "Actions",
    },
    synced: "Synced",
    notSynced: "Not synced",
    noName: "No name",
    empty: "No orders in the selected period.",
    warning: (missing: number) =>
      `This customer's profit is worked out from ${missing} ${
        missing === 1 ? "product with no cost" : "products with no cost"
      }: the figure is synced but stays partial until you fill it in.`,
    allGood: "This customer's profit is worked out from complete costs.",
    fixIssues: "Fix issues",
    notConnected: "Connect a database to see profit per customer.",
    noAccess:
      "Calculating profit needs access to your store’s orders. Reopen the app to grant it.",
    resource: { singular: "customer", plural: "customers" },
  },

  advancedSetup: {
    title: "Advanced setup",
    beta: "Beta",
  },

  sync: {
    title: "Sync",
    frequency: "Frequency",
    last: "Last",
    next: "Next",
    inLabel: (countdown: string) => `In ${countdown}`,
    every: {
      minutes: (n: number) => `Every ${n} minutes`,
      hour: "Every hour",
      hours: (n: number) => `Every ${n} hours`,
      day: "Every day",
      days: (n: number) => `Every ${n} days`,
    },
    countdown: {
      oneMinute: "one minute",
      minutes: (n: number) => `${n} minutes`,
      oneHour: "one hour",
      hours: (n: number) => `${n} hours`,
      hoursMinutes: (h: number, m: number) => `${h}h ${m}min`,
      oneDay: "one day",
      days: (n: number) => `${n} days`,
    },
  },
  dates: {
    apply: "Apply",
    placeholder: "YYYY-MM-DD",
    presets: {
      today: "Today",
      yesterday: "Yesterday",
      last7: "Last 7 days",
      last30: "Last 30 days",
      last90: "Last 90 days",
      monthToDate: "Month to date",
      quarterToDate: "Quarter to date",
      yearToDate: "Year to date",
      lastMonth: "Last month",
      lastQuarter: "Last quarter",
      lastYear: "Last year",
      custom: "Custom range",
    },
    comparisons: {
      none: "No comparison",
      previousPeriod: "Previous period",
      previousYear: "Previous year",
      previousYearWeekday: "Previous year (matching weekday)",
    },
  },
  catalogs: {
    title: "Catalogues",
    intro:
      "Publish your store's catalogue to advertising platforms. Each platform reads an address we keep up to date: your products stay in sync without you uploading anything by hand.",
    available: "Available",
    active: "Active",
    paused: "Paused",
    install: "Activate",
    delete: "Delete integration",
    deleteTitle: "Delete the integration?",
    deleteBody: (platform: string) =>
      `The feed address is deleted and stops responding. ${platform} will no longer find the file and your products will stop updating. You can set the integration up again whenever you like: the address will be a new one and will need pasting in again.`,
    deleteSafe:
      "Your existing catalogues and shops are not changed by this deletion.",
    deleteConfirm: "Delete integration",
    planRequired:
      "Catalogue feeds are not part of your plan. The integrations stay here, ready: activating them needs a plan that includes them.",
    manage: "Manage",
    google: {
      name: "Google Merchant Center",
      description:
        "Shopping, Performance Max ads and your free listings. The catalogue feeds everything Google shows about your products.",
    },
    mapping: {
      title: "Field matching",
      intro:
        "Google asks for around twenty fields. Here you decide which of your catalogue data fills each one: the ones at the top are already set to the most suitable.",
      field: "Google field",
      variable: "Catalogue data",
      required: "Required",
      recommended: "Recommended",
      sections: { default: "Default", recent: "Recent", others: "Other variables" },
      saving: "Saving…",
      saved: "Saved",
    },
    variables: {
      product_title: "Product title",
      variant_title: "Variant title",
      title_with_variant: "Product title + variant",
      product_description: "Description",
      vendor: "Vendor (brand)",
      product_type: "Product type",
      handle: "Handle",
      sku: "SKU",
      barcode: "Barcode",
      price: "Price",
      compare_at_price: "Compare-at price",
      image_url: "Image",
      option1: "Option 1",
      option2: "Option 2",
      option3: "Option 3",
      tags: "Tags",
      weight: "Weight",
      inventory_quantity: "Inventory quantity",
      shopify_product_id: "Product ID",
      shopify_variant_id: "Variant ID",
      product_link: "Product link",
      availability_state: "Availability",
      condition_new: "Condition: new",
      none: "No data",
    },
    meta: {
      name: "Meta",
      description:
        "Facebook and Instagram. The catalogue feeds dynamic ads, shoppable posts and the profile shop.",
    },
    feed: {
      title: "Feed address",
      description:
        "Paste this address into Meta: it will read the catalogue on its own, every day.",
      format: "Format",
      formatXml: "XML",
      formatCsv: "CSV",
      formatHelp:
        "Meta reads both. Choose CSV if you would rather open it in a spreadsheet.",
      copy: "Copy",
      copied: "Copied",
      open: "Open the file",
      lastFetch: "Meta last read it",
      never: "Never",
      fetchCount: (n: number) => (n === 1 ? "1 read" : `${n} reads`),
      rotate: "Regenerate the address",
      rotateTitle: "Regenerate the address?",
      rotateBody:
        "The old address stops working immediately. You will need to paste the new one into Meta, or the catalogue will stop updating.",
      rotateConfirm: "Regenerate",
      disable: "Turn off",
      disableTitle: "Turn off the feed?",
      disableBody:
        "The address stops responding and Meta will no longer find the catalogue. You can turn it back on whenever you like: the address stays the same.",
      disableConfirm: "Turn off",
      enable: "Turn back on",
    },
    steps: {
      title: "How to connect it to Meta",
      oneBefore: "Open",
      oneLink: "Commerce Manager",
      oneAfter: "and pick your catalogue (or create an e-commerce one).",
      two: "Go to Data sources and add a scheduled feed.",
      three: "Paste the address above and set it to update daily.",
      four: "Save. The first read arrives within a few minutes.",
    },
    table: {
      title: "Products in the catalogue",
      product: "Product",
      price: "Price",
      state: "State",
      sync: "Synchronisation",
      searchPlaceholder: "Search a product…",
      all: "All",
      onlyBlocked: "Excluded only",
      onlyWarned: "Needs work only",
      empty: "No products synchronised.",
      noMatch: "No product matches the filter.",
      summary: (included: number, total: number) =>
        `${included} of ${total} products make it into the feed`,
      blockedCount: (n: number) => (n === 1 ? "1 excluded" : `${n} excluded`),
      warnedCount: (n: number) => (n === 1 ? "1 needs work" : `${n} need work`),
      okBadge: "Ready",
      warnBadge: "Needs work",
      blockedBadge: "Excluded",
    },
    issues: {
      no_title: "The title is missing.",
      no_price: "The price is missing, or is zero.",
      no_image: "The image is missing.",
      no_link: "The link to the product's page is missing.",
      not_active: "The product is not active in the store.",
      no_description: "The description is missing.",
      no_brand: "The brand is missing (the vendor field on Shopify).",
      no_gtin: "The barcode is missing.",
      title_too_long: "The title is over 200 characters and will be cut.",
      out_of_stock: "The product is out of stock.",
    },
    notConnected: "Connect your database to see the catalogue.",
  },
};
