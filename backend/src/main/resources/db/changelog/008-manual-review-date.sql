--liquibase formatted sql

--changeset uptime:008-manual-review-date
ALTER TABLE risks ADD COLUMN manual_review_date date;

ALTER TABLE risk_events
    ADD COLUMN previous_manual_review_date date,
    ADD COLUMN new_manual_review_date date;
