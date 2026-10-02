# Kerdon — Privacy Policy

**Last updated:** 02-10-2026
**Version:** 1.5

## 1. Who we are

Kerdon is an application for Shopify stores, operated by Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148, Genoa (GE), Italy, VAT IT02705860993. You can reach us at support@kerdon.io.

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

It also processes the customer's **default address** — street, city, postcode, region and country — the **date of birth**, and an **external identifier**. Those last two do not stay empty: the app writes them, and how it writes them is set out below.

**The date of birth.** Shopify does not expose it as a customer field: it lives in a customer metafield. The app reads the field you point it at — Shopify's standard `facts.birth_date` field, or a date metafield that already exists in your store — and copies its value into your database. From the Customers tab you can also ask the app to enable the standard `facts.birth_date` definition for you: that is what the customer write permission the app requests at install is for.

**The date of birth is also written back to Shopify.** Where your database holds a date and the Shopify metafield is empty, the app writes that value into the very metafield it reads from. This applies only to customers who have given marketing consent, only if you have pointed the app at a field to read the date from, and only if that field is a date field. The app never overwrites a value Shopify already holds, writes nothing when what it finds in your database is not a date, and touches no other field on the customer record: it does not create customers and does not change their name, email, phone or address. It is still the writing of personal data back to Shopify, and it is declared here because that is what it is.

**The external identifier.** It is written by the visitor recognition described in 3.5: when a browser is linked to a customer, that customer's row records the identifier of the browser the person is browsing from at that moment.

Why the address: country and postcode are what advertising platforms use to recognise your customers among their own users, and without them the audience you build comes out smaller than it really is. For the same reason the phone number is written as digits only, international prefix included, and the date of birth as `YYYYMMDD`: that is the form those platforms compare.

Customers who have not given consent are never copied into your database.

**If a customer withdraws consent**, their record is not deleted — deleting it would destroy history you may need — but it is marked as no longer consenting, and any read request for that customer is refused from that moment on.

### 3.4 Orders

Where you have granted the app access to your orders, it processes: order ID and number, the customer's ID and first and last name, currency, total, financial status, cancellation date, order date, and for each line the product and variant, quantity, unit price paid and line discount.

From **orders** the app deliberately does **not** request or store addresses (beyond the country, described below), email addresses, phone numbers, order notes, or payment details. Those are not needed to calculate profit. The notification Shopify sends when an order or a return changes may contain them: it is discarded on receipt, and only the identifiers — of the order, the return, the customer and, for visitor recognition, the browser — are kept.

**Shipping and logistics data.** The app also reads what it needs to work out what each order cost you to ship, to pack and, if it came back, to take back. That logistics cost is subtracted from the order's profit, and from there it flows into profit and lifetime value per customer. Without it, every order would look more profitable than it really was. These are the items, and what happens to each:

| Item | What it is, and why it is needed | Where it ends up |
|---|---|---|
| Shipping country | The two-letter country code of the order's shipping address. It picks the shipping zone, and so the rate. | Your database, `shipping_country_code` |
| Whether the order needs shipping | Shopify's flag saying the order has something to deliver. It tells a missing address apart from an order with nothing to send. | Not stored: used while the order is processed |
| Fulfilment status | Whether the order has left. An order that never left pays no shipping or packaging. | Your database, `fulfillment_status` |
| Tracking numbers | Read only to count how many separate parcels left, for rates charged per parcel. | Not stored: only the count is kept |
| Parcel count | The number of parcels that left, worked out from the tracking numbers and fulfilment status. | Your database, `package_count` |
| Shipping method | The name of the shipping option chosen at checkout ("Standard", "Express"), matched to the cost you set for that option. | Your database, `shipping_method` |
| Delivery category | Whether that option is a delivery or a pick-up. A pick-up has no address, and needs none. | Not stored: used while the order is processed |
| Total weight | The order's weight in grams, as Shopify declares it, for rates charged by weight. | Your database, `total_weight_grams` |
| Item count | The units in the order the customer still has. It estimates the weight when Shopify declares none. | Your database, `item_count` |
| Returns | The status and creation date of each return on the order. Only an open or closed return counts, and it adds the cost of taking goods back. | Your database, `returned_at` (the date of the first such return) |
| Packaging category | The value of the order metafield `custom.packaging_category`, where your store uses it, matched to the packaging costs you set. | Your database, `packaging_category` |
| Logistics cost | Shipping, packaging and return cost for the order, calculated by the app from the items above and your rates. | Your database, `logistics_cost`, with `logistics_facts_version`, which records the version of the rules that produced it |

