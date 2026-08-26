# CoreWard — Privacy Policy

**Last updated:** 25-08-2026
**Version:** 1.0

## 1. Who we are

CoreWard is an application for Shopify stores, operated by Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148, Genoa (GE), Italy, VAT IT02705860993. You can reach us at support@coreward.app.

## 2. Our role, and yours

CoreWard installs into your Shopify store and copies part of your store's data into **a database that you own** — a Supabase project connected to your own account. That distinction determines who is responsible for what.

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

It also processes the customer's **default address** — street, postcode, region and country — plus two fields left at your disposal: an external identifier and a date of birth. The app does not fill those two in: Shopify does not expose them as customer fields, and they stay empty until you decide which metafield to read them from.

Why the address: country and postcode are what advertising platforms use to recognise your customers among their own users, and without them the audience you build comes out smaller than it really is. For the same reason the phone number is written as digits only, international prefix included, and the date of birth as `YYYYMMDD`: that is the form those platforms compare.

Customers who have not given consent are never copied into your database.

**If a customer withdraws consent**, their record is not deleted — deleting it would destroy history you may need — but it is marked as no longer consenting, and any read request for that customer is refused from that moment on.

### 3.4 Orders

Where you have granted the app access to your orders, it processes: order ID and number, the customer's ID and first and last name, currency, total, financial status, cancellation date, order date, and for each line the product and variant, quantity, unit price paid and line discount.

From **orders** the app deliberately does **not** take addresses, email addresses, phone numbers, order notes, or payment details. Those are not needed to calculate profit, so they are not taken.

The customer address described in 3.3 is a different thing: it is the default address on the customer record, for customers who have given marketing consent, and it is not derived from orders.

### 3.5 Operational records

To run and support the app we keep, in our own database: a record of each synchronisation (type, outcome, timestamps, and how many records were added, updated or removed), product-level entries identifying which products changed, your billing charges, and access records for the read interface (outcome and HTTP status only).

Records about **customers** in our own database are **counts only**. No customer name, email, phone or identifier is written to our systems by the synchronisation.

## 4. Where the data is stored

**Your data lives in your own database.** The Supabase project connected during setup belongs to your Supabase account, in the region you chose. We do not own it, cannot transfer it, and cannot access it after you disconnect the app.

**Our own database** holds the operational records in section 3.5, along with your store configuration and encrypted credentials. It is hosted in the European Union.

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

Data in **your** database is kept for as long as you decide. The app does not delete it on a schedule.

**When you uninstall the app**, your data stays where it is — in your database, which remains yours — and our session with your store ends. We keep our operational and billing records for as long as required for accounting and legal purposes.

**When Shopify asks us to erase your store** (the shop redaction request sent 48 hours after uninstall), we delete your store configuration, credentials and operational records from our systems. We do not touch your own database: it is not ours to delete.

## 8. Requests from your customers

Shopify forwards customer privacy requests to us automatically, and the app answers them:

**Access request** — we collect the customer's synchronised record so you can provide it.

**Erasure request** — the customer's record is permanently deleted from your database, and the action is recorded in your logs.

If a customer contacts you directly, you can also delete their record yourself: it is your database.

## 9. Your rights

Where we act as controller for your account information, you may request access, correction, deletion, restriction, portability, or object to processing, by writing to support@coreward.app. You also have the right to lodge a complaint with your data protection authority.

Where we act as processor, requests concerning your customers should be addressed to you as the controller; we assist you in answering them.

## 10. Changes

If we change how the app processes data, we will update this page and the date at the top. Material changes will be announced inside the app before they take effect.
