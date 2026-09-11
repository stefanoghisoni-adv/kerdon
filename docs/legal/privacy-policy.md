# Kerdon — Privacy Policy

**Last updated:** 06-09-2026
**Version:** 1.1

## 1. Who we are

Kerdon is an application for Shopify stores, operated by Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148, Genoa (GE), Italy, VAT IT02705860993. You can reach us at support@coreward.app.

## 2. Our role, and yours

Kerdon installs into your Shopify store and copies part of your store's data into **a database that you own** — a Supabase project connected to your own account. That distinction determines who is responsible for what.

**You are the data controller** for your store's data, including your customers' personal data. You decide why it is processed and for how long it is kept.

**We are a data processor** acting on your instructions for that data. We process it only to provide the app's functions described below, never for our own purposes, and never to build profiles or datasets across merchants.

**We are the data controller** for the limited information about you as our customer: your store address, your app plan, your billing records and your support correspondence.

## 3. What the app processes

### 3.1 Store and account information

Your Shopify store domain and primary domain, time zone, billing currency, the app plan you are on, your language preference, and the access tokens that let the app talk to Shopify on your behalf. Access tokens are stored encrypted.

### 3.2 Product catalogue

Product and variant titles, descriptions, vendor, type, handle, status, tags, SKU, barcode, price, compare-at price, **cost per item**, inventory quantity and policy, weight, images and option values.

Cost per item is the reason the app exists: it is what allows profit to be calculated. When you fill in a missing cost, the app can also write it back to Shopify on your instruction.

### 3.3 Customer data — only with marketing consent

The app synchronises **only customers who have given marketing consent** in your store. For those customers it processes: Shopify customer ID, email address, phone number, first and last name, consent state and opt-in level, total spent, number of orders, customer state, tags, note, verified-email and tax-exempt flags, and creation/update timestamps.

It also processes the customer's **default address** — street, postcode, region and country — the **date of birth**, and an **external identifier**. Those last two do not stay empty: the app writes them, and how it writes them is set out below.

**The date of birth.** Shopify does not expose it as a customer field: it lives in a customer metafield. The app reads the field you point it at — Shopify's standard `facts.birth_date` field, or a date metafield that already exists in your store — and copies its value into your database. From the Customers tab you can also ask the app to enable the standard `facts.birth_date` definition for you: that is what the customer write permission the app requests at install is for.

**The date of birth is also written back to Shopify.** Where your database holds a date and the Shopify metafield is empty, the app writes that value into the very metafield it reads from. This applies only to customers who have given marketing consent, only if you have pointed the app at a field to read the date from, and only if that field is a date field. The app never overwrites a value Shopify already holds, writes nothing when what it finds in your database is not a date, and touches no other field on the customer record: it does not create customers and does not change their name, email, phone or address. It is still the writing of personal data back to Shopify, and it is declared here because that is what it is.

**The external identifier.** It is written by the visitor recognition described in 3.5: when a browser is linked to a customer, that customer's row records the identifier of the browser the person is browsing from at that moment.

Why the address: country and postcode are what advertising platforms use to recognise your customers among their own users, and without them the audience you build comes out smaller than it really is. For the same reason the phone number is written as digits only, international prefix included, and the date of birth as `YYYYMMDD`: that is the form those platforms compare.

Customers who have not given consent are never copied into your database.

**If a customer withdraws consent**, their record is not deleted — deleting it would destroy history you may need — but it is marked as no longer consenting, and any read request for that customer is refused from that moment on.

### 3.4 Orders

Where you have granted the app access to your orders, it processes: order ID and number, the customer's ID and first and last name, currency, total, financial status, cancellation date, order date, and for each line the product and variant, quantity, unit price paid and line discount.

From **orders** the app deliberately does **not** take addresses, email addresses, phone numbers, order notes, or payment details. Those are not needed to calculate profit, so they are not taken.

Nor does it process **shipping data**: no carrier, no tracking number, no label, no shipping cost. All that remains of delivery is whatever the customer paid at checkout, which is already part of the order total.

The customer address described in 3.3 is a different thing: it is the default address on the customer record, for customers who have given marketing consent, and it is not derived from orders.

### 3.5 Visitor recognition

If you enable visitor recognition, the app keeps a `users` table in **your** database, with **one row per browser**. Each row holds:

- a **pseudonymous browser identifier**, minted by the app (the prefix `corew_` followed by 32 random characters) and kept in a cookie issued by your own domain;
- the **browser label** and the **device-type label** — "Chrome", "mobile" and the like — when your tracking endpoint sends them;
- the **first and last time** that browser was seen;
- the **link to the Shopify customer**, written when the person identifies themselves by leaving an email address or phone number, or when they buy and the browser identifier arrives with the order;
- the **merging of identifiers**: when several browsers turn out to belong to the same person, the more recent ones record which is the oldest, and that one becomes the reference. No row is deleted for this.

**This is not anonymous data, and should not be called that.** The identifier holds no name, but it lives in that person's browser and, from the moment it is linked to a customer, it says which devices that person uses and when they used them. It is personal data and is treated as such.

**Consent comes first.** Without the visitor's permission — which the app reads from the Shopify Customer Privacy signals your endpoint forwards — no identifier is minted and no row is written. On withdrawal, writes stop, that browser's row is deleted along with the links that joined it to the others, and the app expires the cookie it had issued on its own domain. The cookie planted by your domain is yours: your endpoint is the only thing that can remove it.