Three points are worth stating plainly:

- **The country, not the address.** From the order's shipping address the app asks Shopify for the country code alone. Street, city, postcode and the recipient's name are not requested and not stored; the notification Shopify sends may contain them, and it is discarded on receipt.
- **Tracking numbers are counted, not kept.** The app reads them while it processes the order, counts the distinct ones, and discards them; those that arrive in a notification from Shopify are discarded on receipt. No tracking number is written to your database, to ours, or to our logs.
- **Returns are a status and a date.** The app does not request or store the reason for a return, the items returned, or any message from the customer; the return notification Shopify sends may contain them, and it is discarded on receipt.

The rates themselves — your shipping zones, the cost of each option, your packaging categories and the cost of a return — are configuration you set in the app, and they are kept in our database. They say nothing about your customers. What is kept about each order is in yours.

These items live on the order and follow it: they are kept for as long as you keep your data, and when an order is deleted in Shopify the app deletes it, and them, from your database. An access request includes them with the person's orders; an erasure request clears the shipping country together with the customer's identifier and name (see section 8).

The customer address described in 3.3 is a different thing: it is the default address on the customer record, for customers who have given marketing consent, and it is not derived from orders.

### 3.5 Visitor recognition

If you enable visitor recognition, the app keeps a `users` table in **your** database, with **one row per browser**. Each row holds:

- a **pseudonymous browser identifier**, minted by the app (the prefix `kerdon_` followed by 32 random characters) and kept in a cookie issued by your own domain. Identifiers minted under the app's former name, with the prefix `corew_`, remain valid and are still accepted: refusing them would mean minting a new identifier for everyone who comes back;
- the **browser label** and the **device-type label** — "Chrome", "mobile" and the like — when your tracking endpoint sends them;
- the **first and last time** that browser was seen;
- the **link to the Shopify customer**, written when the person identifies themselves by leaving an email address or phone number, or when they buy and the browser identifier arrives with the order;
- the **merging of identifiers**: when several browsers turn out to belong to the same person, the more recent ones record which is the oldest, and that one becomes the reference. No row is deleted for this.

**This is not anonymous data, and should not be called that.** The identifier holds no name, but it lives in that person's browser and, from the moment it is linked to a customer, it says which devices that person uses and when they used them. It is personal data and is treated as such.

**Consent comes first.** Without the visitor's permission — which the app reads from the Shopify Customer Privacy signals your endpoint forwards — no identifier is minted and no row is written. On withdrawal, writes stop, that browser's row is deleted along with the links that joined it to the others, and the app expires the cookie it had issued on its own domain. The cookie planted by your domain is yours: your endpoint is the only thing that can remove it.

**Cookies on your store's domain.** The browser identifier travels in a cookie. When your server-side tag container uses the Kerdon template, these are the cookies it writes on your store's domain, and it writes nothing else:

