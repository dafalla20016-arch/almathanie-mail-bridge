import { simpleParser } from 'mailparser';

// Provider submission is queued, never recipient delivery. Only signed events confirm delivery.
export async function submitTracked({prepared, account, body, apiKey, fetcher = fetch}) {
  if (!apiKey) throw Object.assign(new Error('Delivery tracking is not configured'), {code:'TRACKING_UNAVAILABLE', responseCode:503});
  const parsed = await simpleParser(prepared.raw);
  const headers = {};
  if (parsed.inReplyTo) headers['In-Reply-To'] = parsed.inReplyTo;
  if (parsed.references) headers.References = [].concat(parsed.references).join(' ');
  const response = await fetcher('https://api.resend.com/emails', {
    method:'POST', signal:AbortSignal.timeout(25000),
    headers:{Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', 'Idempotency-Key':`mail-${body.trackingKey}`},
    body:JSON.stringify({
      from:account.email, to:parsed.to.value.map(x=>x.address),
      ...(parsed.cc?.value?.length ? {cc:parsed.cc.value.map(x=>x.address)} : {}),
      subject:parsed.subject, text:parsed.text, ...(parsed.html ? {html:parsed.html} : {}), headers,
      attachments:parsed.attachments.map(x=>({filename:x.filename,content:x.content.toString('base64'),content_type:x.contentType,...(x.cid?{content_id:x.cid}: {})})),
      tags:[{name:'app',value:'almathanie_mail'},{name:'submission_id',value:body.trackingKey}],
    }),
  });
  const result = await response.json().catch(()=>({}));
  if (!response.ok) throw Object.assign(new Error('Delivery provider rejected submission'), {code:'PROVIDER_REJECTED', responseCode:response.status < 500 ? response.status : undefined});
  if (typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(result.id)) throw new Error('Provider acceptance is unknown');
  return {providerId:result.id, accepted:prepared.envelope.to, rejected:[], response:'250 Provider queued'};
}
