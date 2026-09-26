import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMessage} from './mail-delivery.js';
import {submitTracked} from './resend-delivery.js';
test('tracked provider request preserves PDF, CC, correlation and idempotency',async()=>{
 const account={email:'info@example.com'}, content=Buffer.alloc(400000,65);
 const body={to:'a@example.com',cc:'b@example.com',subject:'Test',text:'مرحبا',trackingKey:'a'.repeat(64),attachments:[{filename:'test.pdf',content:content.toString('base64'),contentType:'application/pdf'}]};
 const prepared=await prepareMessage(account,body);
 const result=await submitTracked({prepared,account,body,apiKey:'test',fetcher:async(url,init)=>{
  const payload=JSON.parse(init.body);
  assert.equal(init.headers['Idempotency-Key'],'mail-'+body.trackingKey);
  assert.deepEqual(payload.cc,['b@example.com']);
  assert.equal(payload.tags.find(x=>x.name==='submission_id').value,body.trackingKey);
  assert.deepEqual(Buffer.from(payload.attachments[0].content,'base64'),content);
  return new Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}),{status:200});
 }});
 assert.ok(result.providerId);
 assert.equal(result.accepted.length,2);
});
test('provider rejection never becomes delivery success or SMTP fallback',async()=>{
 const account={email:'info@example.com'},body={to:'a@example.com',subject:'Test',text:'hello',trackingKey:'b'.repeat(64)};
 const prepared=await prepareMessage(account,body);
 await assert.rejects(()=>submitTracked({prepared,account,body,apiKey:'test',fetcher:async()=>new Response('{}',{status:429})}),e=>e.responseCode===429);
});