| Cookie | Written by, and when | Purpose | Requested duration | Content | Attributes |
| --- | --- | --- | --- | --- | --- |
| `kerdon_eid` | Your server-side container, on your store's domain, only with the visitor's consent | Recognising the same browser when it comes back | One year by default, set in the template. It is the maximum requested, not a guarantee: the browser may shorten it, the person can delete it at any time, and on withdrawal it expires at once | A random, opaque identifier (`kerdon_` followed by 32 random characters). No name, email address or other data | `Secure`, `SameSite=Lax`, `Path=/`. Not `HttpOnly`, so that your page tags can read it and attach it to the cart |
| `kerdon_rv` | Your server-side container, on your store's domain, only after a withdrawal of consent that Kerdon has not yet confirmed | Keeping the withdrawal until Kerdon confirms the deletion, so that it is not lost if the connection drops. It is never used to recognise anyone | 30 days at most; it expires as soon as Kerdon confirms | A withdrawal marker and the identifiers to delete (at most three) | `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` |
| `corew_eid` | Nobody, any longer | The former name of `kerdon_eid`, from before the app was renamed. A browser may still hold one; Kerdon neither writes it nor uses its value | — | — | — |

The template also reads, without writing them, the consent signals already on your domain: Shopify's `_tracking_consent` cookie and, where your own tags write one, `kerdon_consent` (formerly `corew_consent`). When your endpoint calls Kerdon, Kerdon's reply also carries a `kerdon_eid` cookie for Kerdon's own domain (`Secure`, `SameSite=None`, up to one year, expired on withdrawal); with the Kerdon template that reply stays with your container and is not passed on to the visitor's browser.

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

**A paused project, though, the app can restart on its own initiative.** A free Supabase project nobody touches for a while is paused: all the data stays where it is, but the database stops answering and synchronisation halts. From then on time matters, because the pause does not last forever: **once the restore window closes the project can no longer be recovered**, and all that is left of your data is backups to download.

The app notices in two ways: when a read of your database fails, and through a periodic check covering shops whose database has shown no sign of life for a while — so even if you never open the app. It tells you with a notice and offers you a button to restart it. If you do not press that button, **before the restore window closes we make the request ourselves**, using the credentials you granted us when you connected your Supabase account, and we tell you so. The notice lives inside the app: we do not send you email.

**Restarting is not reading.** For this action the app asks Supabase to bring the project back up, and nothing else: it does not open your tables, and reads, writes and deletes nothing of what they hold. When the database answers again, synchronisation resumes on its own, and that is once more the processing described above.

**It is not a promise that your database will be saved, and we do not do it for everyone.** If Supabase refuses the request — because our access lacks the permission, because the link with your account is no longer valid, or because the window has already closed — the database stays down, and restarting it from your project's own page remains something only you can do. We do not act on the database of a store that has uninstalled the app, of one Shopify has asked us to erase, or of one whose link to the Supabase account has lapsed: there we have neither the mandate nor the credentials.

**You can switch it off.** Settings → Database holds a toggle for automatic restarting. With it off, the notice and the button stay where they are: all that changes is that if you do not press it, nobody does.

**Our own database** holds the operational records in section 3.6, along with your store configuration — including the shipping zones, rates, packaging categories and return cost you set — and encrypted credentials. It is hosted in the European Union.

## 5. Who else is involved

| Provider | Purpose | Location |
|---|---|---|
| Shopify | Source of store, product, customer and order data; billing | As per Shopify's own terms |
| Supabase | Your database, and our own database | European Union |
| Vercel | Application hosting | European Union |
| Upstash | Cache of the counts the app shows you — products ready, customers, and the like — and, when enabled, anti-abuse counters for writes (internal store identifier, key identifier, time window; no personal data) | European Union |

**We do not sell data.** Not yours, not your customers', to anyone, in any form. And we do not use it to train models.

Beyond the providers listed above — who act on our instructions and not on their own behalf — we do not pass data to anyone else. In particular, **we** are not the ones sending it to advertising or analytics platforms.

What the app does is put the data **in your own database** and make it available to you. From there it is your call: if you use it to build an audience on an advertising platform, you are the one sending it, you are the controller, and the legal basis is the consent your customer gave in your store. That is precisely why the app synchronises only those who gave that consent, and stops answering for those who withdraw it.

## 6. Security

Access tokens and database keys are encrypted at rest with AES-256-GCM. The privileged key to your database is never sent to a browser.

