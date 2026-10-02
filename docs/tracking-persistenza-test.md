# Test di persistenza del cookie di tracking

Questo documento descrive i test da eseguire per verificare il comportamento reale
del cookie `kerdon_eid` nei browser principali, con il dominio e il CDN di
produzione.

**Importante:** questi test vanno eseguiti con l'infrastruttura di produzione —
dominio del negozio, container pubblicato, DNS configurato. Un test su localhost o
su un container di anteprima non riproduce le politiche dei browser.

## Prerequisiti

Prima di iniziare, verifica che:

1. **Il dominio del negozio è configurato** e il container server-side risponde
   sul percorso pubblicato (es. `https://negozio.it/kerdon/id`)
2. **Il CDN è attivo** e la chiamata dalla vetrina arriva al container
3. **La verifica dentro l'app è passata** — tutti e otto i controlli in verde
4. **Hai un negozio di test** o una sezione del sito dove puoi provare senza
   impatto sui visitatori reali
5. **Hai preparato i browser:**
   - **Safari** (macOS e iOS) — versione corrente
   - **Firefox** (desktop) — con la protezione antitracciamento standard e strict
     (Preferenze → Privacy e sicurezza → Protezione antitracciamento avanzata)

## Come annotare i risultati

Per ogni test compila la tabella alla fine del documento. Annota:

- **Browser e versione**
- **Se il cookie è presente** dopo ogni passo
- **Il valore dell'ID** (primi e ultimi 8 caratteri, es. `kerdon_aB3d…012345`)
- **La scadenza dichiarata** nel cookie (in giorni o la data)
- **Se l'ID è cambiato** rispetto al passo precedente

## Test 1 — Primo PageView con consenso

**Obiettivo:** verificare che il cookie venga piantato con gli attributi corretti
quando il visitatore presta il consenso.

### Passi

1. Apri il browser in **modalità privata / navigazione anonima**
2. Cancella tutti i cookie del dominio del negozio
3. Vai su una pagina del negozio
4. **Accetta il consenso** al tracciamento (analytics + marketing)
5. Apri gli strumenti di sviluppo → scheda Application/Storage → Cookies
6. Cerca il cookie `kerdon_eid`

### Cosa annotare

- **Il cookie esiste?** (sì/no)
- **Il dominio** del cookie (deve essere il dominio del negozio, non un terzo)
- **Gli attributi:**
  - `Secure` presente?
  - `SameSite` dichiarato? (deve essere `Lax` o `None`)
  - `Path` = `/`?
  - `Max-Age` o `Expires` dichiarato? (quanti giorni / quale data?)
- **Il valore** (comincia con `kerdon_` e ha 32 caratteri dopo il trattino basso?)

### Risultato atteso

- Cookie presente
- Dominio = dominio del negozio
- `Secure`, `SameSite` dichiarato, `Path=/`
- Durata richiesta ≈ 1 anno (365 giorni)
- Valore nel formato `kerdon_<32 caratteri>`

## Test 2 — Ritorno dopo 1 giorno

**Obiettivo:** verificare che il cookie persista e che l'ID resti lo stesso.

### Passi

1. **Annota l'ID** del cookie dal Test 1
2. Chiudi il browser
3. **Aspetta 24 ore**
4. Riapri il browser (sempre in modalità normale, non privata)
5. Vai di nuovo sul negozio
6. Controlla il cookie `kerdon_eid`

### Cosa annotare

- **Il cookie c'è ancora?** (sì/no)
- **L'ID è lo stesso** del Test 1? (sì/no)
- **La scadenza dichiarata** è cambiata?

### Risultato atteso

- Cookie presente
- ID **identico** a quello del Test 1
- La scadenza si è rinnovata (riparte da oggi, non dalla prima visita)

## Test 3 — Ritorno dopo 7 giorni

**Obiettivo:** verificare il comportamento con ITP di Safari e con topologie CNAME
verso infrastrutture terze.

### Passi

1. **Annota l'ID** del Test 2
2. **Aspetta 7 giorni** senza visitare il negozio
3. Riapri il browser e vai sul negozio
4. Controlla il cookie `kerdon_eid`

### Cosa annotare

- **Il cookie c'è ancora?** (sì/no)
- **L'ID è lo stesso** del Test 2? (sì/no — questo è il punto critico)
- **Se l'ID è cambiato**, il browser ha cancellato il cookie o ne ha accorciato
  la durata?

