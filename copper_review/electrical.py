"""Identify public CopperScript electrical IR, retaining its exact input bytes hash.

Electrical semantics and module expansion live in the buildless JS adapter, shared
by the browser and Node contract tests. No compiler package is imported here.
"""
import hashlib
import json
from pathlib import PurePath


def _reject_constant(value):
    raise ValueError(f'Invalid JSON number: {value}')


def import_electrical(data: bytes, filename: str):
    ir = json.loads(data.decode('utf-8-sig'), parse_constant=_reject_constant)
    if not isinstance(ir, dict) or ir.get('schema') != 'copperscript-ir/v0.1' or ir.get('kind') != 'board':
        raise ValueError('Expected a copperscript-ir/v0.1 board')
    if not isinstance(ir.get('name'), str) or not ir['name']:
        raise ValueError('Electrical IR has no board name')
    for field in ('components', 'nets', 'parts'):
        if not isinstance(ir.get(field), list):
            raise ValueError(f'Electrical IR {field} must be an array')
    return {'schema': 'copper-review-electrical/v1',
            'input': {'filename': PurePath(filename).name,
                      'sha256': hashlib.sha256(data).hexdigest()}, 'ir': ir}
