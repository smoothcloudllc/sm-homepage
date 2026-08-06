import { describe, it, expect } from 'vitest';
import { FakeDb } from './helpers/mockDb.js';
import otpService from '../src/services/otp.service.js';

function setup() {
  return new FakeDb();
}

describe('otp.service', () => {
  it('genera y valida un código correcto', async () => {
    const db = setup();
    const code = await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });
    expect(code).toMatch(/^\d{6}$/);

    const active = await otpService.findActiveOtp(db, 'user@testcorp.com');
    expect(active).not.toBeNull();
    expect(await otpService.verifyCode(code, active.code_hash)).toBe(true);
  });

  it('rechaza un código incorrecto', async () => {
    const db = setup();
    const code = await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });
    const active = await otpService.findActiveOtp(db, 'user@testcorp.com');
    const wrong = code === '000000' ? '000001' : '000000';
    expect(await otpService.verifyCode(wrong, active.code_hash)).toBe(false);
  });

  it('un código usado no es reutilizable (single-use)', async () => {
    const db = setup();
    const code = await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });
    const active = await otpService.findActiveOtp(db, 'user@testcorp.com');
    expect(await otpService.verifyCode(code, active.code_hash)).toBe(true);

    const consumed = await otpService.consumeOtp(db, active.id);
    expect(consumed).toBe(true);

    // Ya no hay OTP activo y el mismo OTP ya no se puede consumir.
    expect(await otpService.findActiveOtp(db, 'user@testcorp.com')).toBeNull();
    expect(await otpService.consumeOtp(db, active.id)).toBe(false);
  });

  it('rechaza un código expirado', async () => {
    const db = setup();
    await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });
    const active = await otpService.findActiveOtp(db, 'user@testcorp.com');
    // Expirar manualmente.
    active.expires_at = new Date(Date.now() - 1000);
    expect(await otpService.findActiveOtp(db, 'user@testcorp.com')).toBeNull();
  });

  it('una nueva solicitud invalida el código anterior (single-active-code)', async () => {
    const db = setup();
    const first = await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });
    const second = await otpService.createOtp(db, 'user@testcorp.com', { otpTtlMin: 10 });

    const active = await otpService.findActiveOtp(db, 'user@testcorp.com');
    expect(active).not.toBeNull();
    // El código activo es el segundo.
    expect(await otpService.verifyCode(second, active.code_hash)).toBe(true);
    // El primero ya fue invalidado (consumido) y no es válido contra el nuevo hash.
    expect(await otpService.verifyCode(first, active.code_hash)).toBe(false);
  });

  it('bloquea el email tras 5 fallos de verificación (lockout)', async () => {
    const db = setup();
    for (let i = 0; i < otpService.MAX_FAILED_ATTEMPTS; i++) {
      await otpService.registerFailedAttempt(db, 'user@testcorp.com');
    }
    expect(await otpService.canAttemptLogin(db, 'user@testcorp.com')).toBe(false);
    // Alcanzar el máximo se anota en login_attempts con locked_until.
    const attempts = await otpService.getLoginAttempts(db, 'user@testcorp.com');
    expect(attempts.failed_count).toBe(otpService.MAX_FAILED_ATTEMPTS);
    expect(attempts.locked_until).not.toBeNull();
  });

  it('resetea el contador tras un login exitoso', async () => {
    const db = setup();
    await otpService.registerFailedAttempt(db, 'user@testcorp.com');
    await otpService.resetLoginAttempts(db, 'user@testcorp.com');
    const attempts = await otpService.getLoginAttempts(db, 'user@testcorp.com');
    expect(attempts.failed_count).toBe(0);
  });

  it('aplica backoff exponencial al lockout: 5/15/30 min (F12)', () => {
    expect(otpService.lockoutMinutesFor(4)).toBe(0);   // por debajo del umbral
    expect(otpService.lockoutMinutesFor(5)).toBe(5);   // 1er lockout
    expect(otpService.lockoutMinutesFor(9)).toBe(5);
    expect(otpService.lockoutMinutesFor(10)).toBe(15); // 2º lockout
    expect(otpService.lockoutMinutesFor(15)).toBe(30); // 3er lockout
    expect(otpService.lockoutMinutesFor(20)).toBe(30); // techo
  });

  it('el 2º lockout aplica 15 min y el 3º 30 min', async () => {
    const db = setup();
    // Primer lockout: 5 fallos -> 5 min.
    for (let i = 0; i < otpService.MAX_FAILED_ATTEMPTS; i++) {
      await otpService.registerFailedAttempt(db, 'user@testcorp.com');
    }
    expect(await otpService.isLockedOut(db, 'user@testcorp.com')).toBe(true);
    let attempts = await otpService.getLoginAttempts(db, 'user@testcorp.com');
    const firstLockUntil = new Date(attempts.locked_until);
    expect(firstLockUntil.getTime() - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    expect(firstLockUntil.getTime() - Date.now()).toBeLessThan(6 * 60 * 1000);

    // Segundo lockout: otros 5 fallos -> 15 min.
    for (let i = 0; i < otpService.MAX_FAILED_ATTEMPTS; i++) {
      await otpService.registerFailedAttempt(db, 'user@testcorp.com');
    }
    attempts = await otpService.getLoginAttempts(db, 'user@testcorp.com');
    expect(attempts.failed_count).toBe(10);
    const secondLockUntil = new Date(attempts.locked_until);
    expect(secondLockUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(secondLockUntil.getTime() - Date.now()).toBeLessThan(16 * 60 * 1000);
  });
});
