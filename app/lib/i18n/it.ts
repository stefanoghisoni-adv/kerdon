/**
 * I testi dell'app in italiano.
 *
 * L'italiano e' l'originale: e' qui che una frase nasce, e `en.ts` la segue.
 * Il tipo di `en` e' `typeof it`, quindi una voce aggiunta qui e non la' non
 * compila — le due lingue non possono divergere in silenzio.
 *
 * Le frasi con un valore dentro sono funzioni: il valore arriva tipizzato, e
 * l'ordine delle parole resta libero in ogni lingua invece di essere imposto da
 * una concatenazione.
 */
export const it = {
  common: {
    confirm: "Conferma",
    cancel: "Annulla",
    dashboard: "Dashboard",
    settings: "Impostazioni",
    plan: "Piano",
    logs: "Logs",
    productIssues: "Prodotti non idonei",
    never: "Mai",
    notSet: "—",
    active: "Attiva",
    inactive: "Non attiva",
    connected: "Collegato",
    notConnected: "Non collegato",
  },

  nav: {
    /** L'unica voce di menu finche' la configurazione e' aperta. */
    configuration: "Configurazione",
  },

  language: {
    label: "Lingua/valuta",
    /** Titolo della colonna dentro il riquadro: li' la valuta ha la sua. */
    languageColumn: "Lingua",
    currency: "Valuta",
    /** Testo del campo di ricerca, quando le lingue sono molte. */
    searchPlaceholder: "Cerca una lingua…",
    translating: "Attendi qualche istante per completare la traduzione…",
    saving: "Salvataggio…",
  },

  settings: {
    title: "Impostazioni",
    noProject: {
      before: "Nessun progetto Supabase collegato. Vai alla",
      link: "Dashboard",
      after: "per collegare il tuo database.",
    },
    missingReadKey:
      "Chiave di lettura non disponibile: il tracciamento non riesce a leggere i dati. Scrivici e la rimettiamo a posto.",
    missingProxyUrl:
      "Indirizzo di lettura non disponibile: manca la configurazione del dominio dell’app. Contatta il supporto prima di impostare il tracciamento.",
  },

  account: {
    title: "Account",
    plan: "Piano",
    productsSync: "Sincronizzazione prodotti",
    customersSync: "Sincronizzazione clienti",
    productFeeds: "Feed prodotti",
    upgradeTo: (planName: string) => `Aggiorna a ${planName}`,
  },

  database: {
    name: "Nome database",
    title: "Database",
    status: "Stato",
    appUrl: "App URL",
    readKey: "Publishable API Key",
    notConfigured: "Non configurato",
    ownerUrl: "URL Database proprietario",
    open: "Vai al database",
    copy: "Copia",
    copied: "Copiato!",
  },

  logs: {
    title: "Logs",
    nextSync: (countdown: string) =>
      `Prossima sincronizzazione tra ${countdown}`,
    status: { completed: "Completata", failed: "Fallita", running: "In corso" },
    /**
     * Una frase sola per tutte e tre le creazioni di tabella, e senza
     * "riuscita": l'esito lo dice gia' il badge accanto, e ripeterlo a parole
     * costringe a leggere due volte la stessa notizia. Quali tabelle siano
     * state create si vede nel dettaglio, non nel titolo.
     */
    tableCreated: "Creazione tabelle nel database",
    unknownError: "Errore sconosciuto",
    missingCustomersTable: "Non è stata trovata nessuna tabella per i clienti",
    missingProductsTable: "Non è stata trovata nessuna tabella per i prodotti",
    columns: {
      state: "Stato",
      description: "Descrizione",
      date: "Data",
      details: "",
    },
    seeDetails: "Vedi dettagli",
    empty: "Nessuna sincronizzazione registrata.",
    logTitle: "Log di sincronizzazione",
    noActivity: "Nessuna attività registrata",
    dateTime: "Data e ora",
    detailsColumn: "Dettagli",
    summaryAdded: (n: number) => `${n} ${n === 1 ? "aggiunto" : "aggiunti"}`,
    summaryRemoved: (n: number) => `${n} ${n === 1 ? "rimosso" : "rimossi"}`,
    summaryUpdated: (n: number) =>
      `${n} ${n === 1 ? "aggiornato" : "aggiornati"}`,
    summarySuspended: (n: number) => `${n} ${n === 1 ? "sospeso" : "sospesi"}`,
    partialList: "Elenco parziale: mostrate le prime 500 voci.",
    details: {
      title: "Dettaglio sincronizzazione",
      close: "Chiudi",
      products: "Prodotti",
      customers: "Clienti",
      loadFailed:
        "Non è stato possibile caricare i dettagli di questa sincronizzazione.",
      none: "Nessun dettaglio registrato per questa sincronizzazione.",
      noCustomers: "Nessun cliente modificato in questa sincronizzazione.",
      customersElsewhere:
        "L’elenco dei singoli clienti resta nel tuo database: qui trovi i totali.",
      action: "Azione",
      name: "Nome",
      shopifyId: "ID Shopify",
      added: "Aggiunto",
      removed: "Rimosso",
      updated: "Aggiornato",
      suspended: "Sospeso",
      truncated: (shown: number, total: number) =>
        `Mostrate ${shown} righe di ${total}.`,
    },
  },

  steps: {
    badge: { complete: "Completato", active: "In corso", locked: "Bloccato" },
    connectAccount: {
      title: "Collega Supabase",
      complete: "Completato",
      notConnected: "Non collegato",
      failed: "Fallito",
      inProgress: "In corso",
    },
    connectDatabase: {
      title: "Crea o collega un database",
      complete: "Completato",
      locked: "Accedi a Supabase per scegliere il database da collegare.",
    },
    trackingCheck: {
      title: "Controllo canali e tema",
      complete: "Completato",
      locked: "Collega un database per controllare cosa trasmette già dati.",
    },
    plan: {
      choose: "Scegli il piano",
      confirm: "Conferma il piano",
      locked: "Rispondi alla domanda qui sopra per scegliere il piano.",
    },
  },

  connect: {
    account: {
      intro:
        "Accedi a Supabase o crea un nuovo account. Subito dopo l’accesso ti verrà chiesto di accettare l’integrazione e, proseguendo, potrai selezionare o creare un nuovo database da collegare.",
      connect: "Collega Supabase",
      retry: "Ho creato il database",
      failed: "Collegamento a Supabase non riuscito. Riprova.",
      popupsBlocked: "Consenti i popup per collegare Supabase.",
      connectedWith: (email: string) => `Account connesso con ${email}.`,
      connectedRow: "Account connesso con",
      noEmail: "—",
      connectedNoEmail: "Account connesso.",
      loadingEmail: "Carico l’email connessa all’account",
      windowTitle: "Completa l’accesso nella finestra di Supabase",
      windowBody:
        "Se Supabase ti chiede prima di creare l’account o l’organizzazione, finisci quel passaggio: la richiesta di autorizzazione resta indietro e va riaperta. Questa pagina si aggiorna da sola appena l’accesso è fatto.",
      reopen: "Riapri la pagina di autorizzazione",
      almostTitle: "Manca solo un passaggio",
      almostBody:
        "Se hai appena creato l’account o il database su Supabase, resta da accettare il collegamento: è un clic, nella finestra di Supabase.",
    },
    database: {
      label: "Database",
      placeholder: "Seleziona un database…",
      loading: "Caricamento dei database del tuo account…",
      none: "Nessun database trovato nel tuo account Supabase. Puoi crearne uno qui sotto.",
      create: "Crea nuovo database",
      newName: "Nome del nuovo database",
      region: "Region",
      regionPlaceholder: "Seleziona una region…",
      regionsLoading: "Caricamento delle region…",
      creating: "Creazione del database in corso… (può richiedere 1-2 minuti)",
      disconnectTitle: "Scollegare Supabase?",
      deleteData: "Elimina tabelle e dati",
      keepData: "Mantieni i dati",
      disconnectBody: {
        before: "Puoi ",
        delete: "eliminare",
        middle:
          " le tabelle e i dati sincronizzati dal tuo progetto Supabase, oppure ",
        keep: "mantenerli",
        after:
          " (verrà interrotta solo la sincronizzazione). In entrambi i casi il collegamento verrà rimosso.",
      },
      typeName: "Inserisci qui sotto il nome del progetto",
      typeNameHelp: "L’eliminazione parte solo se il nome corrisponde.",
      projectName: "Nome del progetto",
      syncDisabled: "Sincronizzazione disabilitata.",
      syncSuspended: "Sincronizzazione sospesa.",
      limitKnown: (plan: string) =>
        `Hai raggiunto il limite massimo di database previsti dal tuo piano ${plan}.`,
      limitUnknown: "Hai raggiunto il limite massimo di database previsti dal tuo piano Supabase.",
      limitBefore: "",
      limitUpgradeLink: "Aggiorna ora il piano",
      limitUpgradePlain: "Aggiorna il piano",
      limitAfter: " su Supabase per creare più database.",
      connectedTo: "Database collegato:",
      limitReached:
        "Hai raggiunto il limite massimo di database per il tuo piano Supabase.",
      deleteProject: "Elimina un database",
      deleteTitle: "Eliminare un database?",
      deleteIntro:
        "Elimina definitivamente un database che non stai usando, con tutto quello che contiene. Il database collegato non è in elenco: per rimuovere quello, scollegalo prima.",
      deleteChoose: "Quale database",
      deleteNone: "Non hai altri database da eliminare.",
      deleteTypeName: "Per confermare, scrivi il nome del database:",
      deleteConfirm: "Elimina definitivamente",
      inUse: "In uso",
      deleteConfirmTitle: "Sicuro di voler proseguire?",
      deleteConfirmBody: (n: number) =>
        n === 1
          ? "Il database e tutto quello che contiene verranno eliminati definitivamente. L’operazione è irreversibile."
          : `I ${n} database e tutto quello che contengono verranno eliminati definitivamente. L’operazione è irreversibile.`,
      deleteProceed: "Prosegui ed elimina",
      manage: "Gestisci",
      change: "Cambia database",
      disconnect: "Disconnetti",
    },
  },

  tracking: {
    checking:
      "Controllo se ci sono canali di vendita o snippet di codice nel tema che trasmettono dati alle piattaforme",
    checkingLabel: "Controllo in corso",
    nothingFound:
      "Non ho trovato canali di vendita né codice nel tema che mandino eventi alle piattaforme.",
    partialNote:
      "Restano fuori dal controllo i pixel personalizzati aggiunti in Impostazioni → Eventi cliente: quelli vale la pena guardarli a mano.",
    conflicts: {
      title: "Altre fonti di eventi su questo negozio",
      intro:
        "Ogni conversione dovrebbe essere inviata una volta sola. Se una di queste manda gli stessi eventi che invii tu, acquisti e valore vengono contati due volte e le campagne vengono ottimizzate su numeri gonfiati.",
      channelHarmless: "Gestisce solo shop e cataloghi",
      codeHarmless: "Non considerare",
      uninstall: "Disinstalla",
      removeSnippet: "Rimuovi snippet",
      declaredChannel: "Quest’app non esegue attività di tracciamento",
      declaredCode: "Questo codice non esegue attività di tracciamento",
      incomplete:
        "L’elenco può non essere completo: i pixel personalizzati aggiunti in Impostazioni → Eventi cliente non sono visibili da qui. Vale la pena controllarli insieme a questi.",
    },
    serverSide: {
      intro:
        "Un tracciamento server side manda le conversioni dal server e non dal browser: arrivano anche quando il browser le blocca, e con i dati di catalogo e clientela che questa app tiene allineati diventano attribuibili e misurabili. Dicci per quali piattaforme raccogli dati.",
      needs: "Ho bisogno di un’infrastruttura server side",
      has: "Ho già una struttura server side",
      receivedTitle: "Richiesta ricevuta",
      receivedBody:
        "Ti ricontattiamo con una proposta per le piattaforme che hai indicato.",
      hasBody:
        "Hai dichiarato di avere già un’infrastruttura server side. Se cambia qualcosa, scrivici quando vuoi.",
      failed: "Non è stato possibile registrare la risposta. Riprova.",
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
      "Il piano stabilisce quanti prodotti entrano e ogni quanto si aggiornano.",
    introConfirm:
      "Confermi il piano attivo, oppure ne scegli un altro: la sincronizzazione parte subito dopo.",
    monthly: "Mensile",
    yearly: "Annuale",
    // Gli importi arrivano gia' scritti nella valuta del negozio: qui non si
    // aggiunge nessun simbolo, o si finirebbe per dire euro a chi paga in
    // dollari.
    yearlyHint: (amount: string) =>
      `Con l’annuale risparmi fino a ${amount} l’anno`,
    saving: (amount: string) => `Risparmi ${amount}`,
    current: "Attuale",
    recommended: "Consigliato",
    free: "Gratis",
    perMonth: (price: string) => `${price}/mese`,
    perYear: (price: string) => `${price}/anno`,
    yourPlan: "Il tuo piano:",
    confirmAndSync: "Conferma e sincronizza",
    syncing:
      "Sincronizzazione in corso: prosegue in background, puoi chiudere questa pagina.",
  },

  dashboard: {
    /** Copertura: quanta parte del catalogo e' utilizzabile davvero. */
    /** Il numero per cui il merchant apre l'app. */
    profit: {
      title: "Profitto del mese",
      hint: "Ricavi meno il costo dei prodotti venduti, sugli ordini di questo mese.",
      orders: (n: number) => `${n} ${n === 1 ? "ordine" : "ordini"}`,
      reliability: (percent: number) =>
        `Calcolato sul ${percent}% delle righe d’ordine`,
      complete: "Calcolato su tutte le righe d’ordine",
      fix: "Completa i costi",
      noOrders: "Nessun ordine questo mese.",
      unavailable:
        "Il profitto sarà disponibile dopo la prima sincronizzazione degli ordini.",
    },
    /** Quanto resta di un ordine medio. */
    margin: {
      title: "Margine per ordine",
      detail: (profit: string, value: string) =>
        `${profit} su ${value} per ordine`,
      hint: "Quanto resta di un ordine medio dopo il costo dei prodotti.",
      noOrders: "Ancora nessun ordine da cui calcolarlo.",
    },
    /** Quanto di cio' che si incassa resta. */
    profitability: {
      title: "Valore e profitto",
      subtitle: "Su tutti gli ordini, non solo su questo mese.",
      perOrder: "Per ordine",
      perCustomer: "Per cliente",
      value: "Valore",
      profit: "Profitto",
      empty: "Servono ordini sincronizzati per calcolarlo.",
    },
    coverage: {
      productsTitle: "Prodotti pronti",
      customersTitle: "Clienti con consenso",
      productsHint:
        "I prodotti con un costo compilato, gli unici su cui si può calcolare il profitto.",
      customersHint:
        "I clienti che hanno acconsentito al marketing: sono quelli che l’app sincronizza.",
      ready: (ready: number, total: number) => `${ready} di ${total} pronti`,
      optedIn: (optIn: number, total: number) =>
        `${optIn} di ${total} con consenso`,
      fix: "Sistema i prodotti",
      none: "Nessun dato",
    },
    freshness: {
      title: "Aggiornamento dati",
      fresh: "Aggiornato",
      stale: "Da controllare",
      never: "Mai sincronizzato",
      lastSync: (when: string) => `Ultima sincronizzazione ${when}`,
      nextSync: (countdown: string) => `La prossima tra ${countdown}`,
      noSyncYet: "La prima sincronizzazione non è ancora avvenuta.",
    },
    title: "Dashboard",
    products: {
      title: "Prodotti",
      total: "Prodotti totali",
      notEligible: "Non idonei",
      seeProducts: "Vedi prodotti",
      eligible: "Prodotti idonei",
    },
    customers: {
      title: "Clienti",
      total: "Clienti totali",
      optIn: "Clienti opt-in",
      optOut: "Clienti opt-out",
      optInInfo:
        "Qui vengono identificati i clienti che hanno acconsentito al marketing",
      optOutInfo:
        "Qui vengono identificati i clienti che non hanno acconsentito al marketing",
      upsell:
        "Potenzia la trasmissione dei dati utente monitorando anche il Lifetime Value (LTV) e Lifetime Profit (LTP).",
      upgrade: "Aggiorna piano",
    },
    connection: { title: "Connessione" },
    topProducts: {
      title: "I prodotti che rendono di pi\u00F9",
      metric: { cm: "CM", aop: "AOP", acp: "ACP", ltp: "LTP" },
      help: {
        cm: "Margine di contribuzione: quanto profitto ha portato in tutto nel periodo. Premia chi vende tanto.",
        aop: "Profitto medio per ordine: quanto rende ogni volta che viene comprato. Premia il prodotto caro anche se raro.",
        acp: "Profitto medio per carrello: quanto rende l\u2019intero ordine in cui si trova. Premia il prodotto che se ne porta dietro altri.",
        ltp: "Profitto per cliente: quanto ha portato ogni cliente che l\u2019ha comprato. Premia il prodotto che fa tornare.",
      },
      orders: (n: number) => (n === 1 ? "1 ordine" : `${n} ordini`),
      singleVariant: "Variante unica",
      empty:
        "Nessun ordine con un costo prodotto compilato nel periodo. Senza costo il profitto non si calcola.",
    },
    recentRuns: {
      title: "Ultime sincronizzazioni",
      seeAll: "Vedi tutte",
      empty: "Nessuna sincronizzazione ancora.",
      run: {
        /** Corsa conclusa: e' l'unica dicitura di successo per una sync. */
        done: "Sincronizzazione completata",
        /**
         * Corsa in corso o fallita. "Aggiornamento da Shopify" non diceva
         * niente a nessuno — da Shopify arriva tutto — e distinguere periodica
         * da webhook e' una distinzione nostra, non del merchant: per lui e'
         * sempre la stessa cosa, i suoi dati che si allineano.
         */
        running: "Sincronizzazione",
      },
    },
    chart: {
      title: "Copertura del catalogo",
      eligible: "Idonei",
      limit: "Limite del piano",
    },
    willSync: "Cosa verrà sincronizzato",
    customersLocked:
      "Aggiorna ora per integrare la sincronizzazione dei clienti",
    disconnect: {
      deletedTitle: "Tabelle e dati eliminati",
      keptTitle: "Collegamento rimosso",
      deletedBody:
        "Il collegamento è stato rimosso e le tabelle create dall’app, con i dati sincronizzati, sono state eliminate dal progetto.",
      keptBody:
        "Il collegamento è stato rimosso. Le tabelle e i dati sincronizzati restano nel progetto: ricollegandolo, la sincronizzazione riparte da lì.",
    },
  },

  plan: {
    /** Il pulsante della card, e l'esito al ritorno dall'addebito. */
    currentPlan: "Piano attuale",
    choose: (plan: string) => `Scegli ${plan}`,
    successBanner: {
      title: "Piano aggiornato",
      message:
        "Il tuo piano è attivo: limiti e frequenza di sincronizzazione sono già stati applicati.",
    },
    errorBanner: {
      title: "Cambio piano non completato",
      message:
        "Il cambio di piano non è stato completato. Niente è cambiato e non ci sono addebiti.",
    },
    /** La pagina: titolo, blocco, intestazione, ciclo di fatturazione. */
    title: "Piano",
    blocked: {
      title: "Non c’è niente da aggiornare",
      body:
        "Il tuo piano è senza limiti e non prevede rinnovi: non c’è nessun aggiornamento da " +
        "fare. Torna alla dashboard per continuare.",
    },
    errorTitle: "Errore",
    reserved: {
      title: "Hai un prezzo riservato",
      before: "Quest’app ha una partnership attiva con ",
      after:
        ", e per questo i piani ti costano meno del listino — sia sul mensile sia sull’annuale. " +
        "Trovi il prezzo che ti spetta su ogni piano qui sotto",
      forRenewals: (n: number) =>
        `, per i primi ${n} ${n === 1 ? "rinnovo" : "rinnovi"}.`,
      end: ".",
    },
    intro: {
      title: "Scegli il piano adatto al tuo store",
      body:
        "Più prodotti coperti, aggiornamenti più frequenti e dati cliente sempre allineati: " +
        "salendo di piano il tuo tracking lavora su informazioni più fresche e complete, con " +
        "campagne e report più affidabili.",
      keepData:
        "Cambiando piano non perdi quello che hai già raccolto: cambiano solo i limiti, la " +
        "frequenza di aggiornamento e le funzioni incluse.",
    },
    monthly: "Mensile",
    yearly: "Annuale",
    yearlyHint: (amount: string) =>
      `Con l’annuale risparmi fino a ${amount} l’anno`,
    reservedFor: (n: number) =>
      `Il prezzo riservato vale per ${n} ${n === 1 ? "rinnovo" : "rinnovi"}`,
    recommended: "Consigliato",
    perYear: "/anno",
    perMonth: "/mese",
    billedByShopify:
      "L’addebito avviene tramite Shopify, insieme alla fattura del tuo negozio, e puoi " +
      "cambiare o disdire il piano quando vuoi.",
    features: {
      products: (amount: string) => `Fino a ${amount} prodotti`,
      productsUnlimited: "Prodotti illimitati",
      /** Riceve gia' la cadenza scritta: "ogni 7 giorni". */
      sync: (frequency: string) => `Sync ${frequency}`,
      email: "Supporto via email",
      customers: (amount: string) => `Fino a ${amount} clienti`,
      customersUnlimited: "Clienti illimitati",
      customersSync: "Sync clienti",
      push: "Push manuale",
      chat: "Chat dedicata",
    },
  },

  // Sospensioni: cosa dire quando l'app o il tracciamento sono fermi.
  authBanners: {
    trackingStillOn:
      " Il tracciamento resta attivo e continua a usare i dati già sincronizzati, che però non verranno più aggiornati.",
    appDisabled: {
      title: "App disabilitata",
      message:
        "L'utilizzo dell'app è stato disabilitato per questo negozio: tutte le funzioni e le sincronizzazioni sono sospese.",
    },
    trialEnded: {
      title: "Periodo di prova terminato",
      message:
        "Il periodo di prova è terminato: le funzioni dell’app e le sincronizzazioni sono sospese. Aggiorna il piano per riattivarle.",
    },
    trackingSuspended: {
      title: "Tracciamento sospeso",
      disabled:
        "Il tracciamento è sospeso per questo negozio: i dati già sincronizzati non sono al momento utilizzabili dal tuo strumento di tracciamento. Contatta il supporto.",
      pending:
        "Il tracciamento è sospeso: i dati già sincronizzati non sono al momento utilizzabili dal tuo strumento di tracciamento. Aggiorna il piano per riattivarlo.",
    },
  },

  // Il pulsante della sincronizzazione, nei suoi quattro stati.
  syncCta: {
    running: "Sincronizzazione in corso…",
    updating: "Aggiornamento in corso…",
    start: "Avvia sincronizzazione",
    completed: "Sincronizzazione completata",
  },

  // Cosa comporta il piano appena cambiato.
  planChange: {
    changedTitle: "Piano modificato",
    updatedTitle: "Piano aggiornato",
    /** Il tetto dentro una frase: "200 prodotti", oppure senza tetto. */
    capUnlimited: "senza limite",
    capPhraseUnlimited: "senza limite di prodotti",
    capPhrase: (products: string) => `${products} prodotti`,
    // Un solo paragrafo spezzato: in mezzo va il tetto nuovo, in grassetto.
    downgradeWithCustomers: {
      before:
        "Il nuovo limite dei prodotti sincronizzabili previsti dal piano è stato aggiornato a ",
      after:
        " e la sincronizzazione dei dati dei clienti è stata sospesa. I dati dei clienti non " +
        "verranno eliminati ma non saranno più aggiornati né per le informazioni dei clienti " +
        "né per gli ordini e i dati di profittabilità ad essi connessi.",
    },
    upgradeBack: (plan: string) =>
      `Se aggiornerai di nuovo almeno a ${plan} la sincronizzazione riprenderà normalmente.`,
    productsDowngrade: (cap: string) =>
      `Alcuni prodotti verranno rimossi per rispettare il limite del piano: ${cap} prodotti sincronizzabili.`,
    productsUpdated: (cap: string) =>
      `La sincronizzazione rispetterà automaticamente i nuovi limiti del piano: ${cap} prodotti sincronizzabili.`,
    customersGained:
      "La tabella dei clienti che hanno acconsentito al marketing viene creata e " +
      "popolata subito, senza che tu debba fare nulla: da qui in avanti si " +
      "aggiorna da sola insieme alla sincronizzazione periodica dei prodotti.",
    customersResumed:
      "La sincronizzazione dei clienti riprende: i dati già raccolti tornano ad " +
      "aggiornarsi da soli insieme ai prodotti, senza che tu debba fare nulla.",
    customersLost:
      "La sincronizzazione dei clienti si interrompe. I dati già raccolti non " +
      "vengono cancellati e restano nel tuo progetto, ma non verranno più " +
      "aggiornati né potranno essere usati per il tracciamento.",
  },

  // Aggiornamento delle tabelle del merchant, in attesa.
  schemaUpdate: {
    title: "Aggiornamento del database disponibile",
    body:
      "È disponibile un aggiornamento delle tabelle del tuo database. Non devi accedere al " +
      "database né toccare tabelle o colonne, e non devi riconfermare l’integrazione: basta un " +
      "clic e l’aggiornamento viene eseguito per te. I dati già sincronizzati restano dove sono.",
    action: "Esegui aggiornamento sul database",
  },

  // Piu' prodotti di quanti il piano ne sincronizzi.
  overflow: {
    title: "Limite prodotti raggiunto",
    body: (excluded: number, plan: string) =>
      `${excluded} ${
        excluded === 1
          ? "prodotto non verrà sincronizzato"
          : "prodotti non verranno sincronizzati"
      } ` +
      `dato che hai raggiunto il limite del tuo piano. Contando i prodotti totali, il piano più ` +
      `in linea con le tue necessità sarebbe ${plan}.`,
    upgradeNow: (plan: string) => `Aggiorna ora a ${plan}`,
    modalTitle: (plan: string) => `Stai per passare a ${plan}`,
    confirm: "Conferma e procedi",
    cancel: "Annulla",
    whatChanges: "Cosa cambia",
  },

  // Il confronto fra il piano in uso e quello proposto.
  planCompare: {
    products: "Prodotti sincronizzabili",
    customers: "Clienti sincronizzabili",
    monthlyCost: "Costo mensile",
    notIncluded: "Non inclusi",
    unlimited: "Illimitati",
    free: "Gratuito",
    perMonth: (price: string) => `${price}/mese`,
  },

  // Prodotti che restano fuori dalla sincronizzazione, e come rimetterli dentro.
  issues: {
    title: "Prodotti non idonei",
    /**
     * Il filtro che arriva dalla tab Clienti. Dice quanti prodotti sono
     * nascosti, non quanti se ne vedono: il numero visibile e' gia' sotto gli
     * occhi, quello che manca no.
     */
    soldOnly: (hidden: number) =>
      hidden === 0
        ? "Stai vedendo solo i prodotti già venduti: sono questi a rendere parziale il profitto dei clienti."
        : `Stai vedendo solo i prodotti già venduti — quelli che rendono parziale il profitto dei clienti. Altri ${hidden} prodotti senza costo non sono ancora stati ordinati.`,
    showAll: "Mostra tutti i prodotti",
    recheck: "Ricontrolla e aggiorna",
    listTitle: "Elenco prodotti non idonei",
    suspended:
      "L’app è sospesa per questo negozio: puoi consultare l’elenco ma non modificare i costi " +
      "finché non viene riattivata.",
    fetchFailed:
      "Impossibile recuperare i prodotti da Shopify. Riprova tra poco.",
    fixHighlighted:
      "Controlla i costi segnalati in rosso: devono essere numeri maggiori o uguali a zero.",
    someFailed:
      "Alcuni costi non sono stati salvati: le righe interessate restano in elenco con il " +
      "motivo accanto al campo.",
    resolved: (n: number) =>
      `${n} ${
        n === 1 ? "variante risolta e rimossa" : "varianti risolte e rimosse"
      } dall’elenco. ` + "Il conteggio in Dashboard è aggiornato.",
    allGood: "Nessun prodotto con problemi: tutte le varianti hanno il valore",
    intro: {
      before: "I prodotti elencati non presentano un valore per il parametro ",
      after:
        " (costo prodotto) pertanto non potranno essere sincronizzati fino al loro adeguamento. " +
        "Il valore verrà aggiornato sia sul database che su Shopify dopo aver cliccato " +
        "«Ricontrolla e aggiorna».",
    },
    noResults: (query: string, total: number) =>
      `Nessun risultato per «${query}». Le varianti con problemi sono ${total}: prova a ` +
      "modificare la ricerca.",
    search: "Cerca",
    searchPlaceholder: "Cerca per titolo, variante, SKU, ID prodotto o prezzo",
    resource: { singular: "variante", plural: "varianti" },
    columns: {
      product: "Prodotto",
      variant: "Variante",
      sku: "SKU",
      price: "Prezzo",
    },
    pageOf: (page: number, total: number) => `${page} di ${total}`,
    rowError: {
      invalid: "Costo non valido",
      noInventoryItem: "Variante senza inventory item",
    },
  },

  // Messaggi che nascono sul server e finiscono in un banner.
  errors: {
    suspended: "L’utilizzo dell’app è sospeso per questo negozio.",
    appDisabled:
      "L’utilizzo dell’app è stato disabilitato per questo negozio. Contatta il supporto.",
    trialEnded:
      "Il periodo di prova è terminato: le funzioni dell’app e le sincronizzazioni sono " +
      "sospese. Aggiorna il piano per riattivarle.",
    // Supabase
    noOrganization: "Nessuna organizzazione Supabase trovata.",
    createProjectScope:
      "Permesso insufficiente per creare progetti. Ricollega Supabase.",
    createProjectFailed: "Creazione del progetto non riuscita. Riprova.",
    linkFailed: "Impossibile completare il collegamento. Riprova.",
    projectsFailed: "Impossibile recuperare i progetti Supabase.",
    // Piano
    planChangeFailed:
      "Non è stato possibile avviare il cambio di piano. Riprova.",
    planNoPurchases: "Il tuo piano non prevede acquisti né rinnovi.",
    planPickOne: "Scegli un piano per continuare.",
    planUnavailable: "Il piano scelto non è disponibile.",
    planAlreadyActive: "Stai già usando questo piano.",
    // Tracciamento e prodotti
    trackingAnswerFailed:
      "Non è stato possibile registrare la risposta. Riprova.",
    productsFetchFailed:
      "Impossibile recuperare i prodotti da Shopify. Riprova tra poco.",
    costInvalid: "Inserisci un costo valido (≥ 0).",
    variantInvalid: "Variante non valida.",
    costWritePermission:
      "L’app non ha il permesso di modificare i costi su Shopify. Riapri o reinstalla l’app " +
      "per concedere l’autorizzazione, poi riprova.",
    costWriteFailed: "Salvataggio su Shopify non riuscito. Riprova.",
    costHalfSaved:
      "Costo salvato su Shopify ma non nel tuo database. Riprova per allinearli.",
    deleteConnected:
      "Questo è il database collegato: per eliminarlo, scollegalo prima.",
    deleteUnknown: "Questo database non risulta più nel tuo account Supabase.",
    deleteFailed: "Non è stato possibile eliminare il database. Riprova.",
    recheckFailed: "Ricontrollo non riuscito. Riprova.",
  },

  // Il grafico dei prodotti sincronizzabili.
  chart: {
    title: "Prodotti sincronizzabili",
    currentMonth: "Mese corrente",
    building: "Lo storico si costruisce da qui in avanti, un punto al giorno.",
    unavailable:
      "Grafico non disponibile al momento. Ricarica la pagina per riprovare.",
    planLimit: "Limite del piano",
  },

  // La pagina che compare quando qualcosa e' andato storto davvero.
  errorPage: {
    title: "Si è verificato un errore",
    unknown: "Errore sconosciuto",
    status: (status: number, text: string) => `Errore ${status} ${text}`,
    offlineTitle: "Connessione assente",
    offlineBody:
      "Il controllo della connessione non è andato a buon fine: verifica la rete e aggiorna la " +
      "pagina.",
    refresh: "Aggiorna pagina",
  },

  // La tab Clienti: chi ha comprato, e quanto ci si e' guadagnato.
  customers: {
    title: "Clienti",
    intro:
      "Quanto rende ogni cliente, al netto del costo dei prodotti che ha comprato.",
    range: "Periodo",
    apply: "Applica",
    columns: {
      customer: "Cliente",
      orders: "Ordini",
      aop: "Profitto medio per ordine",
      ltp: "Profitto totale",
      status: "Sincronizzazione",
      actions: "Azioni",
    },
    synced: "Sincronizzato",
    notSynced: "Non sincronizzato",
    noName: "Senza nome",
    empty: "Nessun ordine nel periodo scelto.",
    /**
     * Il tooltip della spia, al posto della nota sotto il nome: la stessa cosa
     * detta a chi la cerca, invece che a tutti in ogni riga.
     */
    warning: (missing: number) =>
      `Il profitto di questo cliente è calcolato su ${missing} ${
        missing === 1 ? "prodotto di cui non si conosce" : "prodotti di cui non si conosce"
      } il costo: il valore è sincronizzato ma resta parziale finché non lo compili.`,
    allGood: "Il profitto di questo cliente è calcolato su costi completi.",
    fixIssues: "Risolvi problemi",
    notConnected: "Collega un database per vedere i profitti per cliente.",
    noAccess:
      "Per calcolare i profitti serve l’accesso agli ordini del negozio. Riapri l’app per concederlo.",
    resource: { singular: "cliente", plural: "clienti" },
  },

  // La proposta di configurazione avanzata, in dashboard.
  advancedSetup: {
    title: "Configurazione avanzata",
    beta: "Beta",
  },

  sync: {
    title: "Sincronizzazione",
    frequency: "Frequenza",
    last: "Ultima",
    next: "Prossima",
    inLabel: (countdown: string) => `Tra ${countdown}`,
    every: {
      minutes: (n: number) => `Ogni ${n} minuti`,
      hour: "Ogni ora",
      hours: (n: number) => `Ogni ${n} ore`,
      day: "Ogni giorno",
      days: (n: number) => `Ogni ${n} giorni`,
    },
    countdown: {
      oneMinute: "un minuto",
      minutes: (n: number) => `${n} minuti`,
      oneHour: "un'ora",
      hours: (n: number) => `${n} ore`,
      oneDay: "un giorno",
      days: (n: number) => `${n} giorni`,
    },
  },
  dates: {
    apply: "Applica",
    presets: {
      today: "Oggi",
      yesterday: "Ieri",
      last7: "Ultimi 7 giorni",
      last30: "Ultimi 30 giorni",
      last90: "Ultimi 90 giorni",
      monthToDate: "Da inizio mese",
      quarterToDate: "Da inizio trimestre",
      yearToDate: "Da inizio anno",
      lastMonth: "Mese scorso",
      lastQuarter: "Trimestre scorso",
      lastYear: "Anno scorso",
      custom: "Intervallo personalizzato",
    },
    comparisons: {
      none: "Nessun confronto",
      previousPeriod: "Periodo precedente",
      previousYear: "Anno precedente",
      previousYearWeekday: "Anno precedente (giorno della settimana)",
    },
  },
  catalogs: {
    title: "Cataloghi",
    intro:
      "Pubblica il catalogo del negozio verso le piattaforme pubblicitarie. Ogni piattaforma legge un indirizzo che aggiorniamo noi: i prodotti restano allineati senza che tu debba caricare niente a mano.",
    /** Stato della piattaforma, sulla card. */
    available: "Disponibile",
    active: "Attivo",
    paused: "In pausa",
    install: "Attiva",
    delete: "Elimina integrazione",
    deleteTitle: "Eliminare l\u2019integrazione?",
    /**
     * Il nome della piattaforma dentro il testo, non "la piattaforma": ogni
     * integrazione si stacca per conto suo, e chi sta eliminando quella di Meta
     * deve leggere Meta \u2014 altrimenti si chiede se sta togliendo anche le altre.
     */
    deleteBody: (platform: string) =>
      `L\u2019indirizzo del feed viene eliminato e smette di rispondere. ${platform} non trover\u00e0 pi\u00f9 il file e i prodotti non si aggiorneranno pi\u00f9. Puoi rifare l\u2019integrazione quando vuoi: l\u2019indirizzo sar\u00e0 nuovo e andr\u00e0 reincollato.`,
    deleteSafe:
      "Gli attuali cataloghi e shop non subiranno modifiche con l\u2019eliminazione.",
    deleteConfirm: "Elimina integrazione",
    manage: "Gestisci",
    google: {
      name: "Google Merchant Center",
      description:
        "Shopping, annunci Performance Max e la scheda gratuita del negozio. Il catalogo alimenta tutto quello che Google mostra dei tuoi prodotti.",
    },
    mapping: {
      title: "Corrispondenza dei campi",
      intro:
        "Google chiede una ventina di campi. Qui decidi da quale dato del tuo catalogo prende ciascuno: quelli in cima sono gia' impostati su quello piu' adatto.",
      field: "Campo Google",
      variable: "Dato del catalogo",
      required: "Obbligatorio",
      recommended: "Consigliato",
      sections: { default: "Predefinito", recent: "Recenti", others: "Altre variabili" },
      saving: "Salvataggio…",
      saved: "Salvato",
    },
    variables: {
      product_title: "Titolo prodotto",
      variant_title: "Titolo variante",
      title_with_variant: "Titolo prodotto + variante",
      product_description: "Descrizione",
      vendor: "Fornitore (marca)",
      product_type: "Tipo di prodotto",
      handle: "Handle",
      sku: "SKU",
      barcode: "Codice a barre",
      price: "Prezzo",
      compare_at_price: "Prezzo di confronto",
      image_url: "Immagine",
      option1: "Opzione 1",
      option2: "Opzione 2",
      option3: "Opzione 3",
      tags: "Tag",
      weight: "Peso",
      inventory_quantity: "Quantita in magazzino",
      shopify_product_id: "ID prodotto",
      shopify_variant_id: "ID variante",
      product_link: "Link al prodotto",
      availability_state: "Disponibilita",
      condition_new: "Condizione: nuovo",
      none: "Nessun dato",
    },
    meta: {
      name: "Meta",
      description:
        "Facebook e Instagram. Il catalogo alimenta le inserzioni dinamiche, i post acquistabili e la vetrina del profilo.",
    },
    feed: {
      title: "Indirizzo del feed",
      description:
        "Incolla questo indirizzo dentro Meta: leggera il catalogo da sola, ogni giorno.",
      format: "Formato",
      formatXml: "XML",
      formatCsv: "CSV",
      formatHelp:
        "Meta legge entrambi. Scegli CSV se preferisci aprirlo con un foglio di calcolo.",
      copy: "Copia",
      copied: "Copiato",
      open: "Apri il file",
      lastFetch: "Ultima lettura di Meta",
      never: "Mai",
      fetchCount: (n: number) => (n === 1 ? "1 lettura" : `${n} letture`),
      rotate: "Rigenera l'indirizzo",
      rotateTitle: "Rigenerare l'indirizzo?",
      rotateBody:
        "Il vecchio indirizzo smette di funzionare subito. Dovrai incollare quello nuovo dentro Meta, o il catalogo smettera di aggiornarsi.",
      rotateConfirm: "Rigenera",
      disable: "Disattiva",
      disableTitle: "Disattivare il feed?",
      disableBody:
        "L'indirizzo smette di rispondere e Meta non trovera piu il catalogo. Puoi riattivarlo quando vuoi: l'indirizzo resta lo stesso.",
      disableConfirm: "Disattiva",
      enable: "Riattiva",
    },
    steps: {
      title: "Come collegarlo a Meta",
      oneBefore: "Apri",
      oneLink: "Commerce Manager",
      oneAfter: "e scegli il catalogo (o creane uno di tipo e-commerce).",
      two: "Vai su Sorgenti dati e aggiungi un feed pianificato.",
      three:
        "Incolla l'indirizzo qui sopra e imposta l'aggiornamento giornaliero.",
      four: "Salva. La prima lettura arriva entro qualche minuto.",
    },
    table: {
      title: "Prodotti nel catalogo",
      product: "Prodotto",
      price: "Prezzo",
      state: "Stato",
      sync: "Sincronizzazione",
      searchPlaceholder: "Cerca un prodotto…",
      all: "Tutti",
      onlyBlocked: "Solo esclusi",
      onlyWarned: "Solo da sistemare",
      empty: "Nessun prodotto sincronizzato.",
      noMatch: "Nessun prodotto corrisponde al filtro.",
      /** Riassunto sopra la tabella. */
      summary: (included: number, total: number) =>
        `${included} prodotti su ${total} entrano nel feed`,
      blockedCount: (n: number) => (n === 1 ? "1 escluso" : `${n} esclusi`),
      warnedCount: (n: number) =>
        n === 1 ? "1 da sistemare" : `${n} da sistemare`,
      okBadge: "Pronto",
      warnBadge: "Da sistemare",
      blockedBadge: "Escluso",
    },
    issues: {
      no_title: "Manca il titolo.",
      no_price: "Manca il prezzo, o e zero.",
      no_image: "Manca l'immagine.",
      no_link: "Manca il link alla pagina del prodotto.",
      not_active: "Il prodotto non e attivo sul negozio.",
      no_description: "Manca la descrizione.",
      no_brand: "Manca la marca (il fornitore su Shopify).",
      no_gtin: "Manca il codice a barre.",
      title_too_long: "Il titolo supera i 200 caratteri e verra tagliato.",
      out_of_stock: "Il prodotto risulta esaurito.",
    },
    notConnected: "Collega il database per vedere il catalogo.",
  },
  // Nessun `as const`: con i tipi letterali l'inglese non potrebbe scrivere
  // niente di diverso dall'italiano, che e' esattamente il suo mestiere.
};
