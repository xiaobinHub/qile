"""Reconcile Mison lessons into locked calendar tasks.

Absence from a lesson list is not cancellation. The saved start date is applied
only after each lesson id has been updated. Disabling the sync deletes incomplete
tasks and never claws back points; moving the start date later does both.
"""
from __future__ import annotations

import copy
import hashlib
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

from lele_growth.business_operations import revision, uid

PROVIDER = "mison"
CATEGORY_ID = "mison-course"
CATEGORY_NAME = "美森课程"
CATEGORY_COLOR = "#2f6fed"
SHANGHAI = ZoneInfo("Asia/Shanghai")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
TIME_RE = re.compile(r"(?:[01]\d|2[0-3]):[0-5]\d\Z")
STATUS_RANK = {"upcoming": 1, "completed": 2, "cancelled": 3}


class CourseSyncConflict(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refusal(*, archived=False, list_complete=True, contract_error=None):
    """Return a pause reason. A paused sync must not create, delete, or award."""
    if archived:
        return "archived"
    if contract_error:
        return contract_error
    if not list_complete:
        return "incomplete"
    return None


def series_id(account_id, contract_id, cid):
    digest = hashlib.sha256(f"mison\0{account_id}\0{contract_id}\0{cid}".encode()).hexdigest()[:32]
    return "mison." + digest


def source_for(account_id, contract_id, cid):
    return {"provider": PROVIDER, "accountId": str(account_id), "contractId": str(contract_id), "cid": str(cid)}


def is_mison(value):
    source = value.get("source") if isinstance(value, dict) else None
    return isinstance(source, dict) and source.get("provider") == PROVIDER


def clock(now):
    moment = datetime.fromisoformat(now.replace("Z", "+00:00")) if isinstance(now, str) else now
    if not isinstance(moment, datetime) or moment.tzinfo is None:
        raise ValueError("timezone-aware operation clock required")
    return moment.isoformat(timespec="milliseconds"), moment.astimezone(SHANGHAI).date().isoformat()


def _day(value):
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise CourseSyncConflict("invalid-date", "同步起始日不正确。")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise CourseSyncConflict("invalid-date", "同步起始日不正确。") from None
    return value


def _points(value):
    if type(value) is not int or value < 0 or value > 100 or value % 5:
        raise CourseSyncConflict("invalid-points", "奖励积分必须是 0 到 100 之间、间隔为 5 的整数。")
    return value


def _title(teacher, courseware):
    teacher_name = teacher.strip() if isinstance(teacher, str) and teacher.strip() else "老师"
    course_name = courseware.strip() if isinstance(courseware, str) else ""
    title = f"{teacher_name} · {course_name}" if course_name else f"{teacher_name} · 课程"
    return title[:200]


def validate_settings(points, start_date):
    return _points(points), _day(start_date)


def normalize_courses(courses, account_id, contract_id):
    """Merge duplicate lesson ids. Cancelled wins, then attended, then booked."""
    if not isinstance(courses, list):
        raise CourseSyncConflict("invalid-courses", "课程名单不正确。")
    selected = {}
    skipped = 0
    for raw in courses:
        if not isinstance(raw, dict) or raw.get("status") not in STATUS_RANK:
            skipped += 1
            continue
        cid = raw.get("cid")
        lesson_date, start, end = raw.get("date"), raw.get("startTime"), raw.get("endTime")
        valid = (isinstance(cid, str) and bool(cid) and isinstance(lesson_date, str) and isinstance(start, str)
                 and isinstance(end, str) and DATE_RE.fullmatch(lesson_date) and TIME_RE.fullmatch(start)
                 and TIME_RE.fullmatch(end) and start < end)
        if valid:
            try:
                date.fromisoformat(lesson_date)
            except ValueError:
                valid = False
        if not valid:
            skipped += 1
            continue
        lesson = {"cid": cid, "status": raw["status"], "date": lesson_date, "startTime": start, "endTime": end,
                  "title": _title(raw.get("teacherName"), raw.get("coursewareTitle")),
                  "source": source_for(account_id, contract_id, cid)}
        current = selected.get(cid)
        if current is None or STATUS_RANK[lesson["status"]] > STATUS_RANK[current["status"]]:
            selected[cid] = lesson
        elif STATUS_RANK[lesson["status"]] == STATUS_RANK[current["status"]] and (
                lesson["date"], lesson["startTime"], lesson["endTime"], lesson["title"]) != (
                current["date"], current["startTime"], current["endTime"], current["title"]):
            raise CourseSyncConflict("conflict", "同一课时返回了互相冲突的时间，本次没有同步。")
    return list(selected.values()), skipped


def _completion_for(data, identity, source):
    matches = []
    prefix = identity + "@"
    for completion in data["completions"]:
        snapshot = completion.get("snapshot") or {}
        key = completion.get("occurrenceKey")
        if snapshot.get("source") == source or (isinstance(key, str) and key.startswith(prefix)):
            matches.append(completion)
    if len(matches) > 1:
        raise CourseSyncConflict("conflict", "同一课时对应了多条日历记录，本次没有同步。")
    return matches[0] if matches else None


def _ensure_category(data):
    if any(category.get("id") == CATEGORY_ID for category in data["categories"]):
        return CATEGORY_ID
    data["categories"].append({"id": CATEGORY_ID, "name": CATEGORY_NAME, "color": CATEGORY_COLOR, "active": True})
    return CATEGORY_ID


def _task_fields(series, lesson, points, category_id):
    return {"title": lesson["title"], "note": "", "startDate": lesson["date"], "startTime": lesson["startTime"],
            "endTime": lesson["endTime"], "categoryId": category_id, "points": points, "recurrence": None,
            "source": copy.deepcopy(lesson["source"])}


def _write_series(series, task, stamp, *, created=False):
    series.update(task, updatedAt=stamp)
    if created:
        series["createdAt"] = stamp
    revision_id = series["revisions"][0]["id"] if series.get("revisions") else None
    series["revisions"] = [revision(task, task["startDate"], revision_id)]


def _snapshot(series, key):
    return {"seriesId": series["id"], "occurrenceKey": key, "date": series["startDate"],
            "originalDate": series["startDate"], "title": series["title"], "note": series.get("note") or "",
            "startTime": series["startTime"], "endTime": series["endTime"], "categoryId": series["categoryId"],
            "points": series["points"], "recurring": False, "source": copy.deepcopy(series["source"])}


def _retarget(data, completion, series, stamp):
    key = f'{series["id"]}@{series["startDate"]}'
    if any(item is not completion and item.get("occurrenceKey") == key for item in data["completions"]):
        raise CourseSyncConflict("conflict", "课程改期后与另一条日历记录冲突，本次没有同步。")
    awarded = completion.get("snapshot", {}).get("points", series["points"])
    completion["occurrenceKey"] = key
    completion["snapshot"] = _snapshot(series, key)
    if completion.get("completed"):
        completion["snapshot"]["points"] = awarded
    completion["updatedAt"] = stamp
    return key


def _ledger(data, *, kind, amount, today, stamp, key, task_date, title, reason):
    data["ledger"].append({"id": uid(), "kind": kind, "amount": amount, "date": today, "createdAt": stamp,
                            "occurrenceKey": key, "taskDate": task_date, "source": title, "reason": reason})


def _series_matches(series, task):
    return all(series.get(key) == task.get(key) for key in
               ("title", "note", "startDate", "startTime", "endTime", "categoryId", "points", "recurrence", "source"))


def _completion_matches(completion, series):
    if completion is None:
        return True
    snapshot = completion.get("snapshot") or {}
    key = f'{series["id"]}@{series["startDate"]}'
    points = snapshot.get("points") if completion.get("completed") else series["points"]
    return (completion.get("occurrenceKey") == key and snapshot.get("date") == series["startDate"]
            and snapshot.get("originalDate") == series["startDate"] and snapshot.get("title") == series["title"]
            and snapshot.get("note") == (series.get("note") or "") and snapshot.get("startTime") == series["startTime"]
            and snapshot.get("endTime") == series["endTime"] and snapshot.get("categoryId") == series["categoryId"]
            and snapshot.get("points") == points and snapshot.get("recurring") is False
            and snapshot.get("source") == series.get("source"))


def _award(data, series, stamp, today):
    completion = _completion_for(data, series["id"], series["source"])
    if completion and completion.get("completed"):
        if not _completion_matches(completion, series):
            _retarget(data, completion, series, stamp)
        return 0
    if completion is None:
        key = f'{series["id"]}@{series["startDate"]}'
        completion = {"occurrenceKey": key, "completed": False, "snapshot": _snapshot(series, key), "updatedAt": stamp}
        data["completions"].append(completion)
    if not _completion_matches(completion, series):
        _retarget(data, completion, series, stamp)
    completion["completed"] = True
    completion["updatedAt"] = stamp
    points = completion["snapshot"]["points"]
    _ledger(data, kind="task-complete", amount=points, today=today, stamp=stamp,
            key=completion["occurrenceKey"], task_date=completion["snapshot"]["date"],
            title=completion["snapshot"]["title"], reason="完成任务")
    return points


def _clawback(data, series, stamp, today):
    completion = _completion_for(data, series["id"], series.get("source"))
    amount = 0
    if completion and completion.get("completed"):
        amount = completion["snapshot"]["points"]
        completion["completed"] = False
        completion["updatedAt"] = stamp
        _ledger(data, kind="task-reversal", amount=-amount, today=today, stamp=stamp,
                key=completion["occurrenceKey"], task_date=completion["snapshot"]["date"],
                title=completion["snapshot"]["title"], reason="撤销任务完成")
    data["series"] = [item for item in data["series"] if item.get("id") != series["id"]]
    data["exceptions"] = [item for item in data["exceptions"] if item.get("seriesId") != series["id"]]
    return amount


def _empty_summary(skipped=0, **extra):
    summary = {"state": "synced", "added": 0, "addedAttended": 0, "newlyCompleted": 0, "points": 0,
               "removed": 0, "clawback": 0, "skipped": skipped}
    summary.update(extra)
    return summary


def reconcile(data, courses, *, account_id, contract_id, points, start_date, now):
    """Return a new child document and a change summary. ``data`` is not mutated."""
    points = _points(points)
    start_date = _day(start_date)
    stamp, today = clock(now)
    lessons, skipped = normalize_courses(courses, account_id, contract_id)
    result = copy.deepcopy(data)
    category_id = _ensure_category(result)
    by_cid = {}
    for series in result["series"]:
        source = series.get("source") if is_mison(series) else None
        if source and source.get("accountId") == str(account_id) and source.get("contractId") == str(contract_id):
            by_cid[str(source.get("cid"))] = series
    added = added_attended = newly_completed = awarded = removed = clawback = 0
    seen = set()
    kept = []
    for lesson in lessons:
        seen.add(lesson["cid"])
        identity = series_id(account_id, contract_id, lesson["cid"])
        series = by_cid.get(lesson["cid"])
        if series is not None and series["id"] != identity:
            raise CourseSyncConflict("conflict", "已同步课程的身份不一致，本次没有同步。")
        outside = lesson["status"] == "cancelled" or lesson["date"] < start_date
        if outside:
            if series is not None:
                removed += 1
                clawback += _clawback(result, series, stamp, today)
                by_cid.pop(lesson["cid"], None)
            else:
                orphan = _completion_for(result, identity, lesson["source"])
                if orphan and orphan.get("completed"):
                    removed += 1
                    clawback += orphan["snapshot"]["points"]
                    orphan["completed"] = False
                    orphan["updatedAt"] = stamp
                    _ledger(result, kind="task-reversal", amount=-orphan["snapshot"]["points"], today=today,
                            stamp=stamp, key=orphan["occurrenceKey"], task_date=orphan["snapshot"]["date"],
                            title=orphan["snapshot"]["title"], reason="撤销任务完成")
            continue
        kept.append(lesson)
        if series is None:
            occupied = next((item for item in result["series"] if item.get("id") == identity), None)
            if occupied is not None:
                raise CourseSyncConflict("conflict", "课程标识与已有任务冲突，本次没有同步。")
            series = {"id": identity, "revisions": []}
            result["series"].append(series)
            by_cid[lesson["cid"]] = series
            added += 1
            if lesson["status"] == "completed":
                added_attended += 1
            task_points = points
        else:
            completion = _completion_for(result, series["id"], series["source"])
            task_points = completion["snapshot"]["points"] if completion and completion.get("completed") else points
        task = _task_fields(series, lesson, task_points, category_id)
        if not _series_matches(series, task):
            _write_series(series, task, stamp, created=series.get("createdAt") is None)
        if any(item.get("seriesId") == series["id"] for item in result["exceptions"]):
            result["exceptions"] = [item for item in result["exceptions"] if item.get("seriesId") != series["id"]]
        completion = _completion_for(result, series["id"], series["source"])
        if completion is not None and not _completion_matches(completion, series):
            _retarget(result, completion, series, stamp)
        if lesson["status"] == "completed":
            gained = _award(result, series, stamp, today)
            if gained:
                newly_completed += 1
                awarded += gained
    for cid, series in list(by_cid.items()):
        if cid in seen or series.get("id") not in {item.get("id") for item in result["series"]}:
            continue
        if series.get("startDate") < start_date:
            removed += 1
            clawback += _clawback(result, series, stamp, today)
    summary = _empty_summary(skipped, added=added, addedAttended=added_attended, newlyCompleted=newly_completed,
                              points=awarded, removed=removed, clawback=clawback)
    return result, summary


def reconcile_current(data, courses, *, account_id, contract_id, points, start_date, now,
                      list_complete=True, archived=False, contract_error=None):
    reason = refusal(archived=archived, list_complete=list_complete, contract_error=contract_error)
    if reason:
        return copy.deepcopy(data), _empty_summary(state="paused", reason=reason)
    return reconcile(data, courses, account_id=account_id, contract_id=contract_id, points=points,
                     start_date=start_date, now=now)


def purge_incomplete(data, *, account_id=None):
    """Drop incomplete synced lessons. Completed lessons and awarded points stay."""
    result = copy.deepcopy(data)
    kept = []
    removed = 0
    for series in result["series"]:
        source = series.get("source") if is_mison(series) else None
        if source and (account_id is None or source.get("accountId") == str(account_id)):
            completion = _completion_for(result, series["id"], source)
            if not (completion and completion.get("completed")):
                removed += 1
                result["exceptions"] = [item for item in result["exceptions"] if item.get("seriesId") != series["id"]]
                continue
        kept.append(series)
    result["series"] = kept
    return result, removed
