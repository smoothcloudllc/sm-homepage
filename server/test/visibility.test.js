import { describe, it, expect } from 'vitest';
import { resolveVisibleApps } from '../src/services/visibility.service.js';

const apps = [
  { id: 1, visibility: 'public', groupIds: [] },
  { id: 2, visibility: 'restricted', groupIds: [10] },
  { id: 3, visibility: 'restricted', groupIds: [20] },
  { id: 4, visibility: 'restricted', groupIds: [10, 20] },
];

describe('resolveVisibleApps (regla de visibilidad)', () => {
  it('una app pública es visible para cualquiera', () => {
    const result = resolveVisibleApps(apps, [], [1]);
    expect(result.map((a) => a.id)).toContain(1);
  });

  it('una app restringida es visible solo para miembros del grupo asignado', () => {
    // Usuario sin grupos: solo ve la pública.
    const none = resolveVisibleApps(apps, [], [1]);
    expect(none.map((a) => a.id)).toEqual([1]);

    // Usuario del grupo 10: ve pública + app 2 y app 4.
    const g10 = resolveVisibleApps(apps, [10], [1]);
    expect(g10.map((a) => a.id).sort()).toEqual([1, 2, 4]);

    // Usuario del grupo 20: ve pública + app 3 y app 4.
    const g20 = resolveVisibleApps(apps, [20], [1]);
    expect(g20.map((a) => a.id).sort()).toEqual([1, 3, 4]);
  });

  it('un usuario en 2 grupos ve la unión de sus apps', () => {
    const g10and20 = resolveVisibleApps(apps, [10, 20], [1]);
    expect(g10and20.map((a) => a.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it('sin apps públicas en publicAppIds, una app pública no se muestra', () => {
    const result = resolveVisibleApps(apps, [], []);
    expect(result.map((a) => a.id)).toEqual([]);
  });

  it('es determinista (misma entrada -> misma salida)', () => {
    const a = resolveVisibleApps(apps, [10, 20], [1]);
    const b = resolveVisibleApps(apps, [10, 20], [1]);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });

  it('acepta ids de grupo como strings en el usuario', () => {
    const g10str = resolveVisibleApps(apps, ['10'], [1]);
    expect(g10str.map((a) => a.id).sort()).toEqual([1, 2, 4]);
  });
});
