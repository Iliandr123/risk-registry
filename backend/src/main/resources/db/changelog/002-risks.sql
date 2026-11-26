--liquibase formatted sql

--changeset uptime:002-risks
CREATE TABLE risks (
    id uuid PRIMARY KEY,
    published_version_id uuid,
    assessment_date date,
    CHECK ((published_version_id IS NULL) = (assessment_date IS NULL))
);

CREATE TABLE risk_versions (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES risks(id),
    author_id uuid NOT NULL REFERENCES accounts(id),
    owner_id uuid REFERENCES accounts(id),
    status text NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'WITHDRAWN', 'CLOSED')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    title text,
    cause text,
    possible_event text,
    product_consequences text,
    likelihood smallint CHECK (likelihood BETWEEN 1 AND 10),
    impact smallint CHECK (impact BETWEEN 1 AND 10),
    decision_note text,
    tracker_url text,
    risk_state text NOT NULL DEFAULT 'ACTIVE' CHECK (risk_state IN ('ACTIVE', 'REMOVED', 'MATERIALIZED')),
    closure_reason text,
    UNIQUE (risk_id, id)
);

CREATE UNIQUE INDEX risk_versions_one_open_idx ON risk_versions (risk_id)
    WHERE status IN ('DRAFT', 'IN_REVIEW', 'RETURNED');
CREATE INDEX risk_versions_author_idx ON risk_versions (author_id);
CREATE INDEX risk_versions_queue_idx ON risk_versions (risk_id) WHERE status = 'IN_REVIEW';

ALTER TABLE risks ADD CONSTRAINT risks_published_version_fk
    FOREIGN KEY (id, published_version_id) REFERENCES risk_versions (risk_id, id);

CREATE TABLE risk_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    risk_id uuid NOT NULL,
    version_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES accounts(id),
    action text NOT NULL CHECK (action IN ('SUBMIT', 'RETURN', 'APPROVE', 'WITHDRAW', 'UNBLOCK', 'CONFIRM_ASSESSMENT')),
    occurred_at timestamptz NOT NULL,
    comment text,
    FOREIGN KEY (risk_id, version_id) REFERENCES risk_versions (risk_id, id)
);

CREATE INDEX risk_events_version_idx ON risk_events (version_id, action);
CREATE INDEX risk_events_history_idx ON risk_events (risk_id, id);
