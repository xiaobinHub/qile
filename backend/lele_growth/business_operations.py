"""Authoritative child business commands. No client-supplied ledger or snapshots."""
from __future__ import annotations

import calendar
import base64
import binascii
import copy
import re
import unicodedata
import uuid
from datetime import date, datetime, timedelta
from http import HTTPStatus
from zoneinfo import ZoneInfo

from lele_growth.postgres_store import validate_data
from lele_growth.storage import StoreError


def fail(message, status=HTTPStatus.BAD_REQUEST):
    raise StoreError(status, message)


def uid():
    return uuid.uuid4().hex


def default_data(name):
    return {"schemaVersion": 2, "settings": {"childName": name, "weekStartsOn": 1},
            "categories": [{"id": uid(), "name": n, "color": c, "active": True} for n, c in
                           [("作业", "#e56b6f"), ("学习", "#5b8def"), ("阅读", "#8e7dbe"),
                            ("锻炼", "#52a675"), ("家务", "#e6a23c"), ("其他", "#7a8b99")]],
            **{k: [] for k in ("series", "exceptions", "completions", "ledger", "gifts", "operationLog", "taskPresets")}}


def fields(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or any(k not in value for k in required):
        fail("操作字段不正确，请刷新页面后重试。")


def text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        fail("名称或内容为空或过长。")
    return value.strip()


def find(rows, identity, key="id"):
    row = next((r for r in rows if r.get(key) == identity), None)
    if row is None:
        fail("记录已不存在，请刷新后重试。", HTTPStatus.CONFLICT)
    return row


TASK_FIELDS = ("title", "note", "startDate", "startTime", "endTime", "categoryId", "points", "recurrence")


def task_input(value):
    fields(value, TASK_FIELDS, ("title", "startDate", "startTime", "endTime", "categoryId", "points"))
    result = copy.deepcopy(value)
    result["title"] = text(result["title"], 200)
    if not isinstance(result.get("note", ""), str) or len(result.get("note", "")) > 5000:
        fail("备注格式不正确。")
    result.setdefault("note", "")
    result.setdefault("recurrence", None)
    if result["recurrence"] is not None:
        fields(result["recurrence"], ("freq", "interval", "weekdays", "monthDay", "endType", "until", "count"))
    # Validate before any recurrence expansion to bound loops and reject malformed dates.
    sample = default_data("校验")
    sample["categories"] = [{"id": result["categoryId"], "name": "校验", "color": "#123456", "active": True}]
    sample["series"] = [{"id": "validation", **result}]
    validate_data(sample)
    return result


def revision(task, effective, identity=None):
    return {"id": identity or uid(), "effectiveFrom": effective,
            **{k: copy.deepcopy(task.get(k, "" if k == "note" else None)) for k in TASK_FIELDS if k != "startDate"}}


def revisions(series):
    raw = series.get("revisions")
    if raw:
        return sorted([{**revision(series, series["startDate"], series["id"] + ":v1"), **r} for r in raw],
                      key=lambda r: r["effectiveFrom"])
    return [revision(series, series["startDate"], series["id"] + ":v1")]


def make_occ(task, day, original=None):
    original = original or day
    return {"seriesId": task["id"], "occurrenceKey": f'{task["id"]}@{original}', "date": day,
            "originalDate": original, "title": task["title"], "note": task.get("note") or "",
            "startTime": task["startTime"], "endTime": task["endTime"],
            "categoryId": task["categoryId"], "points": task["points"], "recurring": bool(task.get("recurrence"))}


def expand(task, start, end):
    """Matches existing day/week/month rule semantics including month-end clamping."""
    rule = task.get("recurrence")
    if not rule:
        return [make_occ(task, task["startDate"])] if start <= task["startDate"] <= end else []
    first = date.fromisoformat(task["startDate"])
    limit = date.fromisoformat(min(end, rule["until"]) if rule["endType"] == "until" else end)
    count = rule["count"] if rule["endType"] == "count" else 5000
    step, generated, result = rule["interval"], 0, []
    def add(day):
        nonlocal generated
        if day < first or day > limit or generated >= count:
            return
        generated += 1
        if first <= day and start <= day.isoformat():
            result.append(make_occ(task, day.isoformat()))
    if rule["freq"] == "daily":
        day = first
        while day <= limit and generated < count:
            add(day)
            try:
                day += timedelta(days=step)
            except OverflowError:
                break
    elif rule["freq"] == "weekly":
        anchor = first - timedelta(days=first.weekday())
        while anchor <= limit and generated < count:
            for wd in sorted(rule["weekdays"]):
                try:
                    day = anchor + timedelta(days=wd)
                except OverflowError:
                    break
                if day >= first:
                    add(day)
            try:
                anchor += timedelta(weeks=step)
            except OverflowError:
                break
    else:
        month = first.year * 12 + first.month - 1
        while generated < count:
            year, mi = divmod(month, 12)
            if year > 9999:
                break
            day = date(year, mi + 1, min(rule.get("monthDay", first.day), calendar.monthrange(year, mi + 1)[1]))
            if day > limit:
                break
            add(day)
            month += step
    return result


def occurrence(data, key):
    if not isinstance(key, str) or "@" not in key:
        fail("任务发生标识不正确。")
    sid, original = key.rsplit("@", 1)
    try:
        date.fromisoformat(original)
    except ValueError:
        fail("任务日期不正确。")
    completed = next((c for c in data["completions"] if c["occurrenceKey"] == key and c["completed"]), None)
    if completed:
        return {**completed["snapshot"], "occurrenceKey": key}
    series = find(data["series"], sid)
    ex = next((e for e in data["exceptions"] if e["seriesId"] == sid and e["originalDate"] == original), None)
    if ex:
        if ex["action"] == "cancel":
            fail("该次任务已取消。", HTTPStatus.CONFLICT)
        return {**ex["data"], "seriesId": sid, "originalDate": original, "occurrenceKey": key, "recurring": True}
    if not series.get("recurrence"):
        candidates = expand(series, original, original)
    else:
        candidates = []
        revs = revisions(series)
        for i, rev in enumerate(revs):
            if rev["effectiveFrom"] <= original and (i + 1 == len(revs) or original < revs[i + 1]["effectiveFrom"]):
                candidates.extend(expand({**series, **rev, "id": series["id"], "startDate": rev["effectiveFrom"]}, original, original))
    if not candidates:
        fail("该日期没有此任务，请刷新后重试。", HTTPStatus.CONFLICT)
    return candidates[0]


def sync_series(series):
    latest = series["revisions"][-1]
    for k in TASK_FIELDS:
        series[k] = copy.deepcopy(latest["effectiveFrom"] if k == "startDate" else latest.get(k))


def referenced(data, cid):
    return (any(x.get("categoryId") == cid or any(r.get("categoryId") == cid for r in x.get("revisions") or []) for x in data["series"])
            or any(x.get("categoryId") == cid for x in data.get("taskPresets", []))
            or any((x.get("data") or {}).get("categoryId") == cid for x in data["exceptions"])
            or any(x["snapshot"].get("categoryId") == cid for x in data["completions"]))


def gift_image(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > 260000:
        fail("礼品图片格式或大小不正确。")
    match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})', value, re.IGNORECASE)
    if not match:
        fail("礼品图片必须为有效的 PNG、JPEG 或 WebP 图片。")
    try:
        raw = base64.b64decode(match[2], validate=True)
    except (binascii.Error, ValueError):
        fail("礼品图片编码不正确。")
    signature = (raw.startswith(b'\x89PNG\r\n\x1a\n') if match[1].lower() == 'png' else
                 raw.startswith(b'\xff\xd8\xff') if match[1].lower() == 'jpeg' else
                 raw.startswith(b'RIFF') and raw[8:12] == b'WEBP')
    if not signature or len(raw) > 180 * 1024:
        fail("礼品图片格式或大小不正确，请重新选择图片。")
    return value


