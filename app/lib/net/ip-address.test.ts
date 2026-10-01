import { describe, it, expect } from 'vitest';
import { isGlobalAddress, isIpLiteral } from './ip-address';

describe('isGlobalAddress — IPv4', () => {
  it.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.5',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254', // metadata dei cloud
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.10', // documentazione
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7', // documentazione
    '203.0.113.9', // documentazione
    '224.0.0.1', // multicast
    '239.255.255.250',
    '240.0.0.1', // riservati
    '255.255.255.255',
  ])('%s non e globale', (ip) => {
    expect(isGlobalAddress(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '23.227.38.65'])(
    '%s e globale',
    (ip) => {
      expect(isGlobalAddress(ip)).toBe(true);
    },
  );
});

describe('isGlobalAddress — IPv6', () => {
  it.each([
    '::',
    '::1',
    'fe80::1',
    'febf::1',
    'fc00::1',
    'fd12:3456::1', // ULA
    'ff02::1', // multicast
    '2001:db8::1', // documentazione
    '3fff::1', // documentazione
    '2001::1', // Teredo
    '100::1', // discard
    '::ffff:127.0.0.1', // IPv4 mappato verso loopback
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe', // mappato verso il metadata, in esadecimale
    '64:ff9b::a9fe:a9fe', // NAT64 verso il metadata
    '64:ff9b::192.168.0.1',
    '64:ff9b:1::1', // NAT64 a uso locale
    '2002:0a00:0001::1', // 6to4 verso 10.0.0.1
    '::127.0.0.1', // IPv4-compatibile, deprecato
    '[::1]',
    'fe80::1%eth0',
  ])('%s non e globale', (ip) => {
    expect(isGlobalAddress(ip)).toBe(false);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:0808:0808::1',
  ])('%s e globale', (ip) => {
    expect(isGlobalAddress(ip)).toBe(true);
  });
});

describe('isGlobalAddress — quel che non e un indirizzo', () => {
  it.each(['', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1:2:3', 'g::1', '1::2::3'])(
    '%s si rifiuta',
    (value) => {
      expect(isGlobalAddress(value)).toBe(false);
    },
  );
});

describe('isIpLiteral', () => {
  it('riconosce i letterali, anche fra parentesi quadre', () => {
    expect(isIpLiteral('10.0.0.5')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('2606:4700::1')).toBe(true);
    expect(isIpLiteral('negozio.it')).toBe(false);
  });
});
