from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Column, Integer, MetaData, String, Table, Text, create_engine, select, update, event


def now():
    return datetime.now(timezone.utc).isoformat()


class RevisionConflict(Exception):
    pass


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(f"sqlite:///{(self.directory / 'planner.db').as_posix()}", connect_args={"check_same_thread": False, "timeout": 20})

        @event.listens_for(self.engine, "connect")
        def pragmas(connection, _):
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")

        meta = MetaData()
        self.records = Table("records", meta,
            Column("id", String, primary_key=True),
            Column("kind", String, nullable=False, index=True),
            Column("body", Text, nullable=False),
            Column("revision", Integer, nullable=False, default=1),
            Column("created_at", String, nullable=False),
            Column("updated_at", String, nullable=False))
        meta.create_all(self.engine)

    def unpack(self, row):
        if row is None:
            return None
        body = json.loads(row["body"])
        revision = body.get("revision") if row["kind"] in ("model", "baseline") and isinstance(body.get("revision"), str) else row["revision"]
        return {**body, "id": row["id"], "revision": revision, "record_revision": row["revision"], "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def get(self, key, kind=None):
        with self.engine.connect() as conn:
            q = select(self.records).where(self.records.c.id == key)
            if kind:
                q = q.where(self.records.c.kind == kind)
            return self.unpack(conn.execute(q).mappings().first())

    def list(self, kind):
        with self.engine.connect() as conn:
            return [self.unpack(row) for row in conn.execute(select(self.records).where(self.records.c.kind == kind).order_by(self.records.c.created_at.desc())).mappings()]

    def insert(self, kind, body, key=None):
        key = key or uuid4().hex
        timestamp = now()
        with self.engine.begin() as conn:
            conn.execute(self.records.insert().values(id=key, kind=kind, body=json.dumps(body, ensure_ascii=False, default=str), revision=1, created_at=timestamp, updated_at=timestamp))
        return self.get(key)

    def replace(self, key, body, expected_revision=None):
        with self.engine.begin() as conn:
            query = update(self.records).where(self.records.c.id == key)
            if expected_revision is not None:
                query = query.where(self.records.c.revision == expected_revision)
            result = conn.execute(query.values(body=json.dumps(body, ensure_ascii=False, default=str), revision=self.records.c.revision+1, updated_at=now()))
            if result.rowcount != 1:
                raise RevisionConflict(key)
        return self.get(key)

    def publish_seeds(self, kind, values):
        for value in values:
            if not self.get(value["id"]):
                self.insert(kind, {**value, "status": "PUBLISHED"}, value["id"])

    def recover(self):
        for job in self.list("job"):
            if job["status"] in ("RUNNING", "QUEUED"):
                self.replace(job["id"], {**job, "status": "INTERRUPTED", "error": "应用已重启，请重新提交任务"})
