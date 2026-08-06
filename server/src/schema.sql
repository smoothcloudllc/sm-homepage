-- =====================================================================
-- SM-HomePage — esquema PostgreSQL
-- Se ejecuta al arrancar con CREATE TABLE IF NOT EXISTS (idempotente).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email citext UNIQUE NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'employee'
    CHECK (role IN ('super_admin', 'admin', 'employee')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  session_version integer NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  session_version_enrolled integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id serial PRIMARY KEY,
  email citext NOT NULL,
  code_hash text NOT NULL,
  purpose text DEFAULT 'login',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_attempts (
  email citext PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  locked_until timestamptz
);

CREATE TABLE IF NOT EXISTS groups (
  id serial PRIMARY KEY,
  name citext UNIQUE NOT NULL,
  created_by integer REFERENCES users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  group_id integer REFERENCES groups(id) ON DELETE CASCADE,
  assigned_by integer,
  assigned_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, group_id)
);

-- Categorías gestionables como grupos de aplicaciones (agrupado del dashboard).
CREATE TABLE IF NOT EXISTS categories (
  id bigserial PRIMARY KEY,
  name citext UNIQUE NOT NULL,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
  id serial PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  icon_url text,
  icon_key text,
  icon_class text,
  description text,
  -- Columna LEGACY de agrupación libre (texto). Se conserva por rollback;
  -- marcada para drop en la fase de producción. El agrupado efectivo usa
  -- category_id -> categories.name.
  category text NOT NULL DEFAULT 'General',
  category_id bigint REFERENCES categories(id) ON UPDATE CASCADE,
  color char(7) DEFAULT '#4f8cff',
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'restricted')),
  created_by integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Migración para bases de datos EXISTENTES: CREATE TABLE IF NOT EXISTS no
-- añade columnas a una tabla ya creada, así que se declaran con ALTER TABLE
-- (idempotente). icon_key es nullable, sin FK (biblioteca local, validada
-- contra icons.json). category_id referencia categories con ON UPDATE CASCADE.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_key text;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS category_id bigint REFERENCES categories(id) ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS app_group_assignments (
  app_id integer REFERENCES apps(id) ON DELETE CASCADE,
  group_id integer REFERENCES groups(id) ON DELETE CASCADE,
  assigned_by integer,
  assigned_at timestamptz DEFAULT now(),
  PRIMARY KEY (app_id, group_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id integer,
  actor_email text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb,
  ip inet,
  created_at timestamptz DEFAULT now()
);

-- Tokens de bootstrap del super_admin (single-use).
-- Se siembra al arrancar desde BOOTSTRAP_TOKEN y se borra al consumirse.
CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  token_hash text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);

-- Configuración del portal editable en runtime (key/value).
-- PRECEDENCIA sobre env: si la clave existe aquí, gana sobre la variable de
-- entorno equivalente. NUNCA guardar secretos (solo valores de personalización).
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now(),
  updated_by integer REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes(email);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC);
