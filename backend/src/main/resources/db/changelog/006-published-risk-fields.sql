--liquibase formatted sql

--changeset uptime:006-published-risk-fields
ALTER TABLE risk_events
    ADD COLUMN previous_version_id uuid,
    DROP CONSTRAINT risk_events_action_check,
    ADD CONSTRAINT risk_events_action_check CHECK (action IN (
        'SUBMIT', 'RETURN', 'APPROVE', 'WITHDRAW', 'UNBLOCK', 'CONFIRM_ASSESSMENT',
        'ASSIGNMENT_CHANGED', 'ASSIGNMENT_MIGRATED', 'GROUP_CHANGED', 'FIELDS_UPDATED'
    )),
    ADD CONSTRAINT risk_events_previous_version_fk
        FOREIGN KEY (risk_id, previous_version_id) REFERENCES risk_versions (risk_id, id),
    ADD CONSTRAINT risk_events_previous_version_check CHECK (
        (previous_version_id IS NOT NULL) = (action = 'FIELDS_UPDATED')
        AND previous_version_id IS DISTINCT FROM version_id
    );
