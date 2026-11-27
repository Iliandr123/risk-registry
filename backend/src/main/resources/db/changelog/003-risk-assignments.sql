--liquibase formatted sql

--changeset uptime:003-risk-assignments
ALTER TABLE risks
    ADD COLUMN assignee_id uuid REFERENCES accounts(id),
    ADD COLUMN assignment_revision bigint NOT NULL DEFAULT 1 CHECK (assignment_revision >= 1),
    ADD CONSTRAINT risks_assignment_requires_publication CHECK (assignee_id IS NULL OR published_version_id IS NOT NULL);

ALTER TABLE risk_events
    DROP CONSTRAINT risk_events_action_check,
    ALTER COLUMN actor_id DROP NOT NULL,
    ADD COLUMN previous_assignee_id uuid REFERENCES accounts(id),
    ADD COLUMN new_assignee_id uuid REFERENCES accounts(id),
    ADD CONSTRAINT risk_events_action_check CHECK (action IN (
        'SUBMIT', 'RETURN', 'APPROVE', 'WITHDRAW', 'UNBLOCK', 'CONFIRM_ASSESSMENT',
        'ASSIGNMENT_CHANGED', 'ASSIGNMENT_MIGRATED'
    )),
    ADD CONSTRAINT risk_events_actor_check CHECK ((actor_id IS NULL) = (action = 'ASSIGNMENT_MIGRATED')),
    ADD CONSTRAINT risk_events_assignment_check CHECK (
        CASE action
            WHEN 'ASSIGNMENT_MIGRATED' THEN previous_assignee_id IS NULL AND new_assignee_id IS NOT NULL
            WHEN 'ASSIGNMENT_CHANGED' THEN previous_assignee_id IS DISTINCT FROM new_assignee_id
            ELSE previous_assignee_id IS NULL AND new_assignee_id IS NULL
        END
    );

WITH migrated AS (
    UPDATE risks r
    SET assignee_id = v.owner_id
    FROM risk_versions v
    WHERE (v.risk_id, v.id) = (r.id, r.published_version_id) AND v.owner_id IS NOT NULL
    RETURNING r.id, r.published_version_id, r.assignee_id
)
INSERT INTO risk_events (risk_id, version_id, action, occurred_at, new_assignee_id)
SELECT id, published_version_id, 'ASSIGNMENT_MIGRATED', CURRENT_TIMESTAMP, assignee_id
FROM migrated;
