# Data Processing Agreement (DPA) — Kerdon

Last updated: 17 September 2026

> This agreement is accepted together with the terms of service, when the app is
> installed.
>
> This English text is the binding version. An Italian courtesy translation is
> available in `dpa.it.md`; in case of discrepancy, this version prevails.

## The parties

**Controller**: the merchant, meaning the holder of the Shopify store on which
Kerdon is installed.

**Processor**: Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genoa (GE),
Italy, VAT IT02705860993, contact support@kerdon.io.

The merchant determines the purposes and means of processing its customers' data.
Kerdon processes that data solely to provide the service, and solely on the
merchant's instruction.

## 1. Subject matter and duration

Kerdon synchronises the catalogue, customer and order data of the merchant's
Shopify store into a database project held by the merchant, keeps that copy
current, and computes profitability figures from it.

The agreement lasts as long as the app is installed and ends on uninstall.

## 2. Nature and purpose

Collection from Shopify, transformation, writing to the merchant's database,
updating, and controlled reading.

Two things only are written back to Shopify: a **product's cost**, on the
merchant's request, and a **customer's date of birth** — the value held in the
merchant's database, written into the customer metafield Kerdon reads it from,
where that metafield is empty and the customer has given marketing consent. No
other field of the customer record is created or changed.

Where the merchant enables the feature, Kerdon also processes **visitor
recognition** for the store, described in section 3.

Purpose: to let the merchant use its own commercial data to measure the
profitability of its orders and its customers.

## 3. Categories of data and data subjects

**Data subjects**: customers and prospective customers of the merchant's store.

**Customer data**: Shopify identifier, email address, telephone number, first
name, last name, marketing consent state and opt-in level, total spent, number of
orders, customer state, tags, note, default address (street, postcode, region,
country), the date of birth — read from the customer metafield the merchant
points to — and an external identifier, which is the identifier of the browser
the person is browsing from.

**Order data**: order identifier and number, customer identifier, customer first
and last name, currency, totals, financial status, order date and any
cancellation date and, for each line, product, variant, quantity, unit price and
discount.

**Visitor recognition data** (only where the merchant enables the feature, and
only for visitors who have given consent): a pseudonymous browser identifier
minted by Kerdon, the browser label and the device-type label where the
merchant's endpoint sends them, the first and last time the browser was seen, the
merging of identifiers found to belong to the same person, and the link to the
Shopify customer identifier. This is not anonymous data: the identifier stays in
a person's browser and, once linked to a customer, is attributable to them. To
write that link, the merchant's endpoint sends Kerdon the email address or
telephone number the person has just given; Kerdon uses them only to search the
merchant's database and does not retain them.

**Explicit exclusions**: no payment data; no address, email address, telephone
number or note is taken from orders; no shipping data — no carrier, tracking
number, label or shipping cost, since labels are bought outside Shopify and all
that remains of delivery is what the customer paid at checkout; no IP address; no
record of pages visited; no special category of data within the meaning of
Article 9 GDPR.

The address processed is the default address on the customer record, not a
shipping or billing address derived from an order. A date of birth is not a
special category within the meaning of Article 9.

**Limit of the processing**: among customers, only the data of those who have
given marketing consent on Shopify is processed.

## 4. Obligations of the processor

Kerdon undertakes to:

a) process the data only on the documented instruction of the merchant, save for
legal obligations, of which it will give notice unless the law forbids it;

b) bind to confidentiality anyone with access to the data;

c) adopt the security measures described in section 6;

d) engage no sub-processors other than those listed in section 5 without prior
notice to the merchant, who may object;

e) assist the merchant in responding to requests from data subjects;

f) assist the merchant with its security, breach notification and impact
assessment obligations;

g) make available the information necessary to demonstrate compliance with these
obligations.

## 5. Authorised sub-processors

| Provider | Role | Data processed |
|---|---|---|
| Vercel Inc. | Running the application | Data in transit during processing |
| Supabase Inc. | The application's database | Configuration, encrypted credentials, records |
| Upstash Inc. | Cache of the counts shown in the app | Internal store identifier and aggregate counts only |

The catalogue and customer database does **not** appear in this table: it is held
by the merchant, who has a direct contractual relationship with its own provider.
Kerdon accesses it on the merchant's instruction.

## 6. Security measures

- Encryption in transit (HTTPS/TLS) on every communication
- Encryption of secrets at rest with AES-256-GCM
- Encryption at rest and encrypted backups on the application's database
- Row Level Security enabled on all of the application's tables, with no public
  access policies
- The read interface is limited to reading, and to the tables covered by the plan
- Separate credentials for reading and for writing, generated independently, each
  rotated and revoked without touching the other, and each carrying its own scopes
- Verification of consent on every read of customer data
- A record of every access to personal data, retained for 12 months
- Separate development and production environments, on distinct databases
- Access to production systems limited to the processor alone

## 7. Data breaches

Kerdon informs the merchant **without undue delay** and in any event within 72
hours of becoming aware of a breach affecting its data, stating the nature of the
event, the data and data subjects concerned, the likely consequences and the
measures taken.

The full procedure is set out in `INCIDENT-RESPONSE.md`, available on request.

## 8. Rights of data subjects

Kerdon acts on the access and erasure requests it receives through the channels
Shopify provides.

**Access**: Kerdon collects from the merchant's database the customer's row,
their orders and those orders' lines, and the rows of the browsers linked to
them. The resulting export contains personal data and is held on Kerdon's
systems, where the merchant downloads it inside the app with their own admin
session, **for at most 30 days**; it is deleted when that period expires.

**Erasure**: the customer's row is permanently deleted from the merchant's
database, along with the rows of the browsers linked to them. Orders are not
deleted — they are accounting records the merchant is required to keep (Article
17(3)(b) and (e) GDPR) — but are stripped of the customer identifier and of the
customer's first and last name.

## 9. On termination

On uninstall, Kerdon ceases all processing: synchronisation stops and the
Shopify session credentials are deleted.

**Data already synchronised remains in the merchant's database**, of which the
merchant is the holder, and which the merchant may delete at any time from its
own project.

That data passes through Kerdon's infrastructure as it is written or read back,
and in four limited cases it remains written there: pending repairs, which carry
a customer's Shopify identifier and, for the date of birth, the value still to be
written back; the signed message of a privacy request, until that request closes;
the export prepared for an access request, for at most 30 days; and the browser
identifier and customer identifier on a consent withdrawal, encrypted and cleared
as soon as the withdrawal is applied. None of the four outlives its reason to
exist.

## 10. Transfers outside the EU

The application's database resides in the European Union (Paris, France), and
processing likewise takes place in the European Union: the application's
functions run in the Paris region.

The synchronisation job queue lives in the application's own database, and so in
the same region. The cache of the counts shown in the app resides in the European
Union too (Frankfurt, Germany): it holds an internal store identifier and
aggregate counts — no personal data.

Every component operated by Kerdon is therefore located in the European Union,
and the merchant chooses the region of its own database.

The providers listed in section 5 are United States companies delivering the
service from European infrastructure: for ancillary functions that may involve
access from the United States (support, maintenance), the safeguards provided in
their respective agreements apply — standard contractual clauses and, where
applicable, the EU-US Data Privacy Framework.

## 11. Audit

The merchant may request the information necessary to verify compliance with this
agreement, by writing to support@kerdon.io.
