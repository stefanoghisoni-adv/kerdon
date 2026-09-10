# Google Tag Manager server-side

L'endpoint first-party del negozio, come Client del container server-side.

**Serve:** un container server-side gia' attivo su un sottodominio del negozio
(per esempio `sgtm.negozio.it` — non un indirizzo `*.run.app`, che non e'
first-party per nessuno), e la chiave di lettura dalla pagina Impostazioni
dell'app.

## Installazione

1. **Importa il template.** Nel container server-side: Modelli → Modelli client
   → Nuovo → menu ⋮ → Importa, e scegli `kerdon-id-client.tpl`. Salva.

2. **Crea il client.** Client → Nuovo → scegli "Kerdon — Identificativo
   visitatore". Compila:

   | Campo | Valore |
   |---|---|
   | Percorso su cui rispondere | `/kerdon/id` |
   | Indirizzo dell'API | quello indicato in Impostazioni |
   | Chiave di lettura | si copia da Impostazioni |
   | Dominio del negozio | `negozio.it`, senza `https://` |
   | Durata del cookie | `31536000` (un anno) |

   La priorita' del client va lasciata sotto quella dei client di GA4 e di
   Shopify: risponde solo al proprio percorso, ma l'ordine evita sorprese.

3. **Pubblica il container.**

4. **Aggiungi lo script alla vetrina**, nel tema (`theme.liquid`, prima di
   `</head>`) o come tag personalizzato del tag manager web:

   ```html
   <script src="https://api.kerdon.io/tracking/bridge.js"
           data-kerdon-endpoint="https://sgtm.negozio.it/kerdon/id" async></script>
   ```

5. **Verifica**, dall'app: Impostazioni → Verifica installazione.

## Perche' il sottodominio deve essere del negozio

Il cookie lo pianta il container, e vale per il dominio da cui il container
risponde. Se quel dominio non e' quello della vetrina, il cookie e' di terze
parti — cioe' esattamente il cookie che i browser cancellano, e che questo giro
esiste per evitare. Un container su `sgtm.negozio.it` va bene; uno su un
indirizzo di Google Cloud no.

## La chiave non arriva mai al browser

Sta nel campo del client, dentro il container. La chiamata dalla vetrina va al
container, il container chiama Kerdon: chi apre gli strumenti di sviluppo su
quel negozio non trova nessuna credenziale, perche' non ce n'e' mai passata una.