### Risultato atteso (dipende dalla topologia)

- **Con rotta same-origin o edge verificata:** cookie presente, ID identico
- **Con CNAME verso IP di terzi (Stape, altri CDN non edge del negozio):**
  - Safari: **potrebbe** aver cancellato il cookie dopo 7 giorni (ITP)
  - Firefox con protezione strict: **potrebbe** aver isolato il cookie
- **In tutti i casi:** se il cookie è presente, l'ID deve essere lo stesso

## Test 4 — Rinnovo della scadenza a ogni visita

**Obiettivo:** verificare che il cookie non scada 365 giorni dopo la prima visita,
ma che la scadenza riparta da ogni visita.

### Passi

1. Visita il negozio oggi e annota la **data di scadenza** del cookie
2. Aspetta 2 giorni
3. Visita di nuovo il negozio
4. Controlla la **nuova data di scadenza**

### Cosa annotare

- **La scadenza si è spostata in avanti?** (sì/no)
- **Di quanti giorni** si è spostata rispetto alla prima?

### Risultato atteso

- La scadenza **si rinnova a ogni visita**
- La nuova scadenza è ≈365 giorni da oggi, non da 2 giorni fa

## Test 5 — Revoca del consenso

**Obiettivo:** verificare che il cookie venga cancellato alla revoca e che l'ID
non venga mai riusato.

### Passi

1. **Annota l'ID corrente** dal Test 4
2. Apri la pagina del negozio
3. **Ritira il consenso** al tracciamento (cambia la preferenza nel banner)
4. Controlla il cookie `kerdon_eid`
5. Ricarica la pagina
6. Controlla di nuovo il cookie
7. **Concedi di nuovo il consenso**
8. Ricarica la pagina
9. Controlla il cookie `kerdon_eid`

### Cosa annotare

- **Dopo la revoca, il cookie è stato cancellato?** (sì/no)
- **È comparso un cookie `kerdon_rv`?** (sì/no — è il cookie di servizio della revoca)
- **Dopo aver concesso di nuovo, qual è l'ID?**
- **L'ID è lo stesso di prima della revoca** o ne ha coniato uno nuovo?

### Risultato atteso

- Alla revoca, `kerdon_eid` **scade** (Max-Age=0 o viene rimosso)
- Può comparire `kerdon_rv` (cookie di servizio, HttpOnly, dura 30 giorni)
- **Dopo aver concesso di nuovo**, viene coniato un **ID nuovo** (diverso da quello
  di prima della revoca)
- L'ID revocato **non viene mai riusato**

## Test 6 — Cancellazione dati del sito dal browser

**Obiettivo:** verificare che cancellare i cookie dal browser rimuova anche questo.

### Passi

1. Con il consenso attivo, annota l'ID
2. Cancella i cookie del sito dal browser (Preferenze → Privacy → Gestisci dati
   dei siti web → cerca il dominio del negozio → Rimuovi)
3. Ricarica la pagina del negozio
4. Controlla il cookie `kerdon_eid`

### Cosa annotare

- **Dopo la cancellazione, il cookie è sparito?** (sì/no)
- **Dopo aver ricaricato, ne è stato coniato uno nuovo?** (sì/no)
- **L'ID è diverso** da quello di prima?

### Risultato atteso

- Il cookie **sparisce** insieme a tutti gli altri del dominio
- Al PageView successivo (con consenso), viene coniato un **ID nuovo**

## Test 7 — Confronto CNAME vs same-origin

**Obiettivo:** confrontare la persistenza con due topologie diverse.

Questo test ha senso solo se puoi configurare entrambe le topologie. Se hai solo
una delle due, annota quale e il risultato del Test 3.

### Topologie da confrontare

1. **CNAME verso infrastruttura terza** (es. `sgtm.negozio.it` → indirizzo Stape
   o CDN terzo): il dominio è del negozio, ma gli IP sono di un provider
2. **Rotta same-origin o edge verificata**: il cookie viene scritto da un Worker
   di Cloudflare sulla stessa zona DNS del negozio, o da un endpoint proprio

### Passi

1. Configura la **prima topologia** (CNAME)
2. Esegui il **Test 3** (ritorno dopo 7 giorni) con Safari
3. Annota il risultato
4. Configura la **seconda topologia** (same-origin/edge)
5. Ripeti il **Test 3** con Safari
6. Confronta i risultati

