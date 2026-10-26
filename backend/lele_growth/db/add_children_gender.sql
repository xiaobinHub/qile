-- Add a business field to the existing children table; leave existing rows unspecified.
ALTER TABLE lele.children ADD COLUMN gender text
 CHECK (gender IN ('boy','girl'));
COMMENT ON COLUMN lele.children.gender IS
 'Child gender explicitly selected at creation or saved with an avatar. Historical NULL is unspecified.';
