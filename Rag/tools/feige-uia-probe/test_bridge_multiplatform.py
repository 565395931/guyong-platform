"""Offline regressions: no screenshots, clicks, network or customer sends."""
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import bridge_node as bn


class BridgeIsolationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.outbox = patch.object(bn, 'OUTBOX_FILE', os.path.join(self.directory.name, 'outbox.json'))
        self.outbox.start()
        self.addCleanup(self.outbox.stop)
        self.addCleanup(self.directory.cleanup)

    def node(self, allow_send=True):
        node = bn.BridgeNode('http://localhost', {'nodeKey': 'node-test', 'enrollmentToken': 'test-only'}, None, 3, allow_send)
        node.ws = Mock()
        return node

    def ready(self, node, accounts):
        with patch.object(node, 'start_pdd_reader'):
            node.handle_frame({'type': 'node.ready', 'payload': {'configuration': {'accounts': accounts}}})

    def account(self, identifier, adapter):
        return {'accountId': identifier, 'adapterId': adapter, 'leaseToken': 'test-only', 'generation': 1}

    def test_accounts_are_selected_by_adapter_and_revocation_clears_them(self):
        node = self.node()
        self.ready(node, [self.account(1, 'xiaohongshu.qianfan'), self.account(5, 'pinduoduo.workbench'), self.account(8, 'doudian.feige')])
        self.assertEqual(node.account_id, 8)
        self.assertEqual(node.pdd_account_id, 5)
        self.ready(node, [])
        self.assertIsNone(node.account_id)
        self.assertIsNone(node.pdd_account_id)

    def test_ambiguous_same_adapter_does_not_guess_shop(self):
        node = self.node()
        self.ready(node, [self.account(1, 'pinduoduo.workbench'), self.account(2, 'pinduoduo.workbench')])
        self.assertIsNone(node.pdd_account_id)
        self.assertIsNone(node.account_id)

    def test_non_feige_and_dry_run_commands_never_call_desktop_sender(self):
        sender = Mock()
        for adapter, enabled in [('pinduoduo.workbench', True), ('xiaohongshu.qianfan', True), ('doudian.feige', False)]:
            node = self.node(enabled)
            node.accounts = {5: self.account(5, adapter)}
            node.send_command_status = Mock()
            with patch.dict(sys.modules, {'feige_send': sender}):
                node.run_command({'commandId': 'test-command', 'payload': {'accountId': 5, 'content': 'synthetic'}})
            self.assertEqual(node.send_command_status.call_args.args[1], 'failed')
        sender.send_text.assert_not_called()

    def test_outbox_survives_disconnect_restart_and_waits_for_ack(self):
        node = self.node()
        event = bn.envelope('message.inbound', {'content': 'synthetic'}, node_key=node.node_key)
        node.ws.send.side_effect = ConnectionError('offline')
        with self.assertRaises(ConnectionError):
            node.send_reliable(event)
        restarted = self.node()
        restarted.retry_outbox()
        sent = json.loads(restarted.ws.send.call_args.args[0])
        self.assertEqual(sent['eventId'], event['eventId'])
        restarted.handle_frame({'type': 'event.ack', 'payload': {'ackForEventId': event['eventId'], 'status': 'retryable_error'}})
        self.assertIn(event['eventId'], restarted.pending_events)
        restarted.handle_frame({'type': 'event.ack', 'payload': {'ackForEventId': event['eventId'], 'status': 'duplicate'}})
        self.assertNotIn(event['eventId'], self.node().pending_events)

    def test_heartbeat_runs_independently_of_ui_lock(self):
        node = self.node()
        node.leases = [{'accountId': 8}]
        node.send_heartbeat = Mock()
        stop = Mock()
        stop.wait.side_effect = [False, True]
        with node.ui_lock:
            node._heartbeat_loop(stop)
        node.send_heartbeat.assert_called_once()


class PddHistoryTests(unittest.TestCase):
    def test_history_and_current_view_share_conversation_and_fingerprint(self):
        sys.path.insert(0, bn.PDD_READER_DIR)
        import pdd_reader as pr
        reader = pr.PddChatReader()
        msg = {'direction': 'in', 'text': 'synthetic', 'timeText': '12:00'}
        reader._snapshot = Mock(return_value=({}, []))
        reader._click_by_name = Mock(return_value=True)
        reader._initial_backfill = Mock(return_value=[{**msg, 'fp': pr.fingerprint('test-customer', 'in', '12:00', 'synthetic', 0)}])
        groups = [{'label': 'pending', 'count': 1, 'items': [{'name': 'test-customer', 'preview': 'synthetic'}]}]
        with patch.object(pr, 'image_size', return_value=(1000, 800)), \
             patch.object(pr, 'parse_cs_panel', return_value={'groups': groups}), \
             patch.object(pr, 'parse_middle_chat', return_value={'messages': [msg]}), \
             patch.object(pr, 'apply_direction_by_color'), \
             patch.object(pr, 'read_conversation_title', return_value='test-customer'), \
             patch.object(pr, 'masked_customer_name', side_effect=lambda name: name), \
             patch.object(pr.time, 'sleep'):
            result = reader._read_once_inner(log=lambda *args: None)
        self.assertEqual(len(result['newMessages']), 1)
        self.assertEqual(result['newMessages'][0]['conversationKey'], 'pdd:test-customer')


if __name__ == '__main__':
    unittest.main()
