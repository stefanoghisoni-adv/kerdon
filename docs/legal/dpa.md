# Data Processing Agreement (DPA) — CoreWard

Last updated: 25 August 2026

> This agreement is accepted together with the terms of service, when the app is
> installed.
>
> This English text is the binding version. An Italian courtesy translation is
> available in `dpa.it.md`; in case of discrepancy, this version prevails.

## The parties

**Controller**: the merchant, meaning the holder of the Shopify store on which
CoreWard is installed.

**Processor**: Stefano Ghisoni, Via Percy Bysshe Shelley 49/10, 16148 Genoa (GE),
Italy, VAT IT02705860993, contact support@coreward.app.

The merchant determines the purposes and means of processing its customers' data.
CoreWard processes that data solely to provide the service, and solely on the
merchant's instruction.

## 1. Subject matter and duration

CoreWard synchronises the catalogue, customer and order data of the merchant's
Shopify store into a database project held by the merchant, keeps that copy
current, and computes profitability figures from it.

The agreement lasts as long as the app is installed and ends on uninstall.

## 2. Nature and purpose

Collection from Shopify, transformation, writing to the merchant's database,
updating, and controlled reading. On the merchant's request, writing a product's
cost back to Shopify.

Purpose: to let the merchant use its own commercial data to measure the
profitability of its orders and its customers.

## 3. Categories of data and data subjects

**Data subjects**: customers and prospective customers of the merchant's store.

**Customer data**: Shopify identifier, email address, telephone number, first
name, last name, marketing consent state and opt-in level, total spent, number of
orders, customer state, tags, note.

**Order data**: order identifier and number, customer identifier, customer first
and last name, currency, totals, financial status, order date and any
cancellation date and, for each line, product, variant, quantity, unit price and
discount.

**Explicit exclusions**: no shipping or billing address, no payment data, no
email address, telephone number or note taken from orders, no IP address, no
browsing data, no special category of data within the meaning of Article 9 GDPR.

**Limit of the processing**: among customers, only the data of those who have
given marketing consent on Shopify is processed.

## 4. Obligations of the processor

CoreWard undertakes to:

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
| Upstash Inc. | Job queue | Internal store identifiers only |

The catalogue and customer database does **not** appear in this table: it is held
by the merchant, who has a direct contractual relationship with its own provider.
CoreWard accesses it on the merchant's instruction.

## 6. Security measures

- Encryption in transit (HTTPS/TLS) on every communication
- Encryption of secrets at rest with AES-256-GCM
- Encryption at rest and encrypted backups on the application's database
- Row Level Security enabled on all of the application's tables, with no public
  access policies
- Read-only access to the merchant's data, limited to the tables covered by the
  plan
- Verification of consent on every read of customer data
- A record of every access to personal data, retained for 12 months
- Separate development and production environments, on distinct databases
- Access to production systems limited to the processor alone

## 7. Data breaches

CoreWard informs the merchant **without undue delay** and in any event within 72
hours of becoming aware of a breach affecting its data, stating the nature of the
event, the data and data subjects concerned, the likely consequences and the
measures taken.

The full procedure is set out in `INCIDENT-RESPONSE.md`, available on request.

## 8. Rights of data subjects

CoreWard acts on the access and erasure requests it receives through the channels
Shopify provides. On a customer erasure request, the corresponding record is
permanently deleted from the merchant's database.

## 9. On termination

On uninstall, CoreWard ceases all processing: synchronisation stops and the
Shopify session credentials are deleted.

**Data already synchronised remains in the merchant's database**, of which the
merchant is the holder. This is not retention by the processor: that data was
never on CoreWard's infrastructure. The merchant may delete it at any time from
its own project.

## 10. Transfers outside the EU

The application's database resides in the European Union (Paris, France), and
processing likewise takes place in the European Union: the application's
functions run in the Paris region.

The synchronisation job queue also resides in the European Union (Frankfurt,
Germany). Only internal store identifiers pass through it — no personal data.

Every component operated by CoreWard is therefore located in the European Union,
and the merchant chooses the region of its own database.

The providers listed in section 5 are United States companies delivering the
service from European infrastructure: for ancillary functions that may involve
access from the United States (support, maintenance), the safeguards provided in
their respective agreements apply — standard contractual clauses and, where
applicable, the EU-US Data Privacy Framework.

## 11. Audit

The merchant may request the information necessary to verify compliance with this
agreement, by writing to support@coreward.app.
