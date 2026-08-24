# CoreWard — Data Processing Agreement: annexes

**Last updated:** {{DATE}}

> These are the annexes to a data processing agreement between the merchant (**controller**) and {{LEGAL_ENTITY}} (**processor**), under Article 28 GDPR. The body of the agreement — liability, audit rights, term, governing law — is standard and should come from your lawyer. What follows is the part that requires knowing the application, and it has been written against its source code.
>
> **Placeholders:** `{{LEGAL_ENTITY}}`, `{{REGISTERED_ADDRESS}}`, `{{CONTACT_EMAIL}}`, `{{DATE}}`.

## Annex I — The processing

### A. Parties

**Controller:** the Shopify merchant who installs the application.
**Processor:** {{LEGAL_ENTITY}}, {{REGISTERED_ADDRESS}}, contact {{CONTACT_EMAIL}}.

### B. Description

**Subject matter.** Copying the merchant's product catalogue, consenting customers and orders from Shopify into a database owned by the merchant, keeping that copy current, and computing profitability figures from it.

**Duration.** For as long as the application is installed, and thereafter only as needed to meet legal obligations.

**Nature and purpose.** Reading from the Shopify Admin API; writing to the merchant's own database; writing a cost value back to Shopify when the merchant asks; calculating profit per order and per customer; producing operational logs.

**Categories of data subjects**

- The merchant's customers who have given marketing consent.
- The merchant's customers who have placed an order, where order access is granted.

**Categories of personal data**

*Customers with marketing consent:* Shopify customer ID, email address, phone number, first and last name, consent state and opt-in level, total spent, order count, customer state, tags, note, verified-email flag, tax-exempt flag, timestamps.

*Orders:* order ID and number, customer ID, customer first and last name, currency, totals, financial status, cancellation and order dates, and per line the product, variant, quantity, unit price and discount.

**Data explicitly not processed:** shipping and billing addresses, email addresses and phone numbers taken from orders, order notes, payment instruments, IP addresses, browsing behaviour.

**Special categories:** none. The application neither requests nor stores special-category data.

**Frequency:** continuous, on the schedule set by the merchant's plan, plus on demand.

## Annex II — Technical and organisational measures

**Encryption at rest.** Access tokens and database keys are encrypted with AES-256-GCM before storage. The privileged key to the merchant's database is never transmitted to a browser.

**Encryption in transit.** All communication with Shopify, Supabase and the merchant's database uses TLS.

**Access control on merchant data.** Tables created by the application in the merchant's database have row-level security enabled with no public policies: a public key cannot read them. Reads through the application's interface require a token issued to that store, are limited to reading, and are restricted to an allow-list of tables.

**Consent enforcement.** Only customers with marketing consent are copied. A withdrawal of consent is recorded and, from that moment, requests concerning that customer are refused.

**Data minimisation in our own systems.** The processor's own database stores counts of customer records, never customer identities. Order data is limited to the fields listed in Annex I.

**Authenticity of instructions.** Requests received from Shopify are verified by HMAC signature before being acted upon.

**Segregation.** Each merchant's data resides in a database owned by that merchant. There is no shared data store containing several merchants' customer data.

**Logging.** Synchronisation outcomes and access attempts to the read interface are recorded, including refusals, with the outcome and HTTP status only.

## Annex III — Sub-processors

| Sub-processor | Role | Processing location |
|---|---|---|
| Shopify Inc. | Source system and billing | Per Shopify's terms |
| Supabase | Hosting of the merchant's database and of the processor's database | European Union |
| Vercel Inc. | Application hosting and execution | European Union |
| Upstash | Queue used to schedule and run synchronisations | European Union |

The processor will inform the controller of any intended change to this list, giving the controller the opportunity to object.

## Annex IV — Assistance with data subject requests

The application answers the three privacy requests Shopify forwards automatically:

**Customer data request.** The customer's synchronised record is collected and made available to the merchant, who responds to the data subject.

**Customer erasure.** The customer's record is permanently deleted from the merchant's database. The action is recorded in the merchant's logs.

**Shop erasure.** The processor deletes the store's configuration, credentials and operational records from its own systems. The merchant's own database is not touched: it belongs to the merchant, and deleting it is not the processor's decision.

## Annex V — Return and deletion

On uninstall, data in the merchant's database remains in place and under the merchant's control; the processor's session with the store ends and its access stops.

On a shop erasure request, the processor deletes the records described in Annex IV within the period required by Shopify, retaining only what accounting and legal obligations require.

No export is needed from the processor: the data already sits in a database the merchant owns and can access directly at any time.
