import { describe, it, expect } from 'vitest';
import {
  effectivePrice,
  priceForInterval,
  remainingDiscountIntervals,
  savingBadge,
} from './partner-pricing';

describe('effectivePrice', () => {
  it('traduce il prezzo riservato in listino piu sconto', () => {
    // Il merchant paga 14, ma Shopify registra 19 con 5 di sconto: e' l'unico
    // modo perche' allo scadere dei cicli il prezzo pieno riparta da solo.
    const price = effectivePrice(19, 14, 3);
    expect(price).toEqual({
      listPrice: 19,
      payablePrice: 14,
      discountAmount: 5,
      discountIntervals: 3,
    });
  });

  it('senza durata lo sconto vale per sempre', () => {
    expect(effectivePrice(79, 59, null).discountIntervals).toBeNull();
  });

  it('durata zero non significa per sempre: si ignora la durata', () => {
    // Zero cicli e' quasi sempre un campo lasciato a zero per sbaglio. Trattarlo
    // come "per sempre" regalerebbe il piano; come "mai" addebiterebbe uno
    // sconto di durata nulla. Lo si tratta come non impostato.
    expect(effectivePrice(19, 14, 0).discountIntervals).toBeNull();
    expect(effectivePrice(19, 14, -2).discountIntervals).toBeNull();
  });

  it('senza listino riservato si paga il listino pubblico', () => {
    const price = effectivePrice(19, null, 3);
    expect(price.payablePrice).toBe(19);
    expect(price.discountAmount).toBe(0);
  });

  it('un prezzo riservato piu alto del listino viene ignorato', () => {
    // Sarebbe un errore di configurazione: applicarlo alla lettera lo farebbe
    // pagare al merchant.
    const price = effectivePrice(19, 25, 3);
    expect(price.payablePrice).toBe(19);
    expect(price.discountAmount).toBe(0);
  });

  it('un prezzo riservato uguale al listino non e uno sconto', () => {
    expect(effectivePrice(19, 19, 3).discountAmount).toBe(0);
  });

  it('un prezzo riservato assurdo non passa', () => {
    expect(effectivePrice(19, -5, 3).payablePrice).toBe(19);
    expect(effectivePrice(19, Number.NaN, 3).payablePrice).toBe(19);
  });

  it('la differenza non si porta dietro le code della virgola mobile', () => {
    // 19 - 14.9 in virgola mobile fa 4.100000000000001: Shopify lo rifiuterebbe
    // o, peggio, addebiterebbe un centesimo di troppo.
    expect(effectivePrice(19, 14.9, 3).discountAmount).toBe(4.1);
  });

  it('regge il listino reale su tutti i piani', () => {
    expect(effectivePrice(19, 14, 3).discountAmount).toBe(5);
    expect(effectivePrice(49, 29, 3).discountAmount).toBe(20);
    expect(effectivePrice(79, 59, 3).discountAmount).toBe(20);
  });
});

describe('priceForInterval', () => {
  it('sceglie il prezzo del ciclo richiesto', () => {
    const price = { priceMonthly: 19, priceYearly: 290 };
    expect(priceForInterval(price, 'monthly')).toBe(19);
    expect(priceForInterval(price, 'yearly')).toBe(290);
  });
});

describe('savingBadge', () => {
  it('scrive il risparmio in valuta, non in percentuale', () => {
    // I prezzi riservati si decidono come cifre tonde: una percentuale ricavata
    // all'indietro darebbe "26,3%", che non corrisponde a niente di concordato.
    // L'importo arriva gia' scritto: qui si prova solo che il badge lo porti
    // con il segno davanti.
    expect(savingBadge(effectivePrice(19, 14, 3), '5,00 €')).toBe('− 5,00 €');
    expect(savingBadge(effectivePrice(79, 59, null), '20,00 €')).toBe('− 20,00 €');
  });

  it('senza sconto non c e nessun badge', () => {
    expect(savingBadge(effectivePrice(19, null, null), '5,00 €')).toBeNull();
  });
});
