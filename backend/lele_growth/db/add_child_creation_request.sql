-- Preserve existing receipts; only new child creations have a request ID.
ALTER TABLE lele.idempotency_records
 ADD COLUMN creation_request_id text
 CHECK (creation_request_id ~ '^[A-Za-z0-9._:-]{8,100}$');
CREATE UNIQUE INDEX child_creation_request_unique
 ON lele.idempotency_records(actor_id, creation_request_id)
 WHERE creation_request_id IS NOT NULL;
