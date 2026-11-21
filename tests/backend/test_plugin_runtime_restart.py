"""Host restarts restore live source sessions without reviving failed overlays."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from deploy.plugin_runtime import PluginRuntimeService
from lele_growth.child_service import ApiError


class DevelopmentWorkerRestartTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='plugin-restart-')
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.runtime = PluginRuntimeService.__new__(PluginRuntimeService)
        self.runtime.development = Mock(enabled=True, root=self.root)
        self.runtime.control_development = Mock()

    def session(self, plugin_id, *, backend=True, state='ready'):
        (self.root / (plugin_id + '.json')).write_text('{}')
        return {'pluginId': plugin_id, 'sessionId': plugin_id + '-session', 'backend': backend, 'state': state}

    def test_start_restores_persisted_backend_before_accepting_scheduled_work(self):
        session = self.session('mison-booking')
        self.runtime.development.read.return_value = session
        order = []
        self.runtime.control_development.side_effect = lambda *args: order.append('restored')
        thread = Mock()
        thread.start.side_effect = lambda: order.append('scheduler-started')
        with patch('deploy.plugin_runtime.threading.Thread', return_value=thread):
            self.runtime.start()
        self.assertEqual(order, ['restored', 'scheduler-started'])
        self.runtime.development.live.assert_called_once_with(session)
        self.runtime.control_development.assert_called_once_with('dev-reload', {
            'pluginId': 'mison-booking', 'sessionId': 'mison-booking-session'})

    def test_failed_and_frontend_only_sessions_stay_untouched_and_other_sessions_recover(self):
        sessions = {name: self.session(name, **changes) for name, changes in [
            ('a-dead', {}), ('b-failed', {'state': 'failed'}), ('c-frontend', {'backend': False}),
            ('d-incompatible', {}), ('e-live', {})]}
        self.runtime.development.read.side_effect = sessions.get

        def check_live(session):
            if session['pluginId'] == 'a-dead':
                raise ApiError(503, 'frontend is no longer running')

        def restore(action, body):
            if body['pluginId'] == 'd-incompatible':
                raise ApiError(409, 'installed version changed')

        self.runtime.development.live.side_effect = check_live
        self.runtime.control_development.side_effect = restore
        with self.assertLogs('deploy.plugin_runtime', level='WARNING'):
            self.runtime.restore_development_workers()
        self.assertEqual([call.args[1]['pluginId'] for call in self.runtime.control_development.call_args_list],
                         ['d-incompatible', 'e-live'])
        self.assertEqual([call.args[0]['pluginId'] for call in self.runtime.development.live.call_args_list],
                         ['a-dead', 'd-incompatible', 'e-live'])

    def test_production_does_not_read_or_restore_development_sessions(self):
        self.runtime.development.enabled = False
        self.runtime.restore_development_workers()
        self.runtime.development.read.assert_not_called()
        self.runtime.control_development.assert_not_called()
