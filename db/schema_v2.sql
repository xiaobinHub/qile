-- 乐乐成长 PostgreSQL storage, database schema version 2 (PostgreSQL 14+).
-- record_json is authoritative. Generated columns are query projections; all
-- unknown keys, explicit nulls, omitted keys, and raw timestamps stay in JSON.
-- Run against an isolated database first. This file never imports application data.
CREATE SCHEMA IF NOT EXISTS lele;


CREATE TABLE lele.users (
 id text PRIMARY KEY, login_name text NOT NULL UNIQUE, nickname text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','parent')),
 status text NOT NULL CHECK(status IN ('pending','active','disabled')),
 must_change_password boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lele.children (
 id text PRIMARY KEY, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 40),
 owner_id text NOT NULL REFERENCES lele.users(id), archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lele.memberships (
 child_id text NOT NULL REFERENCES lele.children(id), user_id text NOT NULL REFERENCES lele.users(id),
 membership_version text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,user_id)
);
ALTER TABLE lele.children ADD CONSTRAINT child_owner_member FOREIGN KEY(id,owner_id)
 REFERENCES lele.memberships(child_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE lele.invitations (
 id text PRIMARY KEY, child_id text NOT NULL REFERENCES lele.children(id),
 target_id text NOT NULL REFERENCES lele.users(id), created_by text NOT NULL REFERENCES lele.users(id),
 status text NOT NULL CHECK(status IN ('pending','accepted','rejected','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE UNIQUE INDEX invitation_pending_unique ON lele.invitations(child_id,target_id) WHERE status='pending';
CREATE TABLE lele.sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES lele.users(id),
 surface text NOT NULL CHECK(surface IN ('parent','admin')), csrf_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
CREATE INDEX sessions_user ON lele.sessions(user_id);
CREATE TABLE lele.login_limits (
 bucket text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lele.audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id text REFERENCES lele.users(id),
 child_id text REFERENCES lele.children(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lele.idempotency_records (
 child_id text NOT NULL REFERENCES lele.children(id), operation_id text NOT NULL,
 actor_id text NOT NULL REFERENCES lele.users(id), membership_version text NOT NULL,
 payload_sha256 text NOT NULL, result_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(child_id,operation_id)
);
CREATE TABLE lele.schema_versions (version integer PRIMARY KEY CHECK(version=2));
INSERT INTO lele.schema_versions(version) VALUES(2);

-- Mirrors the frontend recurrence bounds without changing the stored JSON.
CREATE OR REPLACE FUNCTION lele.valid_recurrence(rule jsonb, starts_on date)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value numeric; item jsonb; until_date date;
BEGIN
    IF rule IS NULL OR rule = 'null'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(rule) <> 'object' OR
       COALESCE(rule->>'freq', '') NOT IN ('daily', 'weekly', 'monthly') OR
       COALESCE(rule->>'endType', '') NOT IN ('never', 'until', 'count') THEN RETURN false; END IF;
    value := (rule->>'interval')::numeric;
    IF value IS NULL OR value <> trunc(value) OR value NOT BETWEEN 1 AND 99 THEN RETURN false; END IF;
    IF rule->>'freq' = 'weekly' THEN
        IF jsonb_typeof(rule->'weekdays') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(rule->'weekdays') = 0 THEN RETURN false; END IF;
        FOR item IN SELECT jsonb_array_elements(rule->'weekdays') LOOP
            value := (item #>> '{}')::numeric;
            IF value IS NULL OR value <> trunc(value) OR value NOT BETWEEN 0 AND 6 THEN RETURN false; END IF;
        END LOOP;
    END IF;
    IF rule->>'freq' = 'monthly' THEN
        value := (rule->>'monthDay')::numeric;
        IF value IS NULL OR value <> trunc(value) OR value NOT BETWEEN 1 AND 31 THEN RETURN false; END IF;
    END IF;
    IF rule->>'endType' = 'until' THEN
        IF COALESCE(rule->>'until', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
        until_date := (rule->>'until')::date;
        IF starts_on IS NULL OR until_date < starts_on THEN RETURN false; END IF;
    END IF;
    IF rule->>'endType' = 'count' THEN
        value := (rule->>'count')::numeric;
        IF value IS NULL OR value <> trunc(value) OR value NOT BETWEEN 1 AND 10000 THEN RETURN false; END IF;
    END IF;
    RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
    RETURN false;
END;
$$;

CREATE TABLE lele.app_metadata (
    child_id text NOT NULL REFERENCES lele.children(id),
    id smallint CHECK (id = 1),
    store_format text NOT NULL,
    store_version integer NOT NULL,
    app_schema_version integer NOT NULL,
    db_schema_version integer NOT NULL DEFAULT 2 CHECK (db_schema_version = 2),
    revision bigint NOT NULL CHECK (revision >= 0),
    updated_at timestamptz,
    updated_at_raw text,
    data_keys text[] NOT NULL,
    data_extra jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data_extra) = 'object'),
    store_extra jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(store_extra) = 'object'),
    CHECK (updated_at IS NOT DISTINCT FROM updated_at_raw::timestamptz),
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.app_settings (
    child_id text NOT NULL REFERENCES lele.children(id),
    id smallint CHECK (id = 1),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    child_name text GENERATED ALWAYS AS (record_json->>'childName') STORED,
    week_starts_on smallint GENERATED ALWAYS AS ((record_json->>'weekStartsOn')::smallint) STORED,
    legacy_split_repair_v1 boolean GENERATED ALWAYS AS ((record_json->>'legacySplitRepairV1')::boolean) STORED,
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.task_categories (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    name text GENERATED ALWAYS AS (record_json->>'name') STORED NOT NULL,
    color text GENERATED ALWAYS AS (record_json->>'color') STORED NOT NULL,
    active boolean GENERATED ALWAYS AS ((record_json->>'active')::boolean) STORED NOT NULL,
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (jsonb_typeof(record_json->'name') = 'string' AND length(btrim(name)) > 0),
    CHECK (jsonb_typeof(record_json->'color') = 'string' AND color ~ '^#[0-9a-fA-F]{6}$'),
    CHECK (jsonb_typeof(record_json->'active') = 'boolean'),
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.task_series (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    title text GENERATED ALWAYS AS (record_json->>'title') STORED NOT NULL,
    note text GENERATED ALWAYS AS (record_json->>'note') STORED,
    category_id text GENERATED ALWAYS AS (record_json->>'categoryId') STORED NOT NULL,
    points bigint GENERATED ALWAYS AS ((record_json->>'points')::numeric::bigint) STORED NOT NULL,
    recurrence jsonb GENERATED ALWAYS AS (NULLIF(record_json->'recurrence', 'null'::jsonb)) STORED,
    repeat_freq text GENERATED ALWAYS AS (record_json #>> '{recurrence,freq}') STORED,
    repeat_interval integer GENERATED ALWAYS AS ((record_json #>> '{recurrence,interval}')::numeric::integer) STORED,
    repeat_end_type text GENERATED ALWAYS AS (record_json #>> '{recurrence,endType}') STORED,
    start_date date NOT NULL,
    CHECK (start_date IS NOT DISTINCT FROM (record_json->>'startDate')::date),
    CHECK (record_json->>'startDate' IS NULL OR record_json->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    start_time time NOT NULL,
    CHECK (start_time IS NOT DISTINCT FROM (record_json->>'startTime')::time),
    CHECK (record_json->>'startTime' IS NULL OR record_json->>'startTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time time NOT NULL,
    CHECK (end_time IS NOT DISTINCT FROM (record_json->>'endTime')::time),
    CHECK (record_json->>'endTime' IS NULL OR record_json->>'endTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    created_at timestamptz,
    CHECK (created_at IS NOT DISTINCT FROM (record_json->>'createdAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'createdAt') IS NULL OR jsonb_typeof(record_json->'createdAt') IN ('string', 'null')),
    updated_at timestamptz,
    CHECK (updated_at IS NOT DISTINCT FROM (record_json->>'updatedAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'updatedAt') IS NULL OR jsonb_typeof(record_json->'updatedAt') IN ('string', 'null')),
    revisions_state text NOT NULL CHECK (revisions_state IN ('absent', 'null', 'array')),
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (jsonb_typeof(record_json->'title') = 'string' AND length(btrim(title)) > 0),
    CHECK (points::numeric = (record_json->>'points')::numeric AND points >= 0),
    CHECK ((jsonb_typeof(record_json->'categoryId') = 'string' AND category_id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (end_time > start_time),
    CHECK (NOT record_json ? 'revisions'),
    CHECK (lele.valid_recurrence(recurrence, start_date)),
    FOREIGN KEY (child_id, category_id) REFERENCES lele.task_categories(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.task_revisions (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    effective_json jsonb NOT NULL CHECK (jsonb_typeof(effective_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    series_id text NOT NULL,
    id text GENERATED ALWAYS AS (record_json->>'id') STORED NOT NULL,
    title text GENERATED ALWAYS AS (effective_json->>'title') STORED NOT NULL,
    note text GENERATED ALWAYS AS (effective_json->>'note') STORED,
    category_id text GENERATED ALWAYS AS (effective_json->>'categoryId') STORED NOT NULL,
    points bigint GENERATED ALWAYS AS ((effective_json->>'points')::numeric::bigint) STORED NOT NULL,
    recurrence jsonb GENERATED ALWAYS AS (NULLIF(effective_json->'recurrence', 'null'::jsonb)) STORED,
    repeat_freq text GENERATED ALWAYS AS (effective_json #>> '{recurrence,freq}') STORED,
    repeat_interval integer GENERATED ALWAYS AS ((effective_json #>> '{recurrence,interval}')::numeric::integer) STORED,
    repeat_end_type text GENERATED ALWAYS AS (effective_json #>> '{recurrence,endType}') STORED,
    effective_from date NOT NULL,
    CHECK (effective_from IS NOT DISTINCT FROM (record_json->>'effectiveFrom')::date),
    CHECK (record_json->>'effectiveFrom' IS NULL OR record_json->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    start_time time NOT NULL,
    CHECK (start_time IS NOT DISTINCT FROM (effective_json->>'startTime')::time),
    CHECK (effective_json->>'startTime' IS NULL OR effective_json->>'startTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time time NOT NULL,
    CHECK (end_time IS NOT DISTINCT FROM (effective_json->>'endTime')::time),
    CHECK (effective_json->>'endTime' IS NULL OR effective_json->>'endTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    PRIMARY KEY (child_id, series_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (jsonb_typeof(effective_json->'title') = 'string' AND length(btrim(title)) > 0),
    CHECK (points::numeric = (effective_json->>'points')::numeric AND points >= 0),
    CHECK ((jsonb_typeof(effective_json->'categoryId') = 'string' AND category_id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (end_time > start_time),
    CHECK (lele.valid_recurrence(recurrence, effective_from)),
    FOREIGN KEY (child_id, series_id) REFERENCES lele.task_series(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (child_id, category_id) REFERENCES lele.task_categories(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE lele.task_exceptions (
    child_id text NOT NULL REFERENCES lele.children(id),
    row_id bigint GENERATED ALWAYS AS IDENTITY,
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    series_id text GENERATED ALWAYS AS (record_json->>'seriesId') STORED NOT NULL,
    action text GENERATED ALWAYS AS (record_json->>'action') STORED NOT NULL,
    override_data jsonb GENERATED ALWAYS AS (NULLIF(record_json->'data', 'null'::jsonb)) STORED,
    original_date date NOT NULL,
    CHECK (original_date IS NOT DISTINCT FROM (record_json->>'originalDate')::date),
    CHECK (record_json->>'originalDate' IS NULL OR record_json->>'originalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    override_date date,
    CHECK (override_date IS NOT DISTINCT FROM (record_json #>> '{data,date}')::date),
    CHECK (record_json #>> '{data,date}' IS NULL OR record_json #>> '{data,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    UNIQUE (child_id, sort_order),
    UNIQUE (child_id, id),
    CHECK (id IS NULL OR (jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (action IN ('cancel', 'override')),
    CHECK (action <> 'override' OR (override_data IS NOT NULL AND jsonb_typeof(override_data) = 'object' AND override_date IS NOT NULL)),
    FOREIGN KEY (child_id, series_id) REFERENCES lele.task_series(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (child_id, row_id)
);

-- Older snapshots may omit seriesId, originalDate, recurring, or updatedAt.
-- These query projections remain nullable; record_json preserves omission/null.
CREATE TABLE lele.task_completions (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    occurrence_key text GENERATED ALWAYS AS (record_json->>'occurrenceKey') STORED,
    completed boolean GENERATED ALWAYS AS ((record_json->>'completed')::boolean) STORED NOT NULL,
    snapshot jsonb GENERATED ALWAYS AS (record_json->'snapshot') STORED NOT NULL,
    series_id text GENERATED ALWAYS AS (record_json #>> '{snapshot,seriesId}') STORED,
    title text GENERATED ALWAYS AS (record_json #>> '{snapshot,title}') STORED NOT NULL,
    note text GENERATED ALWAYS AS (record_json #>> '{snapshot,note}') STORED,
    category_id text GENERATED ALWAYS AS (record_json #>> '{snapshot,categoryId}') STORED NOT NULL,
    points bigint GENERATED ALWAYS AS ((record_json #>> '{snapshot,points}')::numeric::bigint) STORED NOT NULL,
    recurring boolean GENERATED ALWAYS AS ((record_json #>> '{snapshot,recurring}')::boolean) STORED,
    original_date date,
    CHECK (original_date IS NOT DISTINCT FROM (record_json #>> '{snapshot,originalDate}')::date),
    CHECK (record_json #>> '{snapshot,originalDate}' IS NULL OR record_json #>> '{snapshot,originalDate}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    task_date date NOT NULL,
    CHECK (task_date IS NOT DISTINCT FROM (record_json #>> '{snapshot,date}')::date),
    CHECK (record_json #>> '{snapshot,date}' IS NULL OR record_json #>> '{snapshot,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    start_time time NOT NULL,
    CHECK (start_time IS NOT DISTINCT FROM (record_json #>> '{snapshot,startTime}')::time),
    CHECK (record_json #>> '{snapshot,startTime}' IS NULL OR record_json #>> '{snapshot,startTime}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time time NOT NULL,
    CHECK (end_time IS NOT DISTINCT FROM (record_json #>> '{snapshot,endTime}')::time),
    CHECK (record_json #>> '{snapshot,endTime}' IS NULL OR record_json #>> '{snapshot,endTime}' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    updated_at timestamptz,
    CHECK (updated_at IS NOT DISTINCT FROM (record_json->>'updatedAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'updatedAt') IS NULL OR jsonb_typeof(record_json->'updatedAt') IN ('string', 'null')),
    UNIQUE (child_id, sort_order),
    CHECK (jsonb_typeof(record_json->'occurrenceKey') = 'string'),
    CHECK (jsonb_typeof(record_json->'completed') = 'boolean'),
    CHECK (jsonb_typeof(snapshot) = 'object'),
    CHECK (points::numeric = (record_json #>> '{snapshot,points}')::numeric AND points >= 0),
    CHECK (end_time > start_time),
    PRIMARY KEY (child_id, occurrence_key)
);

CREATE TABLE lele.points_ledger (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    kind text GENERATED ALWAYS AS (record_json->>'kind') STORED NOT NULL,
    amount bigint GENERATED ALWAYS AS ((record_json->>'amount')::numeric::bigint) STORED NOT NULL,
    occurrence_key text GENERATED ALWAYS AS (record_json->>'occurrenceKey') STORED,
    gift_id text GENERATED ALWAYS AS (record_json->>'giftId') STORED,
    related_ledger_id text GENERATED ALWAYS AS (record_json->>'relatedLedgerId') STORED,
    gift_snapshot jsonb GENERATED ALWAYS AS (NULLIF(record_json->'giftSnapshot', 'null'::jsonb)) STORED,
    source text GENERATED ALWAYS AS (record_json->>'source') STORED,
    reason text GENERATED ALWAYS AS (record_json->>'reason') STORED,
    business_date date NOT NULL,
    CHECK (business_date IS NOT DISTINCT FROM (record_json->>'date')::date),
    CHECK (record_json->>'date' IS NULL OR record_json->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    created_at timestamptz NOT NULL,
    CHECK (created_at IS NOT DISTINCT FROM (record_json->>'createdAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'createdAt') IS NULL OR jsonb_typeof(record_json->'createdAt') IN ('string', 'null')),
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (amount::numeric = (record_json->>'amount')::numeric),
    CHECK ((kind = 'task-complete' AND amount >= 0) OR (kind = 'task-reversal' AND amount <= 0) OR (kind = 'manual' AND amount <> 0) OR (kind = 'gift-redeem' AND amount < 0) OR (kind = 'gift-reversal' AND amount > 0)),
    FOREIGN KEY (child_id, related_ledger_id) REFERENCES lele.points_ledger(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.gifts (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    name text GENERATED ALWAYS AS (record_json->>'name') STORED NOT NULL,
    points integer GENERATED ALWAYS AS ((record_json->>'points')::numeric::integer) STORED NOT NULL,
    image_data text GENERATED ALWAYS AS (record_json->>'imageData') STORED,
    status text GENERATED ALWAYS AS (record_json->>'status') STORED NOT NULL,
    redemption_ledger_id text GENERATED ALWAYS AS (record_json->>'redemptionLedgerId') STORED,
    created_at timestamptz NOT NULL,
    CHECK (created_at IS NOT DISTINCT FROM (record_json->>'createdAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'createdAt') IS NULL OR jsonb_typeof(record_json->'createdAt') IN ('string', 'null')),
    updated_at timestamptz NOT NULL,
    CHECK (updated_at IS NOT DISTINCT FROM (record_json->>'updatedAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'updatedAt') IS NULL OR jsonb_typeof(record_json->'updatedAt') IN ('string', 'null')),
    redeemed_at timestamptz,
    CHECK (redeemed_at IS NOT DISTINCT FROM (record_json->>'redeemedAt')::timestamptz),
    CHECK (jsonb_typeof(record_json->'redeemedAt') IS NULL OR jsonb_typeof(record_json->'redeemedAt') IN ('string', 'null')),
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (jsonb_typeof(record_json->'name') = 'string' AND length(btrim(name)) BETWEEN 1 AND 40),
    CHECK (points::numeric = (record_json->>'points')::numeric AND points >= 1 AND points <= 99999),
    CHECK (status IN ('available', 'redeemed')),
    CHECK (image_data IS NULL OR image_data = '' OR (length(image_data) <= 260000 AND image_data ~* '^data:image/(webp|jpeg|png);base64,')),
    CHECK (status <> 'redeemed' OR (redeemed_at IS NOT NULL AND redemption_ledger_id IS NOT NULL)),
    FOREIGN KEY (child_id, redemption_ledger_id) REFERENCES lele.points_ledger(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.task_presets (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    title text GENERATED ALWAYS AS (record_json->>'title') STORED NOT NULL,
    category_id text GENERATED ALWAYS AS (NULLIF(record_json->>'categoryId', '')) STORED,
    points integer GENERATED ALWAYS AS ((record_json->>'points')::numeric::integer) STORED NOT NULL,
    start_time time NOT NULL,
    CHECK (start_time IS NOT DISTINCT FROM (record_json->>'startTime')::time),
    CHECK (record_json->>'startTime' IS NULL OR record_json->>'startTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time time NOT NULL,
    CHECK (end_time IS NOT DISTINCT FROM (record_json->>'endTime')::time),
    CHECK (record_json->>'endTime' IS NULL OR record_json->>'endTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    CHECK (jsonb_typeof(record_json->'title') = 'string' AND length(btrim(title)) > 0 AND length(title) <= 80),
    CHECK (jsonb_typeof(record_json->'points') = 'number'),
    CHECK (points::numeric = (record_json->>'points')::numeric AND points >= 0 AND points <= 9999),
    CHECK (end_time > start_time),
    FOREIGN KEY (child_id, category_id) REFERENCES lele.task_categories(child_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.business_operations (
    child_id text NOT NULL REFERENCES lele.children(id),
    record_json jsonb NOT NULL CHECK (jsonb_typeof(record_json) = 'object'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    id text GENERATED ALWAYS AS (record_json->>'id') STORED,
    action text GENERATED ALWAYS AS (record_json->>'action') STORED NOT NULL,
    scope text GENERATED ALWAYS AS (record_json->>'scope') STORED,
    series_id text GENERATED ALWAYS AS (record_json->>'seriesId') STORED,
    occurrence_key text GENERATED ALWAYS AS (record_json->>'occurrenceKey') STORED,
    before_data jsonb GENERATED ALWAYS AS (record_json->'before') STORED,
    after_data jsonb GENERATED ALWAYS AS (record_json->'after') STORED,
    revision bigint GENERATED ALWAYS AS ((record_json->>'revision')::numeric::bigint) STORED NOT NULL,
    amount bigint GENERATED ALWAYS AS ((record_json->>'amount')::numeric::bigint) STORED,
    reason text GENERATED ALWAYS AS (record_json->>'reason') STORED,
    operated_at timestamptz NOT NULL,
    CHECK (operated_at IS NOT DISTINCT FROM (record_json->>'at')::timestamptz),
    CHECK (jsonb_typeof(record_json->'at') IS NULL OR jsonb_typeof(record_json->'at') IN ('string', 'null')),
    effective_from date,
    CHECK (effective_from IS NOT DISTINCT FROM (record_json->>'effectiveFrom')::date),
    CHECK (record_json->>'effectiveFrom' IS NULL OR record_json->>'effectiveFrom' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    UNIQUE (child_id, sort_order),
    CHECK ((jsonb_typeof(record_json->'id') = 'string' AND id ~ '^[A-Za-z0-9._:-]{1,100}$')),
    PRIMARY KEY (child_id, id)
);

CREATE TABLE lele.data_snapshots (
    child_id text NOT NULL REFERENCES lele.children(id),
    id bigint GENERATED ALWAYS AS IDENTITY,
    revision bigint NOT NULL CHECK (revision >= 0),
    captured_at timestamptz NOT NULL,
    snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (child_id, id),
    UNIQUE (child_id, revision)
);

CREATE TABLE lele.request_logs (
    child_id text NOT NULL REFERENCES lele.children(id),
    id bigint GENERATED ALWAYS AS IDENTITY,
    request_id text NOT NULL,
    requested_at timestamptz NOT NULL,
    client_address inet NOT NULL,
    expected_revision bigint,
    current_revision bigint,
    http_status smallint NOT NULL CHECK (http_status BETWEEN 100 AND 599),
    result text NOT NULL,
    error_message text,
    PRIMARY KEY (child_id, id),
    UNIQUE (child_id, request_id)
);

CREATE TABLE lele.migration_runs (
    child_id text NOT NULL REFERENCES lele.children(id),
    id bigint GENERATED ALWAYS AS IDENTITY,
    source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    source_revision bigint NOT NULL CHECK (source_revision >= 0),
    source_updated_at_raw text,
    target_revision bigint NOT NULL CHECK (target_revision >= 0),
    migrated_at timestamptz NOT NULL,
    entity_counts jsonb NOT NULL CHECK (jsonb_typeof(entity_counts) = 'object'),
    business_sha256 text NOT NULL CHECK (business_sha256 ~ '^[0-9a-f]{64}$'),
    db_schema_version integer NOT NULL CHECK (db_schema_version = 2),
    PRIMARY KEY (child_id, id),
    UNIQUE (child_id, source_sha256)
);

CREATE INDEX IF NOT EXISTS task_series_category_id_start_date_idx ON lele.task_series (child_id, category_id, start_date);
CREATE INDEX IF NOT EXISTS task_series_start_date_idx ON lele.task_series (child_id, start_date);
CREATE INDEX IF NOT EXISTS task_revisions_series_id_effective_from_idx ON lele.task_revisions (child_id, series_id, effective_from);
CREATE INDEX IF NOT EXISTS task_revisions_category_id_idx ON lele.task_revisions (child_id, category_id);
CREATE INDEX IF NOT EXISTS task_exceptions_series_id_original_date_idx ON lele.task_exceptions (child_id, series_id, original_date);
CREATE INDEX IF NOT EXISTS task_completions_task_date_completed_idx ON lele.task_completions (child_id, task_date, completed);
CREATE INDEX IF NOT EXISTS task_completions_series_id_original_date_idx ON lele.task_completions (child_id, series_id, original_date);
CREATE INDEX IF NOT EXISTS points_ledger_business_date_kind_idx ON lele.points_ledger (child_id, business_date, kind);
CREATE INDEX IF NOT EXISTS points_ledger_occurrence_key_idx ON lele.points_ledger (child_id, occurrence_key);
CREATE INDEX IF NOT EXISTS points_ledger_gift_id_idx ON lele.points_ledger (child_id, gift_id);
CREATE INDEX IF NOT EXISTS points_ledger_related_ledger_id_idx ON lele.points_ledger (child_id, related_ledger_id);
CREATE INDEX IF NOT EXISTS gifts_status_created_at_idx ON lele.gifts (child_id, status, created_at);
CREATE INDEX IF NOT EXISTS gifts_redemption_ledger_id_idx ON lele.gifts (child_id, redemption_ledger_id);
CREATE INDEX IF NOT EXISTS task_presets_category_id_idx ON lele.task_presets (child_id, category_id);
CREATE INDEX IF NOT EXISTS business_operations_operated_at_idx ON lele.business_operations (child_id, operated_at);
CREATE INDEX IF NOT EXISTS business_operations_series_id_operated_at_idx ON lele.business_operations (child_id, series_id, operated_at);
CREATE INDEX IF NOT EXISTS data_snapshots_captured_at_id_idx ON lele.data_snapshots (child_id, captured_at, id);
CREATE INDEX IF NOT EXISTS request_logs_requested_at_idx ON lele.request_logs (child_id, requested_at);
