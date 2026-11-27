--liquibase formatted sql

--changeset uptime:004-risk-occurrences
CREATE TABLE risk_occurrences (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES risks(id),
    author_id uuid NOT NULL REFERENCES accounts(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    text text,
    url text,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (text IS NOT NULL OR url IS NOT NULL)
);

CREATE INDEX risk_occurrences_page_idx ON risk_occurrences (risk_id, created_at DESC, id DESC);