**To link a browser to a customer** your endpoint sends us the email address or phone number the person has just given: the app uses them to find that customer in your database and write the link. Neither value is kept on our systems.

**Rows never linked to a customer are deleted 90 days** after they were last seen.

The app does **not** process the visitor's IP address and does **not** record the pages they visit.

### 3.6 Operational records

To run and support the app we keep, in our own database: a record of each synchronisation (type, outcome, timestamps, and how many records were added, updated or removed), product-level entries identifying which products changed, your billing charges, and access records for the read interface (outcome and HTTP status only).

What we keep about **customers** is very largely counts: the synchronisation does not copy names, email addresses or phone numbers into our database. There are, however, four cases where a reference to an individual is written on our side, and they belong here:

- **Pending repairs.** When an operation concerning a single customer fails — marking someone who has withdrawn consent, writing a date of birth back to Shopify — a row remains holding that customer's Shopify identifier and, for the date of birth, the value still to be written. It goes when the operation succeeds, or when it is given up after the retries allowed.
- **Privacy requests being worked on.** The signed message Shopify delivers to us holds the person's identifier, and it is kept until the request closes. It stays longer only where a request is stuck and has to be finished by hand: without it, nobody would know who it concerned.
- **Exports for access requests.** They contain the person's data and stay on our systems for at most 30 days: see section 8.
- **Withdrawals of recognition consent.** The browser identifier and, where the withdrawal names one, the customer identifier stay encrypted on the withdrawal row until it has been applied. They are then cleared, leaving only the — unreadable — proof that a withdrawal was made.

## 4. Where the data is stored

**Your data lives in your own database.** The Supabase project connected during setup belongs to your Supabase account, in the region you chose. We do not own it, cannot transfer it, and cannot access it after you disconnect the app.

**Our own database** holds the operational records in section 3.6, along with your store configuration and encrypted credentials. It is hosted in the European Union.

## 5. Who else is involved

| Provider | Purpose | Location |
|---|---|---|
| Shopify | Source of store, product, customer and order data; billing | As per Shopify's own terms |
| Supabase | Your database, and our own database | European Union |
| Vercel | Application hosting | European Union |
| Upstash | Job queue used to run synchronisations | European Union |

**We do not sell data.** Not yours, not your customers', to anyone, in any form. And we do not use it to train models.

Beyond the providers listed above — who act on our instructions and not on their own behalf — we do not pass data to anyone else. In particular, **we** are not the ones sending it to advertising or analytics platforms.

What the app does is put the data **in your own database** and make it available to you. From there it is your call: if you use it to build an audience on an advertising platform, you are the one sending it, you are the controller, and the legal basis is the consent your customer gave in your store. That is precisely why the app synchronises only those who gave that consent, and stops answering for those who withdraw it.

## 6. Security

Access tokens and database keys are encrypted at rest with AES-256-GCM. The privileged key to your database is never sent to a browser.

Tables created by the app in your database have row-level security enabled with no public policies: they cannot be read with a public key.

The read interface requires a token issued to your store, is limited to reading, and refuses requests for customers who have withdrawn consent.

Requests from Shopify are verified by signature before being acted upon.

## 7. How long data is kept

Data in **your** database is kept for as long as you decide. The app does not delete it on a schedule, with one exception: rows for browsers never linked to a customer are deleted 90 days after they were last seen.

**In our own database**: access records for the read interface are kept for 12 months and then deleted; exports prepared for an access request for at most 30 days; repair rows and privacy requests until they close, as described in 3.6.

**When you uninstall the app**, your data stays where it is — in your database, which remains yours — and our session with your store ends. We keep our operational and billing records for as long as required for accounting and legal purposes.

**When Shopify asks us to erase your store** (the shop redaction request sent 48 hours after uninstall), we delete your store configuration, credentials and operational records from our systems. We do not touch your own database: it is not ours to delete.

One row survives that erasure, and it is the proof that it happened: it holds a one-way fingerprint of the store domain, counts of what was deleted, and when. The fingerprint leads back to no store; someone holding the domain, however, can recompute it and confirm the erasure took place.

## 8. Requests from your customers

Shopify forwards customer privacy requests to us automatically, and the app answers them:

**Access request** — the app collects from your database what has been written about that person: their customer row, their orders and those orders' lines, and the browsers linked to them. The export is prepared and made available to you inside the app, where you download it with your admin session: it is never placed at a public address. **It stays on our systems for at most 30 days**, then deletes itself.

**Erasure request** — the customer's row is permanently deleted from your database, along with the rows of the browsers linked to that person. **Orders are not deleted**: they are accounting records you are required to keep, and deleting them would change your revenue. They are stripped of what leads back to the person — customer identifier, first and last name — and become indistinguishable from a purchase made without an account. The action is recorded in your logs.

If a customer contacts you directly, you can also delete their record yourself: it is your database.

## 9. Your rights

Where we act as controller for your account information, you may request access, correction, deletion, restriction, portability, or object to processing, by writing to support@coreward.app. You also have the right to lodge a complaint with your data protection authority.

Where we act as processor, requests concerning your customers should be addressed to you as the controller; we assist you in answering them.

## 10. Changes

If we change how the app processes data, we will update this page and the date at the top. Material changes will be announced inside the app before they take effect.
