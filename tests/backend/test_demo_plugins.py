"""Demo package contracts using the real platform validators; no DB or services."""
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from lele_growth.child_service import ApiError
from lele_growth.plugins.configuration import schema_defaults, validate_config, validate_schema
from lele_growth.plugins.manifest import SUPPORTED_CAPABILITIES, validate_manifest
from lele_growth.plugins.scheduler import occurrence


ROOT = Path(__file__).resolve().parents[2]
PLUGIN_IDS = ("demo-page", "demo-service")
INFO_KEYS = {"ok", "pluginId", "childId", "version", "releaseId", "configRevision",
             "config", "serverTime", "features"}
PAGE_DEFAULTS = {
    "title": "页面能力 Demo", "pageSize": 5, "multiplier": 1.5,
    "autoRefresh": True, "tone": "默认", "categories": ["日常", "学习"],
    "targetDate": "2030-01-01", "checkpoint": "2030-01-01T12:00:00+08:00",
    "contactEmail": "demo@example.invalid", "referenceURL": "https://example.com",
    "recordBackground": True, "captureEvents": True,
}
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def package(plugin_id):
    directory = ROOT / "plugins" / plugin_id
    manifest = json.loads((directory / "plugin.json").read_text())
    schema = json.loads((directory / manifest["configSchema"]).read_text())
    spec = importlib.util.spec_from_file_location(
        "test_" + plugin_id.replace("-", "_"),
        directory / "backend" / (manifest["backend"]["entryModule"] + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return directory, manifest, schema, module


def context(plugin_id, config=None):
    _, _, schema, _ = package(plugin_id)
    return {"pluginId": plugin_id, "childId": "child-a", "version": "1.0.0",
            "releaseId": "release-demo-1", "configRevision": 7,
            "config": {**schema_defaults(schema), **(config or {})},
            "scopeToken": "private-signed-context", "nonce": "private-nonce",
            "actorId": "private-parent", "jobId": "private-job", "generation": 17,
            "releaseEpoch": 19, "policyRevision": 23, "expiresAt": 9999999999}


class DemoDeclarationTests(unittest.TestCase):
    def test_both_packages_validate_with_current_platform_and_local_icons(self):
        for plugin_id in PLUGIN_IDS:
            with self.subTest(plugin_id=plugin_id):
                directory, manifest, schema, module = package(plugin_id)
                self.assertEqual(validate_schema(schema), schema)
                self.assertEqual(validate_manifest(manifest, config_schema=schema), manifest)
                defaults = schema_defaults(schema)
                self.assertEqual(validate_config(schema, defaults), defaults)
                self.assertEqual(defaults, module.DEFAULT_CONFIG)
                self.assertEqual(manifest["version"], "1.0.0")
                self.assertEqual(manifest["id"], plugin_id)
                self.assertEqual(manifest["backend"]["entryModule"], plugin_id.replace("-", "_"))
                self.assertEqual(set(manifest["capabilities"]), SUPPORTED_CAPABILITIES)
                self.assertEqual(manifest["events"], ["task.completed"])
                self.assertIn("60", manifest["instructions"])
                self.assertIn("不发送外部消息", manifest["instructions"])
                self.assertTrue(manifest["description"])
                self.assertEqual(manifest["name"], "页面能力 Demo" if plugin_id == "demo-page" else "后台能力 Demo")
                heartbeat = next(t for t in manifest["tasks"] if t["id"] == "heartbeat")
                self.assertEqual(heartbeat["intervalSeconds"], 60)
                if plugin_id == "demo-service":
                    self.assertIsNone(manifest["frontend"])
                    self.assertFalse((directory / "frontend").exists())
                    daily = next(t for t in manifest["tasks"] if t["id"] == "daily-reminder")
                    self.assertEqual(daily["schedule"], {"configTime": "time", "configTimezone": "timezone"})
                else:
                    self.assertEqual(manifest["frontend"]["entry"], "frontend/entry.js")
                self.assertTrue(manifest["icons"])
                for icon in manifest["icons"]:
                    data = (directory / icon).read_bytes()
                    self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
                    self.assertTrue(icon.endswith(".png"))
                for field in schema["properties"].values():
                    self.assertTrue(field["group"])
                    self.assertTrue(field["description"])

    def test_page_exact_defaults_and_display_only_format_metadata(self):
        _, _, schema, _ = package("demo-page")
        self.assertEqual(schema_defaults(schema), PAGE_DEFAULTS)
        for key, fmt in (("targetDate", "date"), ("checkpoint", "date-time"),
                         ("contactEmail", "email"), ("referenceURL", "uri")):
            field = schema["properties"][key]
            self.assertEqual(field["format"], fmt)
            self.assertIn("仅展示", field["description"])
        self.assertEqual(schema["properties"]["categories"]["minItems"], 1)

    def test_page_config_bounds_formats_and_multiselect(self):
        _, _, schema, _ = package("demo-page")
        valid = [{"pageSize": 1, "multiplier": 0.1, "categories": ["运动"]},
                 {"pageSize": 50, "multiplier": 10, "tone": "暖色", "autoRefresh": False}]
        self._config_cases(schema, valid, [
            {"pageSize": 0}, {"pageSize": 51}, {"pageSize": True}, {"pageSize": 1.5},
            {"multiplier": 0.09}, {"multiplier": 10.1}, {"multiplier": float("nan")},
            {"multiplier": True}, {"tone": "未知"}, {"categories": []},
            {"categories": ["日常", "日常"]}, {"categories": ["未知"]},
            {"targetDate": "2030-02-30"}, {"checkpoint": "2030-01-01T12:00:00"},
            {"contactEmail": "invalid"}, {"referenceURL": "file:///tmp/x"},
            {"recordBackground": 1}, {"captureEvents": "true"}, {"unknown": True},
        ])

    def test_service_config_defaults_bounds_formats_and_multiselect(self):
        _, _, schema, _ = package("demo-service")
        defaults = schema_defaults(schema)
        self.assertEqual(set(defaults), {"message", "channel", "time", "timezone", "weekdays",
                                         "batchSize", "multiplier", "recordHeartbeat", "captureEvents", "simulateFailure"})
        self.assertEqual(defaults["weekdays"], WEEKDAYS)
        self.assertEqual(defaults["time"], "20:00")
        self.assertEqual(defaults["timezone"], "Asia/Shanghai")
        self.assertEqual(defaults["batchSize"], 1)
        self.assertEqual(defaults["multiplier"], 1)
        self.assertTrue(defaults["recordHeartbeat"])
        self.assertTrue(defaults["captureEvents"])
        self.assertFalse(defaults["simulateFailure"])
        self._config_cases(schema, [
            {"message": "x" * 200, "time": "20:00:30", "batchSize": 3, "multiplier": 10},
            {"weekdays": [], "timezone": "America/Los_Angeles", "channel": "执行日志", "multiplier": 0.1},
        ], [
            {"message": "x" * 201}, {"channel": "短信"}, {"time": "20:00:60"},
            {"time": "8:00"}, {"time": "24:00"}, {"timezone": "Unknown/Zone"},
            {"weekdays": ["周一", "周一"]}, {"weekdays": ["星期一"]},
            {"batchSize": 0}, {"batchSize": 4}, {"batchSize": True}, {"batchSize": 1.5},
            {"multiplier": 0}, {"multiplier": 11}, {"multiplier": float("inf")},
            {"recordHeartbeat": "true"}, {"captureEvents": 1}, {"simulateFailure": 0},
        ])

    def _config_cases(self, schema, valid, invalid):
        defaults = schema_defaults(schema)
        for change in valid:
            with self.subTest(valid=change):
                config = {**defaults, **change}
                self.assertEqual(validate_config(schema, config), config)
        for change in invalid:
            with self.subTest(invalid=change), self.assertRaises(ApiError):
                validate_config(schema, {**defaults, **change})


class DemoRequestTests(unittest.TestCase):
    def test_info_exact_public_keys_no_context_leak_and_detached_config(self):
        for plugin_id in PLUGIN_IDS:
            with self.subTest(plugin_id=plugin_id):
                *_, module = package(plugin_id)
                ctx = context(plugin_id)
                before = copy.deepcopy(ctx)
                result = module.handle_request(ctx, "info", "GET", {})
                self.assertEqual(set(result), INFO_KEYS)
                for key in ("pluginId", "childId", "version", "releaseId", "configRevision", "config"):
                    self.assertEqual(result[key], ctx[key])
                self.assertIsNotNone(datetime.fromisoformat(result["serverTime"]).tzinfo)
                for value in ("private-signed-context", "private-nonce", "private-parent", "private-job", "scopeToken"):
                    self.assertNotIn(value, json.dumps(result))
                result["config"]["multiplier"] = 9
                self.assertEqual(ctx, before)
                # Contexts with missing optional config fields still use schema defaults.
                ctx["config"] = {}
                self.assertEqual(module.handle_request(ctx, "info", "GET", {})["config"], module.DEFAULT_CONFIG)

    def test_slow_is_two_second_read_only_info(self):
        for plugin_id in PLUGIN_IDS:
            with self.subTest(plugin_id=plugin_id):
                *_, module = package(plugin_id)
                ctx = context(plugin_id)
                before = copy.deepcopy(ctx)
                with patch.object(module.time, "sleep") as sleep, patch.object(module, "_now", return_value="2030-01-01T00:00:00+00:00"):
                    info = module.handle_request(ctx, "info", "GET", {})
                    slow = module.handle_request(ctx, "slow", "GET", {})
                sleep.assert_called_once_with(2)
                self.assertEqual(slow, info)
                self.assertNotIn("effects", slow)
                self.assertEqual(ctx, before)

    def test_probe_contract_one_effect_and_stable_manual_ids(self):
        body = {"operationId": "demo-manual-123", "message": "手动探测", "value": 2.5}
        for plugin_id in PLUGIN_IDS:
            with self.subTest(plugin_id=plugin_id):
                *_, module = package(plugin_id)
                ctx = context(plugin_id, {"multiplier": 1.5})
                before = copy.deepcopy((ctx, body))
                first = module.handle_request(ctx, "probe", "POST", body)
                second = module.handle_request(ctx, "probe", "POST", body)
                self.assertEqual({k: v for k, v in first.items() if k != "effects"},
                                 {"ok": True, **body, "weightedValue": 3.75})
                self.assertEqual(len(first["effects"]), 1)
                effect = first["effects"][0]
                self.assertEqual(set(effect), {"collection", "id", "payload"})
                self.assertEqual(effect["id"], "manual:raw:demo-manual-123")
                self.assertEqual(effect["collection"], "activity" if plugin_id == "demo-page" else "executions")
                self.assertEqual(effect["id"], second["effects"][0]["id"])
                self.assertEqual(effect["payload"]["weightedValue"], 3.75)
                self.assertEqual(effect["payload"]["configRevision"], 7)
                self.assertEqual((ctx, body), before)
                self.assertNotIn("scopeToken", json.dumps(first))
                zero = module.handle_request(ctx, "probe", "POST", {**body, "value": 0})
                self.assertEqual(zero["weightedValue"], 0)
                large = module.handle_request(ctx, "probe", "POST", {**body, "value": 1_000_001})
                self.assertEqual(large["weightedValue"], 1_500_001.5)

    def test_probe_rejects_invalid_body_before_effects(self):
        body = {"operationId": "demo-operation", "message": "test", "value": 1}
        invalid = [None, [], {}, {**body, "unknown": 1}]
        for key, values in (("operationId", [None, "short", "x" * 129, 12345678]),
                            ("message", [None, "", "x" * 201, 1]),
                            ("value", [None, "1", True, [], float("nan"), float("inf"),
                                       -float("inf"), 10 ** 1000])):
            invalid.extend({**body, key: value} for value in values)
        for plugin_id in PLUGIN_IDS:
            *_, module = package(plugin_id)
            ctx = context(plugin_id)
            before = copy.deepcopy(ctx)
            for bad in invalid:
                with self.subTest(plugin_id=plugin_id, body=bad), self.assertRaises(ValueError):
                    module.handle_request(ctx, "probe", "POST", bad)
            self.assertEqual(ctx, before)
            with self.assertRaisesRegex(ValueError, "加权"):
                module.handle_request(context(plugin_id, {"multiplier": 10}), "probe", "POST", {**body, "value": 1e308})

    def test_fail_unknown_paths_and_wrong_methods_fail_without_effects(self):
        for plugin_id in PLUGIN_IDS:
            *_, module = package(plugin_id)
            ctx = context(plugin_id)
            before = copy.deepcopy(ctx)
            for path, method in (("fail", "POST"), ("unknown", "GET"), ("", "GET"),
                                 ("info", "POST"), ("slow", "POST"), ("probe", "GET"),
                                 ("fail", "GET"), ("probe", "DELETE")):
                with self.subTest(plugin_id=plugin_id, path=path, method=method), self.assertRaises(ValueError):
                    module.handle_request(ctx, path, method, {})
            self.assertEqual(ctx, before)

    def test_health_cancel_shutdown_pure_and_context_independent(self):
        for plugin_id in PLUGIN_IDS:
            *_, module = package(plugin_id)
            with patch("builtins.open", side_effect=AssertionError("no files")), \
                 patch("socket.socket", side_effect=AssertionError("no network")), \
                 patch.object(module.time, "sleep", side_effect=AssertionError("no delay")):
                self.assertEqual(module.health(), {"ok": True})
                self.assertEqual(module.health(), {"ok": True})
                self.assertEqual(module.cancel_job({}, "job-id").get("effects", []), [])
                self.assertIsNone(module.shutdown())


class DemoJobTests(unittest.TestCase):
    def test_page_heartbeat_and_event_records_switches_and_stable_identity(self):
        *_, module = package("demo-page")
        ctx = context("demo-page")
        cases = [("heartbeat", {"occurrenceKey": "2030-01-01T00:00:00+00:00"}, "heartbeat"),
                 ("event:task.completed", {"occurrenceKey": "event-123", "eventType": "task.completed",
                                           "event": {"taskId": "task-a", "scopeToken": "not-for-records"}}, "task.completed")]
        for task, payload, kind in cases:
            with self.subTest(task=task):
                before = copy.deepcopy((ctx, payload))
                result = module.handle_job(ctx, task, payload)
                effect = result["effects"][0]
                self.assertEqual(effect["collection"], "activity")
                self.assertEqual(effect["payload"]["kind"], kind)
                self.assertEqual(set(effect["payload"]), {"kind", "createdAt", "message", "configRevision", "version", "occurrenceKey"})
                self.assertEqual(effect["payload"]["occurrenceKey"], payload["occurrenceKey"])
                self.assertEqual(effect["payload"]["version"], "1.0.0")
                self.assertEqual(effect["payload"]["configRevision"], 7)
                self.assertEqual(effect["id"], module.handle_job(ctx, task, payload)["effects"][0]["id"])
                self.assertEqual((ctx, payload), before)
        off = context("demo-page", {"recordBackground": False, "captureEvents": False})
        for task, payload, _ in cases:
            self.assertEqual(module.handle_job(off, task, payload), {"effects": []})

    def test_events_filtered_by_type_and_switch_for_both_plugins(self):
        for plugin_id in PLUGIN_IDS:
            *_, module = package(plugin_id)
            for event_type in (None, "task.deleted", "event:task.completed"):
                payload = {"occurrenceKey": "event-id", "eventType": event_type}
                self.assertEqual(module.handle_job(context(plugin_id), "event:task.completed", payload), {"effects": []})
            disabled = context(plugin_id, {"captureEvents": False})
            self.assertEqual(module.handle_job(disabled, "event:task.completed", {"eventType": "task.completed"}), {"effects": []})

    def test_service_all_job_kinds_batch_numeric_weights_and_minimal_event(self):
        *_, module = package("demo-service")
        ctx = context("demo-service", {"batchSize": 3, "multiplier": 1.5, "channel": "执行日志"})
        cases = [("heartbeat", {"occurrenceKey": "2030-01-01T00:00:00+00:00"}, 1),
                 ("daily-reminder", {"occurrenceKey": "2030-01-01T20:00:00+08:00"}, 1),
                 ("event:task.completed", {"occurrenceKey": "event-a", "eventType": "task.completed",
                                           "event": {"taskId": "task-a", "points": 2.5, "date": "2030-01-01",
                                                     "scopeToken": "private-event", "childSnapshot": {"secret": "private"}}}, 2.5)]
        all_ids = []
        for task, payload, points in cases:
            with self.subTest(task=task):
                before = copy.deepcopy((ctx, payload))
                effects = module.handle_job(ctx, task, payload)["effects"]
                ids = [effect["id"] for effect in effects]
                self.assertEqual(len(effects), 3)
                self.assertEqual(len(set(ids)), 3)
                self.assertEqual(ids, [effect["id"] for effect in module.handle_job(ctx, task, payload)["effects"]])
                all_ids.extend(ids)
                for index, effect in enumerate(effects, 1):
                    self.assertEqual(effect["collection"], "executions")
                    record = effect["payload"]
                    self.assertEqual(record["batchIndex"], index)
                    self.assertEqual(record["kind"], task.removeprefix("event:"))
                    self.assertEqual(record["points"], points)
                    self.assertEqual(record["weightedPoints"], points * 1.5)
                    self.assertIsInstance(record["weightedPoints"], (int, float))
                    self.assertEqual(record["message"], ctx["config"]["message"])
                    self.assertEqual(record["channel"], "执行日志")
                    self.assertEqual(record["time"], "20:00")
                    self.assertEqual(record["occurrenceKey"], payload["occurrenceKey"])
                    self.assertIsNotNone(datetime.fromisoformat(record["createdAt"]).tzinfo)
                    if task.startswith("event:"):
                        self.assertEqual(record["event"], {"taskId": "task-a", "date": "2030-01-01", "points": 2.5})
                    else:
                        self.assertNotIn("event", record)
                self.assertNotIn("private-event", json.dumps(effects))
                self.assertNotIn("scopeToken", json.dumps(effects))
                self.assertEqual((ctx, payload), before)
        self.assertEqual(len(set(all_ids)), 9)

    def test_service_daily_uses_occurrence_in_configured_zone_not_delivery_day(self):
        _, manifest, _, module = package("demo-service")
        daily = next(task for task in manifest["tasks"] if task["id"] == "daily-reminder")
        # Monday UTC is still Sunday in LA. Delivery time is deliberately Friday.
        now = datetime(2030, 1, 4, tzinfo=timezone.utc)
        with patch.object(module, "_now", return_value=now.isoformat()):
            ctx = context("demo-service", {"timezone": "America/Los_Angeles", "weekdays": ["周日"]})
            payload = {"occurrenceKey": "2030-01-07T01:00:00Z"}
            self.assertEqual(len(module.handle_job(ctx, "daily-reminder", payload)["effects"]), 1)
            ctx["config"]["weekdays"] = ["周一"]
            self.assertEqual(module.handle_job(ctx, "daily-reminder", payload), {"effects": []})
        # Exercise actual scheduler output, including configured seconds/offset.
        ctx = context("demo-service", {"time": "20:00:30", "weekdays": ["周一"]})
        key, due = occurrence(daily, ctx["config"], datetime(2030, 1, 7, 13, tzinfo=timezone.utc))
        self.assertEqual(key, "2030-01-07T20:00:30+08:00")
        self.assertEqual(due, datetime(2030, 1, 7, 12, 0, 30, tzinfo=timezone.utc))
        self.assertEqual(len(module.handle_job(ctx, "daily-reminder", {"occurrenceKey": key})["effects"]), 1)
        for bad in ("2030-01-07T20:00:00", "invalid", None):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                module.handle_job(ctx, "daily-reminder", {"occurrenceKey": bad})
        ctx["config"]["weekdays"] = []
        self.assertEqual(module.handle_job(ctx, "daily-reminder", {"occurrenceKey": key}), {"effects": []})
        self.assertTrue(module.handle_job(ctx, "heartbeat", {"occurrenceKey": key})["effects"])

    def test_service_heartbeat_gate_failure_simulation_and_no_external_io(self):
        *_, module = package("demo-service")
        ctx = context("demo-service", {"recordHeartbeat": False, "simulateFailure": True})
        self.assertEqual(module.handle_job(ctx, "heartbeat", {}), {"effects": []})
        ctx["config"]["recordHeartbeat"] = True
        ctx["config"]["batchSize"] = 3
        before = copy.deepcopy(ctx)
        cases = [("heartbeat", {"occurrenceKey": "heartbeat-key"}),
                 ("daily-reminder", {"occurrenceKey": "2030-01-07T20:00:00+08:00"}),
                 ("event:task.completed", {"occurrenceKey": "event-id", "eventType": "task.completed", "event": {"points": 3}})]
        with patch("builtins.open", side_effect=AssertionError("no files")), \
             patch("socket.socket", side_effect=AssertionError("no network")), \
             patch.object(module, "_record_id", side_effect=AssertionError("no effects before failure")):
            for task, payload in cases:
                with self.subTest(task=task), self.assertRaisesRegex(ValueError, "失败模拟"):
                    module.handle_job(ctx, task, payload)
        self.assertEqual(ctx, before)
        ctx["config"]["simulateFailure"] = False
        with patch("builtins.open", side_effect=AssertionError("no files")), \
             patch("socket.socket", side_effect=AssertionError("no network")):
            self.assertEqual(len(module.handle_job(ctx, *cases[0])["effects"]), 3)

    def test_service_actual_event_points_zero_negative_missing_and_invalid(self):
        *_, module = package("demo-service")
        ctx = context("demo-service", {"multiplier": 1.5})
        payload = {"occurrenceKey": "event-id", "eventType": "task.completed"}
        for event, points in (({}, 0), ({"points": 0}, 0), ({"points": -2.5}, -2.5)):
            result = module.handle_job(ctx, "event:task.completed", {**payload, "event": event})
            self.assertEqual(result["effects"][0]["payload"]["weightedPoints"], points * 1.5)
        for points in (True, "5", None, float("nan"), float("inf"), 10 ** 1000):
            with self.subTest(points=points), self.assertRaises(ValueError):
                module.handle_job(ctx, "event:task.completed", {**payload, "event": {"points": points}})
        with self.assertRaises(ValueError):
            module.handle_job(ctx, "event:task.completed", payload)

    def test_raw_and_hashed_ids_do_not_collide_through_real_handlers(self):
        unsafe = "demo/op1"
        digest = hashlib.sha256(unsafe.encode()).hexdigest()
        keys = (unsafe, digest, "sha256:" + digest, "raw:" + digest)
        for plugin_id in PLUGIN_IDS:
            with self.subTest(plugin_id=plugin_id):
                *_, module = package(plugin_id)
                ctx = context(plugin_id, {"batchSize": 3} if plugin_id == "demo-service" else {})
                manual_ids, job_ids = [], []
                for key in keys:
                    body = {"operationId": key, "message": key, "value": 1}
                    effect = module.handle_request(ctx, "probe", "POST", body)["effects"][0]
                    encoded = "sha256:" + digest if key == unsafe else "raw:" + key
                    self.assertEqual(effect["id"], "manual:" + encoded)
                    self.assertEqual(effect["id"], module.handle_request(ctx, "probe", "POST", body)["effects"][0]["id"])
                    manual_ids.append(effect["id"])
                    payload = {"occurrenceKey": key}
                    effects = module.handle_job(ctx, "heartbeat", payload)["effects"]
                    ids = [item["id"] for item in effects]
                    expected = (["heartbeat:" + encoded + ":" + str(index) for index in range(1, 4)]
                                if plugin_id == "demo-service" else ["heartbeat:" + encoded])
                    self.assertEqual(ids, expected)
                    self.assertEqual(ids, [item["id"] for item in module.handle_job(ctx, "heartbeat", payload)["effects"]])
                    job_ids.extend(ids)
                self.assertEqual(len(set(manual_ids)), len(manual_ids))
                self.assertEqual(len(set(job_ids)), len(job_ids))

    def test_unsafe_ids_hashed_retries_stable_and_tasks_never_collide(self):
        for plugin_id in PLUGIN_IDS:
            *_, module = package(plugin_id)
            ctx = context(plugin_id)
            for key in ("发生/时间 空格", "a/b", "a?b", "x" * 240):
                payload = {"occurrenceKey": key}
                first = module.handle_job(ctx, "heartbeat", payload)["effects"][0]["id"]
                second = module.handle_job(ctx, "heartbeat", payload)["effects"][0]["id"]
                self.assertEqual(first, second)
                self.assertLessEqual(len(first), 512)
                self.assertRegex(first, r"^[A-Za-z0-9][A-Za-z0-9_.:@+\-]{0,511}$")
            for key in (None, "", "x" * 241):
                with self.subTest(plugin_id=plugin_id, key=key), self.assertRaises(ValueError):
                    module.handle_job(ctx, "heartbeat", {"occurrenceKey": key})
            with self.assertRaises(ValueError):
                module.handle_job(ctx, "unknown", {"occurrenceKey": "same"})
            # Unsafe manual operation IDs are also accepted as bounded input but hashed for storage.
            body = {"operationId": "demo/op 空间", "message": "test", "value": 1}
            effect = module.handle_request(ctx, "probe", "POST", body)["effects"][0]
            self.assertRegex(effect["id"], r"^manual:sha256:[a-f0-9]{64}$")
            self.assertEqual(effect["id"], module.handle_request(ctx, "probe", "POST", body)["effects"][0]["id"])
        *_, module = package("demo-service")
        ctx = context("demo-service")
        heartbeat = module.handle_job(ctx, "heartbeat", {"occurrenceKey": "same"})["effects"][0]["id"]
        event = module.handle_job(ctx, "event:task.completed", {"occurrenceKey": "same", "eventType": "task.completed", "event": {}})["effects"][0]["id"]
        self.assertNotEqual(heartbeat, event)


if __name__ == "__main__":
    unittest.main()
