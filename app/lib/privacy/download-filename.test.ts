import { describe, it, expect } from 'vitest';
import { filenameFromDisposition } from './download-filename';

describe('il nome del file da scaricare', () => {
  it('lo legge dall intestazione, con e senza virgolette', () => {
    expect(filenameFromDisposition('attachment; filename="coreward-demo-2026-09-05.json"')).toBe(
      'coreward-demo-2026-09-05.json',
    );
    expect(filenameFromDisposition('attachment; filename=coreward.json')).toBe('coreward.json');
  });

  it('regge la forma con la codifica dichiarata', () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''coreward%20dati.json")).toBe(
      'coreward dati.json',
    );
  });

  it('senza intestazione non inventa un nome', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
  });

  it('un percorso non arriva mai al disco', () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe(
      '..-..-etc-passwd',
    );
  });
});
