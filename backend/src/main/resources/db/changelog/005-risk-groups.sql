--liquibase formatted sql

--changeset uptime:005-risk-groups
CREATE TABLE risk_groups (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    normalized_name text NOT NULL UNIQUE
);

ALTER TABLE risks
    ADD COLUMN group_id uuid REFERENCES risk_groups(id),
    ADD COLUMN group_revision bigint NOT NULL DEFAULT 1 CHECK (group_revision >= 1),
    ADD CONSTRAINT risks_group_requires_publication CHECK (group_id IS NULL OR published_version_id IS NOT NULL);

ALTER TABLE risk_versions ADD COLUMN proposed_group_id uuid REFERENCES risk_groups(id);

ALTER TABLE risk_events
    DROP CONSTRAINT risk_events_action_check,
    ADD CONSTRAINT risk_events_action_check CHECK (action IN (
        'SUBMIT', 'RETURN', 'APPROVE', 'WITHDRAW', 'UNBLOCK', 'CONFIRM_ASSESSMENT',
        'ASSIGNMENT_CHANGED', 'ASSIGNMENT_MIGRATED', 'GROUP_CHANGED'
    )),
    ADD COLUMN first_publication_with_group_history boolean NOT NULL DEFAULT false,
    ADD COLUMN initial_group_name text,
    ADD COLUMN previous_group_name text,
    ADD COLUMN new_group_name text,
    ADD CONSTRAINT risk_events_initial_group_check CHECK (
        (NOT first_publication_with_group_history OR action = 'APPROVE')
        AND (initial_group_name IS NULL OR first_publication_with_group_history)
    ),
    ADD CONSTRAINT risk_events_group_change_check CHECK (
        CASE action
            WHEN 'GROUP_CHANGED' THEN previous_group_name IS DISTINCT FROM new_group_name
            ELSE previous_group_name IS NULL AND new_group_name IS NULL
        END
    );
