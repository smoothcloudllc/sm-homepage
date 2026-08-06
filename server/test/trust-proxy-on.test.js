import { describe, it, expect, beforeAll } from 'vitest';
import { FakeDb } from './helpers/mockDb.js';

// TRUST_PROXY=2: hay un reverse proxy de confianza (Caddy/Nginx) delante;
// la app configura app.set("trust proxy", 2) y Express confía en
// X-Forwarded-For para obtener la IP real del cliente (rate limiting correcto).
// La variable se fija ANTES de cargar el módulo (config se lee al importar).
process.env.TRUST_PROXY = '2';

let db;
let createApp;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
});

describe('TRUST_PROXY=2 — app.set("trust proxy", 2)', () => {
  it('la app confía en 2 hops de proxy', () => {
    db.setDbClient(new FakeDb());
    const app = createApp();
    expect(app.get('trust proxy')).toBe(2);
    db.setDbClient(null);
  });
});
