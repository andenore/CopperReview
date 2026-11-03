import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {electricalInput,compileSource} from '../copper_review/web/compiler.js';
test('browser IR import hashes exact original BOM and CRLF bytes without a server',async()=>{const raw=Buffer.from('\ufeff{\r\n"schema":"copperscript-ir/v0.1","kind":"board","name":"Test"\r\n}');const value=await electricalInput(raw,'input.json');assert.equal(value.input.sha256,createHash('sha256').update(raw).digest('hex'));assert.equal(value.ir.name,'Test');assert.equal(value.schema,'copper-review-electrical/v1');});
test('wrong IR schema and oversized UTF-8 source fail before compiler startup',async()=>{await assert.rejects(()=>electricalInput(Buffer.from('{}'),'bad.json'),/board IR/);await assert.rejects(()=>compileSource('🟠'.repeat(140000)),/512 KiB/);});
test('the SHA-256 fallback used outside secure contexts matches Node crypto at block boundaries',async()=>{
 const {sha256Fallback,randomId}=await import('../copper_review/web/hash.js'),{createHash,randomBytes}=await import('node:crypto');
 for(const n of [0,1,55,56,63,64,65,119,120,4097]){const b=randomBytes(n);assert.equal(sha256Fallback(new Uint8Array(b)),createHash('sha256').update(b).digest('hex'),`length ${n}`);}
 assert.match(randomId(),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
