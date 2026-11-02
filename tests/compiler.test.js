import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {electricalInput,compileSource} from '../copper_review/web/compiler.js';
test('browser IR import hashes exact original BOM and CRLF bytes without a server',async()=>{const raw=Buffer.from('﻿{\r\n"schema":"copperscript-ir/v0.1","kind":"board","name":"Test"\r\n}');const value=await electricalInput(raw,'input.json');assert.equal(value.input.sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(value.ir.name,'Test');assert.equal(value.schema,'copper-review-electrical/v1');});
test('wrong IR schema and oversized UTF-8 source fail before compiler startup',async()=>{await assert.rejects(()=>electricalInput(Buffer.from('{}'),'bad.json'),/board IR/);await assert.rejects(()=>compileSource('🟠'.repeat(140000)),/512 KiB/);});