Tables created by the app in your database have row-level security enabled with no public policies: they cannot be read with a public key.

The read interface requires a token issued to your store, is limited to reading, and refuses requests for customers who have withdrawn consent.

**Reading and writing are two separate credentials.** The token that reads your data is not the one that writes the visitor-recognition rows: the two are generated independently, and neither can be worked out from the other. Handing your read token to an agency hands them reading, and nothing else. The writing credential is shown to you once, is rotated and revoked without touching the read one, and carries its own permissions — minting a browser identifier, writing the browser and device labels, and linking a browser to a customer are three distinct permissions, and each endpoint asks only for the one it needs. Where the caller can sign its requests, the credential itself never travels: what travels is a signature, valid for a few minutes and for this recipient only.

**The credentials of your Supabase account** — the ones you granted us when you connected it — are encrypted like all the others. With them the app prepares your project, reads its status and, when it is found down, asks for it to be restarted. That last one is the only thing the app does to your project without you having asked it each time, and it is also why it can be switched off: see section 4.

Requests from Shopify are verified by signature before being acted upon.

## 7. How long data is kept

Data in **your** database is kept for as long as you decide. The app does not delete it on a schedule, with one exception: rows for browsers never linked to a customer are deleted 90 days after they were last seen. The shipping and logistics data in 3.4 is part of the order it describes: it stays as long as the order does, and goes when the order is deleted in Shopify.

**In our own database**: access records for the read interface are kept for 12 months and then deleted; exports prepared for an access request for at most 30 days; repair rows and privacy requests until they close, as described in 3.6. Webhook events delivered by Shopify are deleted 7 days after they complete. A withdrawal of recognition consent is deleted 7 days after it has been applied; where one gets stuck and is never applied, its encrypted content is cleared after 30 days and only the unreadable proof of it remains.

**When you uninstall the app**, your data stays where it is — in your database, which remains yours — and our session with your store ends. We keep our operational and billing records for as long as required for accounting and legal purposes.

**When Shopify asks us to erase your store** (the shop redaction request sent 48 hours after uninstall), we delete your store configuration, credentials and operational records from our systems. We do not touch your own database: it is not ours to delete.

One row survives that erasure, and it is the proof that it happened: it holds a one-way fingerprint of the store domain, counts of what was deleted, and when. The fingerprint leads back to no store; someone holding the domain, however, can recompute it and confirm the erasure took place.

## 8. Requests from your customers

Shopify forwards customer privacy requests to us automatically, and the app answers them:

**Access request** — the app collects from your database what has been written about that person: their customer row, their orders — shipping and logistics data included — and those orders' lines, and the browsers linked to them. The export is prepared and made available to you inside the app, where you download it with your admin session: it is never placed at a public address. **It stays on our systems for at most 30 days**, then deletes itself.

**Erasure request** — the customer's row is permanently deleted from your database, along with the rows of the browsers linked to that person. **Orders are not deleted**: they are accounting records you are required to keep, and deleting them would change your revenue. They are stripped of what leads back to the person — customer identifier, first and last name, and the shipping country, the only item taken from their address — and are no longer linked to the person in your database. They are also marked with the date of the erasure (`customer_redacted_at`): from then on, no later update from Shopify can put those details back. The other logistics data in 3.4 describes the parcel, not the person, and stays on the order, and the logistics cost already calculated for it is kept as it is, so that your costs and profit still add up. The action is recorded in your logs.

If a customer contacts you directly, you can also delete their record yourself: it is your database.

## 9. Your rights

Where we act as controller for your account information, you may request access, correction, deletion, restriction, portability, or object to processing, by writing to support@kerdon.io. You also have the right to lodge a complaint with your data protection authority.

Where we act as processor, requests concerning your customers should be addressed to you as the controller; we assist you in answering them.

## 10. Changes

If we change how the app processes data, we will update this page and the date at the top. Material changes will be announced inside the app before they take effect.
