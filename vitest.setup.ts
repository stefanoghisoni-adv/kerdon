/**
 * Quello che i test devono trovare gia' pronto, e che non devono ereditare
 * dall'ambiente.
 *
 * La suite passava in locale e falliva in CI: diciotto test dei webhook GDPR e
 * della lavorazione delle richieste di conformita'. Il motivo non era il
 * codice — era che in locale `ENCRYPTION_SECRET` arrivava per caso. Importando
 * `db.server` si costruisce un `PrismaClient`, e Prisma legge il file `.env`
 * del progetto: da li' la variabile compariva nell'ambiente senza che nessun
 * test l'avesse chiesta. In CI quel file non c'e', la firma delle impronte di
 * controllo non trovava nessuna chiave e sollevava.
 *
 * Una suite che dipende da cosa c'e' nell'ambiente non e' una suite: e' una
 * misura di quell'ambiente. Qui la chiave si dichiara, uguale ovunque giri.
 *
 * `??=` e non un'assegnazione secca: chi vuole provare un valore diverso — c'e'
 * un test che verifica cosa succede quando la chiave manca del tutto — deve
 * poterlo fare senza che questo file glielo riscriva sotto.
 */
process.env.ENCRYPTION_SECRET ??= 'chiave-di-prova-solo-per-i-test';
