--liquibase formatted sql

--changeset uptime:001-accounts
CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    login text NOT NULL UNIQUE,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    must_change_password boolean NOT NULL,
    active boolean NOT NULL,
    is_admin boolean NOT NULL,
    is_reviewer boolean NOT NULL
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id),
    expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_account_id_idx ON sessions (account_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
