--liquibase formatted sql

--changeset uptime:007-close-legacy-risk-edits
ALTER TABLE risk_events
    DROP CONSTRAINT risk_events_action_check,
    DROP CONSTRAINT risk_events_actor_check,
    ADD CONSTRAINT risk_events_action_check CHECK (action IN (
        'SUBMIT', 'RETURN', 'APPROVE', 'WITHDRAW', 'UNBLOCK', 'CONFIRM_ASSESSMENT',
        'ASSIGNMENT_CHANGED', 'ASSIGNMENT_MIGRATED', 'GROUP_CHANGED', 'FIELDS_UPDATED',
        'EDIT_CLOSED_BY_MIGRATION'
    )),
    ADD CONSTRAINT risk_events_actor_check CHECK (
        (actor_id IS NULL) = (action IN ('ASSIGNMENT_MIGRATED', 'EDIT_CLOSED_BY_MIGRATION'))
    );

WITH closed_edits AS (
    UPDATE risk_versions draft
    SET status = 'CLOSED', revision = draft.revision + 1
    FROM risks r
    JOIN risk_versions published ON (published.risk_id, published.id) = (r.id, r.published_version_id)
    WHERE draft.risk_id = r.id
      AND published.risk_state = 'ACTIVE'
      AND draft.risk_state = 'ACTIVE'
      AND draft.status IN ('DRAFT', 'IN_REVIEW', 'RETURNED')
    RETURNING draft.risk_id, draft.id
)
INSERT INTO risk_events (risk_id, version_id, actor_id, action, occurred_at, comment)
SELECT risk_id, id, NULL, 'EDIT_CLOSED_BY_MIGRATION', CURRENT_TIMESTAMP,
       'Обычная правка закрыта при переходе на прямое редактирование.'
FROM closed_edits;
