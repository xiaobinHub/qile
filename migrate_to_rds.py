#!/usr/bin/env python3
"""Explicit PostgreSQL setup/migration/verification; never imports old backups."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path

import psycopg
from psycopg import sql

from postgres_store import PostgresStore, load_config
from storage import JsonStore, StoreError

ROOT = Path(__file__).resolve().parent
TABLES = (
    "app_metadata", "app_settings", "task_categories", "task_series",
    "task_revisions", "task_exceptions", "task_completions", "points_ledger",
    "gifts", "task_presets", "business_operations", "data_snapshots",
    "request_logs", "migration_runs",
)


def source_record(path: Path):
    raw = path.read_bytes()
    record = JsonStore._decode(raw)
    return record, hashlib.sha256(raw).hexdigest()


def table_counts(config):
    with psycopg.connect(**config) as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return {name: conn.execute(sql.SQL("SELECT count(*) FROM lele.{}").format(
            sql.Identifier(name))).fetchone()[0] for name in TABLES}


def run(args):
    config = load_config(args.config)
    if args.command in {"check", "create-database"}:
        name = config["dbname"]
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", name):
            raise ValueError("目标数据库名称不正确。")
        maintenance = {**config, "dbname": "postgres"}
        with psycopg.connect(**maintenance, autocommit=True) as conn:
            exists = conn.execute("SELECT 1 FROM pg_database WHERE datname=%s", (name,)).fetchone() is not None
            version = conn.execute("SHOW server_version").fetchone()[0]
            if args.command == "create-database" and not exists:
                conn.execute(sql.SQL("CREATE DATABASE {} ENCODING 'UTF8'").format(sql.Identifier(name)))
                exists = True
            return {"connected": True, "server_version": version, "database": name,
                    "database_exists": exists, "sslmode": config.get("sslmode")}
    store = PostgresStore(ROOT, config_path=args.config)
    if args.command == "init":
        store.initialize_schema()
        return {"initialized_schema": True, "tables": table_counts(config)}
    if args.command == "import":
        record, digest = source_record(args.source)
        result = store.import_record(record, digest)
        result["tables"] = table_counts(config)
        if args.report:
            write_new(args.report, json.dumps(result, ensure_ascii=False, indent=2).encode() + b"\n")
        return result
    if args.command == "verify":
        record, digest = source_record(args.source)
        actual = store.read()
        if actual != record:
            raise ValueError("数据库重组内容与选定源文件不一致；没有修改任何数据。")
        return {"equal": True, "source_sha256": digest, "revision": actual["revision"],
                "points": sum(int(row["amount"]) for row in actual["data"]["ledger"]),
                "tables": table_counts(config)}
    if args.command == "export":
        raw = store.raw()
        JsonStore._decode(raw)
        write_new(args.output, raw)
        return {"exported": str(args.output), "revision": json.loads(raw)["revision"],
                "sha256": hashlib.sha256(raw).hexdigest()}
    raise ValueError("不支持的操作。")


def write_new(path: Path, raw: bytes):
    """Do not overwrite existing exports or reports."""
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())


def main():
    parser = argparse.ArgumentParser(description="乐乐成长 RDS 初始化、迁移与只读核验工具")
    parser.add_argument("--config", type=Path, default=ROOT / "data/rds-config.json")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("check", "create-database", "init"):
        commands.add_parser(command)
    migration = commands.add_parser("import")
    migration.add_argument("--source", type=Path, required=True, help="暂停服务后留档的最新正式文件")
    migration.add_argument("--report", type=Path)
    verification = commands.add_parser("verify")
    verification.add_argument("--source", type=Path, required=True)
    export = commands.add_parser("export")
    export.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False, indent=2))
        return 0
    except StoreError as error:
        print(json.dumps({"error": error.message, "status": int(error.status)}, ensure_ascii=False))
    except psycopg.Error as error:
        print(json.dumps({"error": "数据库操作失败，请检查连接或目标库状态。", "sqlstate": error.sqlstate}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        # These messages concern file operations/validation, never libpq parameters.
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
