"""Restart Manager ownership probe tests. Only synthetic files/processes are used."""
import importlib.util,pathlib,subprocess,sys,tempfile,unittest,stat
from unittest.mock import patch
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('probe',pathlib.Path(__file__).with_name('wechat-session-probe.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
class ProbeTests(unittest.TestCase):
 def test_real_file_owner_is_identified_without_injection(self):
  with tempfile.TemporaryDirectory() as directory:
   file=pathlib.Path(directory)/'contact.db';file.write_bytes(b'synthetic')
   child=subprocess.Popen([sys.executable,'-c','import sys;f=open(sys.argv[1],"rb");print("ready",flush=True);sys.stdin.readline()',str(file)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   try:
    self.assertEqual(child.stdout.readline().strip(),'ready');owners=w.file_owners([str(file)]);self.assertTrue(any(row['pid']==child.pid and row['startTime'].isdigit() for row in owners))
   finally:child.communicate('\n',timeout=5)
 def test_directories_are_not_accepted_as_file_resources(self):
  with tempfile.TemporaryDirectory() as directory:
   with self.assertRaises(ValueError):w.file_owners([directory])
 def test_reparse_resources_and_permission_failures_are_rejected(self):
  with patch.object(pathlib.Path,'lstat',return_value=SimpleNamespace(st_mode=stat.S_IFDIR,st_file_attributes=0x400)):
   with self.assertRaises(w.ProbeError):w.resource_exists(pathlib.Path('synthetic'),True)
  with patch.object(pathlib.Path,'lstat',side_effect=PermissionError()):
   with self.assertRaises(w.ProbeError):w.resource_exists(pathlib.Path('synthetic'),True)
 def test_candidate_scan_is_bounded_and_includes_selected_account(self):
  with tempfile.TemporaryDirectory() as directory:
   selected=pathlib.Path(directory)/'wxid_a';db=selected/'db_storage/contact';db.mkdir(parents=True);(db/'contact.db').write_bytes(b'x');other=pathlib.Path(directory)/'wxid_b/db_storage';other.mkdir(parents=True)
   result=w.account_candidates(str(selected));self.assertIn(str(selected.resolve()),result);self.assertLessEqual(len(result),32)
if __name__=='__main__':unittest.main(verbosity=2)