def _apply(data, kind, p, stamp, today):
    if kind == "task.create":
        fields(p, ("task",), ("task",))
        task = task_input(p["task"])
        data["series"].append({"id": uid(), **task, "revisions": [revision(task, task["startDate"])], "createdAt": stamp, "updatedAt": stamp})
    elif kind in ("task.edit", "task.delete"):
        fields(p, ("occurrenceKey", "task", "scope") if kind == "task.edit" else ("occurrenceKey", "scope"), ("occurrenceKey", "scope"))
        old = occurrence(data, p["occurrenceKey"])
        if any(c["occurrenceKey"] == p["occurrenceKey"] and c["completed"] for c in data["completions"]):
            fail("已完成任务已冻结，请先撤销完成。", HTTPStatus.CONFLICT)
        series = find(data["series"], old["seriesId"])
        if kind == "task.delete":
            if p["scope"] not in ("only", "series"):
                fail("请选择有效的删除范围。")
            if not old["recurring"] or p["scope"] == "series":
                data["series"].remove(series)
                data["exceptions"] = [e for e in data["exceptions"] if e["seriesId"] != series["id"]]
            else:
                data["exceptions"] = [e for e in data["exceptions"] if not (e["seriesId"] == series["id"] and e["originalDate"] == old["originalDate"])]
                data["exceptions"].append({"id": uid(), "seriesId": series["id"], "originalDate": old["originalDate"], "action": "cancel"})
            return
        if p["scope"] not in ("only", "future", "all"):
            fail("请选择有效的修改范围。")
        task = task_input(p.get("task"))
        if not old["recurring"]:
            series.update(task, updatedAt=stamp)
            if series.get("revisions"):
                series["revisions"] = [revision(task, task["startDate"], series["revisions"][0]["id"])]
        elif p["scope"] == "only":
            data["exceptions"] = [e for e in data["exceptions"] if not (e["seriesId"] == series["id"] and e["originalDate"] == old["originalDate"])]
            snapshot = make_occ({"id": series["id"], **task}, task["startDate"], old["originalDate"])
            snapshot["recurring"] = True
            data["exceptions"].append({"id": uid(), "seriesId": series["id"], "originalDate": old["originalDate"], "action": "override", "data": snapshot})
        elif p["scope"] == "all":
            changed = task["startDate"] != old["date"]
            if not changed:
                task["startDate"] = series["startDate"]
            if task.get("recurrence") and task["recurrence"]["freq"] == "monthly":
                task["recurrence"]["monthDay"] = date.fromisoformat(task["startDate"]).day if changed else (series.get("recurrence") or {}).get("monthDay", date.fromisoformat(series["startDate"]).day)
            series["revisions"] = [revision(task, task["startDate"])]
            data["exceptions"] = [e for e in data["exceptions"] if e["seriesId"] != series["id"]]
            sync_series(series)
            series["updatedAt"] = stamp
        else:
            revs, pivot = revisions(series), old["originalDate"]
            source = next((r for r in reversed(revs) if r["effectiveFrom"] <= pivot), revs[0])
            if (task.get("recurrence") or {}).get("endType") == "count" and (source.get("recurrence") or {}).get("endType") == "count":
                before = (date.fromisoformat(pivot) - timedelta(days=1)).isoformat()
                used = len(expand({**series, **source, "startDate": source["effectiveFrom"]}, source["effectiveFrom"], before))
                task["recurrence"]["count"] = max(1, source["recurrence"]["count"] - used)
            new = revision(task, task["startDate"])
            next_revs = [new] if pivot <= revs[0]["effectiveFrom"] or task["startDate"] <= revs[0]["effectiveFrom"] else [r for r in revs if r["effectiveFrom"] < pivot] + [new]
            unique = []
            for r in sorted(next_revs, key=lambda x: x["effectiveFrom"]):
                compare = lambda x: {k: v for k, v in x.items() if k not in ("id", "effectiveFrom")}
                if not unique or compare(unique[-1]) != compare(r):
                    unique.append(r)
            series["revisions"] = unique
            sync_series(series)
            series["updatedAt"] = stamp
    elif kind == "completion.set":
        fields(p, ("occurrenceKey", "completed"), ("occurrenceKey", "completed"))
        if type(p["completed"]) is not bool:
            fail("完成状态不正确。")
        c = next((c for c in data["completions"] if c["occurrenceKey"] == p["occurrenceKey"]), None)
        if bool(c and c["completed"]) == p["completed"]:
            return
        if p["completed"]:
            snap = occurrence(data, p["occurrenceKey"])
            if c is None:
                c = {"occurrenceKey": p["occurrenceKey"]}
                data["completions"].append(c)
            c.update(completed=True, snapshot=snap, updatedAt=stamp)
        else:
            c.update(completed=False, updatedAt=stamp)
        snap = c["snapshot"]
        data["ledger"].append({"id": uid(), "kind": "task-complete" if p["completed"] else "task-reversal",
                               "amount": snap["points"] * (1 if p["completed"] else -1), "date": today,
                               "createdAt": stamp, "occurrenceKey": p["occurrenceKey"], "source": snap["title"],
                               "reason": "完成任务" if p["completed"] else "撤销任务完成"})
    elif kind == "ledger.manual":
        fields(p, ("amount", "reason", "date"), ("amount", "reason", "date"))
        if type(p["amount"]) is not int or p["amount"] == 0:
            fail("请输入非零整数积分。")
        data["ledger"].append({"id": uid(), "kind": "manual", **p, "reason": text(p["reason"], 1000), "createdAt": stamp, "source": "手动调整"})
    elif kind == "gift.save":
        fields(p, ("gift",), ("gift",))
        g = p["gift"]
        fields(g, ("id", "name", "points", "imageData", "imageAssetId"), ("name", "points"))
        existing = find(data["gifts"], g["id"]) if g.get("id") else None
        if existing and existing["status"] != "available":
            fail("已兑换礼品不能编辑，请先撤销兑换。", HTTPStatus.CONFLICT)
        attrs = {"name": text(g["name"], 40), "points": g["points"], "imageData": gift_image(g.get("imageData")), "updatedAt": stamp}
        if g.get("imageAssetId") is not None:
            from lele_growth.media_types import ASSET_ID
            if not isinstance(g["imageAssetId"], str) or not ASSET_ID.fullmatch(g["imageAssetId"]):
                fail("图片引用格式不正确。")
            if g.get("imageData"):
                fail("请只提交一种图片引用。")
            attrs.pop("imageData", None)
            attrs["imageAssetId"] = g["imageAssetId"]
        elif not attrs.get("imageData"):
            attrs.pop("imageData", None)
        if existing:
            for key in ("imageData", "imageAssetId", "imageUrl"):
                existing.pop(key, None)
            existing.update(attrs)
        else:
            data["gifts"].append({"id": uid(), **attrs, "createdAt": stamp, "status": "available", "redeemedAt": None, "redemptionLedgerId": None})
    elif kind in ("gift.delete", "gift.redeem", "gift.reverse"):
        fields(p, ("id",), ("id",))
        gift = find(data["gifts"], p["id"])
        if kind == "gift.delete":
            if gift["status"] != "available":
                fail("已兑换礼品不能删除，请先撤销兑换。", HTTPStatus.CONFLICT)
            data["gifts"].remove(gift)
        elif kind == "gift.redeem":
            if gift["status"] != "available":
                fail("该礼品已兑换，请刷新。", HTTPStatus.CONFLICT)
            if sum(x["amount"] for x in data["ledger"]) < gift["points"]:
                fail("当前积分不足。", HTTPStatus.CONFLICT)
            entry = {"id": uid(), "kind": "gift-redeem", "amount": -gift["points"], "date": today, "createdAt": stamp,
                     "giftId": gift["id"], "giftSnapshot": {"name": gift["name"], "points": gift["points"]},
                     "source": "兑换礼品：" + gift["name"], "reason": "积分商城兑换"}
            data["ledger"].append(entry)
            gift.update(status="redeemed", redeemedAt=stamp, redemptionLedgerId=entry["id"], updatedAt=stamp)
        else:
            if gift["status"] != "redeemed":
                fail("该礼品没有可撤销的兑换。", HTTPStatus.CONFLICT)
            original = find(data["ledger"], gift.get("redemptionLedgerId"))
            if original["kind"] != "gift-redeem" or any(x.get("relatedLedgerId") == original["id"] and x["kind"] == "gift-reversal" for x in data["ledger"]):
                fail("原兑换流水不正确或已经撤销。", HTTPStatus.CONFLICT)
            data["ledger"].append({"id": uid(), "kind": "gift-reversal", "amount": -original["amount"], "date": today,
                                   "createdAt": stamp, "giftId": gift["id"], "relatedLedgerId": original["id"],
                                   "giftSnapshot": copy.deepcopy(original["giftSnapshot"]), "source": "撤销兑换：" + original["giftSnapshot"]["name"], "reason": "撤销礼品兑换"})
            gift.update(status="available", redeemedAt=None, redemptionLedgerId=None, updatedAt=stamp)
    elif kind == "category.save":
        fields(p, ("category",), ("category",))
        category = p["category"]
        fields(category, ("id", "name", "color"), ("name", "color"))
        name = text(category["name"], 20)
        norm = lambda s: unicodedata.normalize("NFKC", s).casefold()
        if any(norm(c["name"]) == norm(name) and c["id"] != category.get("id") for c in data["categories"]):
            fail("任务类型名称不能重复。")
        if category.get("id"):
            find(data["categories"], category["id"]).update(name=name, color=category["color"])
        else:
            data["categories"].append({"id": uid(), "name": name, "color": category["color"], "active": True})
    elif kind == "category.delete":
        fields(p, ("id",), ("id",))
        category = find(data["categories"], p["id"])
        if referenced(data, p["id"]):
            category["active"] = False
        else:
            data["categories"].remove(category)
    elif kind == "category.reorder":
        fields(p, ("ids",), ("ids",))
        ids = p["ids"]
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids) or len(ids) != len(data["categories"]) or set(ids) != {c["id"] for c in data["categories"]}:
            fail("类型排序与当前数据不一致。")
        data["categories"] = [find(data["categories"], k) for k in ids]
    elif kind == "preset.save":
        fields(p, ("preset",), ("preset",))
        preset = p["preset"]
        fields(preset, ("id", "title", "categoryId", "startTime", "endTime", "points"), ("title", "startTime", "endTime", "points"))
        attrs = {**preset, "title": text(preset["title"], 80), "categoryId": preset.get("categoryId", "")}
        data.setdefault("taskPresets", [])
        if preset.get("id"):
            find(data["taskPresets"], preset["id"]).update(attrs)
        else:
            data["taskPresets"].append({**attrs, "id": uid()})
    elif kind == "preset.delete":
        fields(p, ("id",), ("id",))
        data.setdefault("taskPresets", []).remove(find(data.get("taskPresets", []), p["id"]))
    else:
        fail("不支持的业务操作。")


