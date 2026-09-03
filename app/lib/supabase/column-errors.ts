/**
 * Distinguere "questa tabella e' vecchia" da un guasto vero.
 *
 * Le tabelle dei merchant si allineano da sole, ma non tutte nello stesso
 * istante: fra il rilascio di una colonna nuova e la corsa che allinea quel
 * progetto passa del tempo, e in mezzo una lettura che nomina quella colonna
 * viene rifiutata da PostgREST. E' un caso previsto, non un errore: chi lo
 * riconosce puo' ripiegare su cio' che c'e' di sicuro invece di fermarsi.
 *
 * Sta in un file suo perche' serve dove si legge dal database del merchant, e
 * quei punti non hanno altro in comune.
 */
export function isUnknownColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const message = error.message ?? '';
  // PGRST204 e' il modo di PostgREST di dirlo; il 42703 di Postgres arriva
  // quando il messaggio passa dal database senza essere tradotto.
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    /could not find the .* column|column .* does not exist/i.test(message)
  );
}
