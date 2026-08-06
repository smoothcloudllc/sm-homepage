import { describe, it, expect } from 'vitest';
import { FakeDb } from './helpers/mockDb.js';
import sessionService from '../src/services/session.service.js';

function seedUser(db, overrides = {}) {
  const user = {
    id: db.sequence.users++,
    email: 'user@testcorp.com',
    display_name: 'Usuario',
    role: 'employee',
    status: 'active',
    session_version: 0,
    last_login_at: null,
    created_at: new Date(),
    ...overrides,
  };
  db.users.push(user);
  return user;
}

function pushSession(db, { user, token, expiresAt, revokedAt = null, version = 0, createdAt }) {
  db.sessions.push({
    id: `s-${db.sessions.length + 1}`,
    token_hash: sessionService.hashToken(token),
    user_id: user.id,
    session_version_enrolled: version,
    expires_at: expiresAt,
    created_at: createdAt || new Date(),
    revoked_at: revokedAt,
    ip: null,
    user_agent: null,
  });
}

describe('session.service', () => {
  it('crea y valida una sesión', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token = await sessionService.createSession(db, user.id, user.session_version, {
      sessionDays: 30,
    });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const session = await sessionService.validateSession(db, token);
    expect(session).not.toBeNull();
    expect(session.userId).toBe(user.id);
    expect(session.user.email).toBe('user@testcorp.com');
  });

  it('rechaza una sesión revocada', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token = sessionService.generateToken();
    pushSession(db, {
      user,
      token,
      expiresAt: new Date(Date.now() + 86400 * 1000),
      revokedAt: new Date(),
    });

    expect(await sessionService.validateSession(db, token)).toBeNull();
  });

  it('rechaza una sesión expirada', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token = sessionService.generateToken();
    pushSession(db, {
      user,
      token,
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await sessionService.validateSession(db, token)).toBeNull();
  });

  it('un cambio de session_version del usuario invalida sus sesiones', async () => {
    const db = setupDb();
    const user = seedUser(db); // session_version = 0
    const token = await sessionService.createSession(db, user.id, user.session_version, {
      sessionDays: 30,
    });
    expect(await sessionService.validateSession(db, token)).not.toBeNull();

    // Se desactiva / cambia rol -> se incrementa session_version.
    await sessionService.bumpSessionVersion(db, user.id);
    expect(await sessionService.validateSession(db, token)).toBeNull();
  });

  it('revokeAllUserSessions revoca todas las sesiones del usuario', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token1 = await sessionService.createSession(db, user.id, user.session_version, { sessionDays: 30 });
    const token2 = await sessionService.createSession(db, user.id, user.session_version, { sessionDays: 30 });

    await sessionService.revokeAllUserSessions(db, user.id);
    expect(await sessionService.validateSession(db, token1)).toBeNull();
    expect(await sessionService.validateSession(db, token2)).toBeNull();
  });

  it('rota una sesión antigua (>= umbral) y revoca la anterior (F5)', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token = sessionService.generateToken();
    pushSession(db, {
      user,
      token,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
      createdAt: new Date(Date.now() - 10 * 86400 * 1000), // hace 10 días
      version: user.session_version,
    });

    const session = await sessionService.validateSession(db, token, { rotateAfterMs: 7 * 86400 * 1000 });
    expect(session).not.toBeNull();
    expect(session.rotated).toBe(true);
    expect(session.newToken).toBeTruthy();
    expect(session.newToken).not.toBe(token);

    // El token viejo queda revocado/inválido.
    expect(await sessionService.validateSession(db, token, { rotateAfterMs: 7 * 86400 * 1000 })).toBeNull();

    // El token nuevo es válido y su ventana deslizante se reinició.
    const fresh = await sessionService.validateSession(db, session.newToken, { rotateAfterMs: 7 * 86400 * 1000 });
    expect(fresh).not.toBeNull();
    expect(fresh.rotated).toBe(false);
  });

  it('no rota una sesión joven (< umbral)', async () => {
    const db = setupDb();
    const user = seedUser(db);
    const token = sessionService.generateToken();
    pushSession(db, {
      user,
      token,
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
      createdAt: new Date(),
      version: user.session_version,
    });

    const session = await sessionService.validateSession(db, token, { rotateAfterMs: 7 * 86400 * 1000 });
    expect(session).not.toBeNull();
    expect(session.rotated).toBe(false);
    expect(session.newToken).toBeNull();
  });
});

function setupDb() {
  return new FakeDb();
}