### Cosa annotare

- **Topologia 1 (CNAME):** ID dopo 7 giorni — stesso o diverso?
- **Topologia 2 (same-origin/edge):** ID dopo 7 giorni — stesso o diverso?

### Risultato atteso

- **CNAME verso IP di terzi:** Safari **potrebbe** aver cancellato il cookie (ITP)
- **Same-origin/edge:** cookie **presente**, ID identico anche dopo 7 giorni

---

## Tabella dei risultati

Compila questa tabella man mano che esegui i test. Una riga per ogni browser.

| Test | Browser | Versione | Cookie presente? | ID (primi 8…ultimi 8) | Scadenza dichiarata | ID uguale al precedente? | Note |
|------|---------|----------|------------------|-----------------------|---------------------|--------------------------|------|
| 1 — Primo PageView | Safari macOS | | | | | — | |
| 1 — Primo PageView | Safari iOS | | | | | — | |
| 1 — Primo PageView | Firefox (standard) | | | | | — | |
| 1 — Primo PageView | Firefox (strict) | | | | | — | |
| 2 — Dopo 1 giorno | Safari macOS | | | | | | |
| 2 — Dopo 1 giorno | Safari iOS | | | | | | |
| 2 — Dopo 1 giorno | Firefox (standard) | | | | | | |
| 2 — Dopo 1 giorno | Firefox (strict) | | | | | | |
| 3 — Dopo 7 giorni | Safari macOS | | | | | | |
| 3 — Dopo 7 giorni | Safari iOS | | | | | | |
| 3 — Dopo 7 giorni | Firefox (standard) | | | | | | |
| 3 — Dopo 7 giorni | Firefox (strict) | | | | | | |
| 4 — Rinnovo scadenza | Safari macOS | | | | | | |
| 5 — Revoca consenso | Safari macOS | | | | | | |
| 5 — Nuovo consenso | Safari macOS | | | | | | |
| 6 — Cancellazione dati | Safari macOS | | | | | | |
| 7 — CNAME (dopo 7gg) | Safari macOS | | | | | | |
| 7 — Same-origin (dopo 7gg) | Safari macOS | | | | | | |

---

## Limiti noti

Questi comportamenti sono **attesi**, non bug:

- **Safari può accorciare la durata** dei cookie first-party scritti via JavaScript,
  anche se il dominio è quello del negozio. ITP (Intelligent Tracking Prevention)
  limita a 7 giorni ogni cookie scritto da JavaScript, senza condizioni.
  
- **Firefox con Enhanced Tracking Protection (strict)** può isolare i cookie per
  sito, anche se first-party, quando l'infrastruttura che li scrive è
  classificata come tracker.

- **CNAME cloaking verso IP di terzi** può essere rilevato da Safari e Firefox: se
  il CNAME punta a un indirizzo IP di un CDN noto per il tracciamento (Stape,
  altri provider), il browser può trattare il cookie come di terze parti, anche se
  il dominio nel CNAME è quello del negozio.

- **La persona può cancellare i cookie in qualunque momento**, e navigare in
  modalità privata dove nessun cookie sopravvive alla chiusura del browser.

- **Il consenso può essere ritirato**, e da quel momento il cookie scade. Non è un
  limite tecnico: è la conformità GDPR.

Per questi motivi, **un anno è il massimo richiesto al browser, non una durata
garantita**. La durata reale dipende dal browser, dalla topologia (same-origin vs
CNAME verso terzi), dalle politiche antitracciamento attive e dalla volontà della
persona.

## Raccomandazioni

Per ottenere la massima persistenza possibile:

1. **Preferisci una rotta same-origin** (es. Worker di Cloudflare sulla stessa zona
   DNS del negozio) invece di un CNAME verso un provider terzo
2. **Verifica che il container non scriva il cookie via JavaScript lato client** —
   deve essere il container server-side a piantarlo, in risposta alla chiamata
3. **Non promettere mai 365 giorni garantiti** in nessun materiale: è una richiesta
   al browser, non una promessa che puoi mantenere
4. **Fai partire la chiamata all'endpoint a ogni PageView**, anche senza consenso:
   senza consenso non si conia niente, ma è quella chiamata a portare il no e a
   far partire la revoca
