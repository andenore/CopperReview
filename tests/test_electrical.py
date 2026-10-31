import hashlib
import json
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from copper_review.electrical import import_electrical
import test_server


IR = {'schema': 'copperscript-ir/v0.1', 'kind': 'board', 'name': 'Test', 'components': [], 'nets': [], 'parts': []}


class ElectricalTests(unittest.TestCase):
    def test_exact_original_bytes_hash(self):
        raw = b'\xef\xbb\xbf' + json.dumps(IR, indent=2).replace('\n', '\r\n').encode()
        value = import_electrical(raw, 'electrical.ir.json')
        self.assertEqual(value['input']['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['ir'], IR)

    def test_reject_other_documents_and_malformed_shape(self):
        for value in ({}, {**IR, 'schema': 'future'}, {**IR, 'kind': 'module'}, {**IR, 'nets': {}}):
            with self.assertRaises(ValueError):
                import_electrical(json.dumps(value).encode(), 'bad.json')


class ElectricalServerTests(test_server.ServerTests):
    def test_binary_ir_import_and_authenticated_reload(self):
        raw = json.dumps(IR).encode()
        request = Request(self.url+'/api/import', data=raw, headers={
            'X-Copper-Token': 'test-token', 'Content-Type': 'application/octet-stream', 'X-Copper-Filename': 'electrical.json'})
        with urlopen(request) as response:
            scene = json.load(response)
        self.assertEqual(scene['schema'], 'copper-review-electrical/v1')
        with self.request('/api/scene', **{'X-Copper-Token': 'test-token'}) as response:
            self.assertEqual(json.load(response), scene)
        with self.request('/electrical-model.js') as response:
            self.assertIn(b'electricalModel', response.read())
        bad = Request(self.url+'/api/import', data=b'{}', headers={
            'X-Copper-Token': 'test-token', 'Content-Type': 'application/octet-stream', 'X-Copper-Filename': 'bad.json'})
        with self.assertRaises(HTTPError):
            urlopen(bad)
        with self.request('/api/scene', **{'X-Copper-Token': 'test-token'}) as response:
            self.assertEqual(json.load(response), scene)
