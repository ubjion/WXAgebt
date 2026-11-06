import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reader_setup_under_test', pathlib.Path(__file__).with_name('reader_setup.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

class ExistingKeyOnlyTests(unittest.TestCase):
    def connect(self, key='', error=None):
        account = {'dbPath': 'fixture', 'myWxid': 'fixture', 'ready': True}
        with patch.object(reader, 'discover_accounts', return_value=[account]), patch.object(reader, 'credential', side_effect=lambda value, protect=False: 'protected' if protect else value), patch.object(reader, 'verify_database', side_effect=error), patch.object(reader, 'capture_key', side_effect=AssertionError('capture must never run')):
            return reader.connect({'dbPath': 'fixture', 'myWxid': 'fixture', 'decryptKey': key, 'autoKey': True, 'wechatExecutable': 'ignored'})
    def test_missing_existing_key_never_falls_back_to_capture(self):
        with self.assertRaisesRegex(reader.SetupError, 'READER_KEY_REQUIRED'):
            self.connect()
    def test_invalid_existing_key_never_falls_back_to_capture(self):
        with self.assertRaisesRegex(reader.SetupError, 'READER_KEY_INVALID'):
            self.connect('a' * 64, reader.SetupError('READER_KEY_INVALID'))
    def test_valid_existing_key_is_verified_and_protected(self):
        self.assertEqual(self.connect('a' * 64)['protectedKey'], 'protected')
    def test_direct_capture_entry_refuses_before_loading_a_library(self):
        with patch.object(reader.ctypes, 'CDLL', side_effect=AssertionError('DLL must never load')):
            with self.assertRaisesRegex(reader.SetupError, 'READER_KEY_CAPTURE_DISABLED'):
                reader.capture_key('ignored', 'ignored')

if __name__ == '__main__':
    unittest.main()