def apply_operation(data, kind, payload, *, actor_id, revision, now):
    """Return a new validated object; never mutate input on success or failure."""
    if not isinstance(kind, str) or not isinstance(payload, dict):
        fail("业务操作格式不正确。")
    moment = datetime.fromisoformat(now.replace("Z", "+00:00")) if isinstance(now, str) else now
    if not isinstance(moment, datetime) or moment.tzinfo is None:
        raise ValueError("timezone-aware operation clock required")
    stamp = moment.isoformat(timespec="milliseconds")
    result = copy.deepcopy(data)
    try:
        _apply(result, kind, payload, stamp, moment.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat())
        if result == data:
            return result
        event = {"id": uid(), "at": stamp, "action": kind, "revision": revision, "actorUserId": str(actor_id)}
        if "occurrenceKey" in payload:
            event.update(occurrenceKey=payload["occurrenceKey"], seriesId=payload["occurrenceKey"].rsplit("@", 1)[0])
        if kind == "ledger.manual":
            event.update(amount=payload["amount"], reason=payload["reason"])
        if "scope" in payload:
            event["scope"] = payload["scope"]
        result["operationLog"] = (result.get("operationLog", []) + [event])[-500:]
        validate_data(result)
        return result
    except StoreError:
        raise
    except (KeyError, TypeError, ValueError, OverflowError):
        fail("操作内容不完整或格式不正确。")
