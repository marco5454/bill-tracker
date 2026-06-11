-- 002_version_columns.sql
-- Add a monotonically-increasing version counter to every editable resource.
-- Used for optimistic-concurrency control via the HTTP If-Match header so
-- clients can never silently overwrite changes made in a stale tab.
--
-- Existing rows are stamped at 1 (the DEFAULT). Routes are responsible for
-- bumping the version on every successful UPDATE.
-- ---------------------------------------------------------------------------

ALTER TABLE bills   ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE credits ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
