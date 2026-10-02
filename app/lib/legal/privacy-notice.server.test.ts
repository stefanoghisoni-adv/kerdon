import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    privacyNoticeAcknowledgement: { findUnique, upsert },
  },
}));

const { privacyNoticeDue, acknowledgePrivacyNotice } = await import('./privacy-notice.server');
const { PRIVACY_POLICY_VERSION } = await import('./policy-version');

const tabellaAssente = () =>
  new Prisma.PrismaClientKnownRequestError('The table does not exist', {
    code: 'P2021',
    clientVersion: 'test',
  });

const negozio = { id: 'shop-1', installedAt: new Date('2026-09-01T10:00:00Z') };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('privacyNoticeDue', () => {
  it('si mostra a chi non ha mai visto l\'avviso', async () => {
    findUnique.mockResolvedValue(null);
    expect(await privacyNoticeDue(negozio)).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      select: { versionSeen: true },
    });
  });

  it('non si mostra a chi ha visto la versione corrente', async () => {
    findUnique.mockResolvedValue({ versionSeen: PRIVACY_POLICY_VERSION });
    expect(await privacyNoticeDue(negozio)).toBe(false);
  });

  it('si mostra a chi ha visto una versione precedente', async () => {
    findUnique.mockResolvedValue({ versionSeen: '1.4' });
    expect(await privacyNoticeDue(negozio)).toBe(true);
  });

  it('tabella non ancora creata: si mostra, e non si rompe niente', async () => {
    // Un avviso legale che non si vede e' la promessa non mantenuta; uno che
    // si vede una volta di troppo costa un clic.
    findUnique.mockRejectedValue(tabellaAssente());
    expect(await privacyNoticeDue(negozio)).toBe(true);
  });

  it('un guasto qualsiasi della lettura non ferma la Dashboard', async () => {
    findUnique.mockRejectedValue(new Error('connection reset'));
    expect(await privacyNoticeDue(negozio)).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('acknowledgePrivacyNotice', () => {
  it('registra la versione corrente, sovrascrivendo quella vecchia', async () => {
    upsert.mockResolvedValue({});
    expect(await acknowledgePrivacyNotice('shop-1')).toBe(true);
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      create: { shopId: 'shop-1', versionSeen: PRIVACY_POLICY_VERSION },
      update: { versionSeen: PRIVACY_POLICY_VERSION, seenAt: expect.any(Date) },
    });
  });

  it('e\' idempotente: due clic, una riga sola con la stessa versione', async () => {
    upsert.mockResolvedValue({});
    await acknowledgePrivacyNotice('shop-1');
    await acknowledgePrivacyNotice('shop-1');
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [arg] of upsert.mock.calls) {
      expect(arg.where).toEqual({ shopId: 'shop-1' });
      expect(arg.update.versionSeen).toBe(PRIVACY_POLICY_VERSION);
    }
  });

  it('se non puo\' scrivere lo dice, senza sollevare', async () => {
    upsert.mockRejectedValue(tabellaAssente());
    expect(await acknowledgePrivacyNotice('shop-1')).toBe(false);
    upsert.mockRejectedValue(new Error('boom'));
    expect(await acknowledgePrivacyNotice('shop-1')).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
