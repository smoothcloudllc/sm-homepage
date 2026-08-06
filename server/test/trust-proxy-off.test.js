import { describe, it, expect, beforeAll } from 'vitest';
import { FakeDb } from './helpers/mockDb.js';

// TRUST_PROXY=0 (default, red interna directa / red privada (VPN)): la app NO confía en
// ningún reverse proxy. req.ip es la IP real y un X-Forwarded-For forjado no
// altera el rate limiting ni la auditoría.
// La variable se fija ANTES de cargar el módulo (config se lee al importar).
process.env.TRUST_PROXY = '0';

let db;
let createApp;

beforeAll(async () => {
  ({ default: db } = await import('../src/db.js'));
  ({ createApp } = await import('../src/app.js'));
});

describe('TRUST_PROXY=0 — la app NO configura trust proxy', () => {
  it('app.get("trust proxy") es falsy (comportamiento actual)', () => {
    db.setDbClient(new FakeDb());
    const app = createApp();
    expect(app.get('trust proxy')).toBeFalsy();
    db.setDbClient(null);
  });
});
