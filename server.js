#!/usr/bin/env node
/**
 * Platinum Cubed MCP Server
 * Stripe-gated Salesforce MCP with two tiers (Read Only / Full Access)
 */

const express  = require('express');
const https    = require('https');
const http     = require('http');
const urlLib   = require('url');
const zlib     = require('zlib');
const crypto   = require('crypto');
const Stripe   = require('stripe');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const PC_CLIENT_ID       = process.env.PC_CLIENT_ID     || '';
const PC_CLIENT_SECRET   = process.env.PC_CLIENT_SECRET || '';
const SERVER_URL         = process.env.SERVER_URL        || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY  = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUB_KEY     = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_51RvOwbEQH6zC3Nb94rDdRkP39zMFv1spFV5vlmFZYzNedGLG2o4kPOpLQ6GcFTkVwlgVRfjjWJpP7zWvLLv3mRFr00i3nxtZL6';
const CALLBACK_URL       = `${SERVER_URL}/oauth/callback`;
const API_VERSION        = 'v62.0';
const API_VER_NUM        = '62.0';

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// ── Pricing ───────────────────────────────────────────────────────────────────
// After creating products in Stripe dashboard, add price IDs as env vars
const PRICES = {
  readonly_monthly:  process.env.PRICE_READONLY_MONTHLY  || '',
  readonly_annual:   process.env.PRICE_READONLY_ANNUAL   || '',
  full_monthly:      process.env.PRICE_FULL_MONTHLY      || '',
  full_annual:       process.env.PRICE_FULL_ANNUAL       || '',
};

// ── In-memory stores ──────────────────────────────────────────────────────────
const sessions   = new Map(); // sessionId -> { accessToken, instanceUrl, tier }
const pkceStore  = new Map(); // stateToken -> codeVerifier
const paidUsers  = new Map(); // email -> { tier, stripeCustomerId, validUntil }
const pendingCheckouts = new Map(); // checkoutSessionId -> { tier, instanceUrl }

// ── Middleware ────────────────────────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = urlLib.parse(opts.url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path,
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) }
    };
    if (body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      reqOpts.headers['Content-Length'] = buf.length;
    }
    const req = lib.request(reqOpts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
        catch { resolve({ status: res.statusCode, body: raw, raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.end();
  });
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateCodeVerifier()  { return base64urlEncode(crypto.randomBytes(32)); }
function generateCodeChallenge(v) { return base64urlEncode(crypto.createHash('sha256').update(v).digest()); }

// ── Salesforce helpers ────────────────────────────────────────────────────────
async function sfRequest(session, method, urlPath, body, contentType) {
  const ct = contentType || 'application/json';
  const headers = { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': ct };
  if (ct === 'application/json' && body && typeof body === 'object') body = JSON.stringify(body);
  return request({ url: session.instanceUrl + urlPath, method, headers }, body || undefined);
}
function sfErr(res) {
  const b = res.body;
  if (Array.isArray(b) && b[0]) return b[0].message || JSON.stringify(b[0]);
  if (b && b.message) return b.message;
  if (b && b.error) return b.error + ': ' + (b.error_description || '');
  return typeof b === 'string' ? b.slice(0, 300) : JSON.stringify(b).slice(0, 300);
}
async function sfQuery(s, soql) {
  const r = await sfRequest(s,'GET',`/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function sfSearch(s, sosl) {
  const r = await sfRequest(s,'GET',`/services/data/${API_VERSION}/search?q=${encodeURIComponent(sosl)}`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function sfDescribe(s, obj) {
  const r = await sfRequest(s,'GET',`/services/data/${API_VERSION}/sobjects/${obj}/describe`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function sfListObjects(s) {
  const r = await sfRequest(s,'GET',`/services/data/${API_VERSION}/sobjects`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function sfGetRecord(s, obj, id, fields) {
  let p = `/services/data/${API_VERSION}/sobjects/${obj}/${id}`;
  if (fields&&fields.length) p+='?fields='+fields.join(',');
  const r = await sfRequest(s,'GET',p); if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function sfCreateRecord(s,obj,fields) {
  const r=await sfRequest(s,'POST',`/services/data/${API_VERSION}/sobjects/${obj}`,fields);
  if (r.status!==201) throw new Error(sfErr(r)); return r.body;
}
async function sfUpdateRecord(s,obj,id,fields) {
  const r=await sfRequest(s,'PATCH',`/services/data/${API_VERSION}/sobjects/${obj}/${id}`,fields);
  if (r.status!==204&&r.status!==200) throw new Error(sfErr(r)); return {success:true,id};
}
async function sfUpsertRecord(s,obj,extField,extVal,fields) {
  const r=await sfRequest(s,'PATCH',`/services/data/${API_VERSION}/sobjects/${obj}/${extField}/${encodeURIComponent(extVal)}`,fields);
  if (![200,201,204].includes(r.status)) throw new Error(sfErr(r)); return {success:true,created:r.status===201};
}
async function sfDeleteRecord(s,obj,id) {
  const r=await sfRequest(s,'DELETE',`/services/data/${API_VERSION}/sobjects/${obj}/${id}`);
  if (r.status!==204) throw new Error(sfErr(r)); return {success:true,id};
}
async function toolingQuery(s,soql) {
  const r=await sfRequest(s,'GET',`/services/data/${API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function toolingCreate(s,type,body) {
  const r=await sfRequest(s,'POST',`/services/data/${API_VERSION}/tooling/sobjects/${type}`,body);
  if (r.status!==201) throw new Error(sfErr(r)); return r.body;
}
async function toolingUpdate(s,type,id,body) {
  const r=await sfRequest(s,'PATCH',`/services/data/${API_VERSION}/tooling/sobjects/${type}/${id}`,body);
  if (r.status!==204&&r.status!==200) throw new Error(sfErr(r)); return {success:true,id};
}
async function toolingGet(s,type,id) {
  const r=await sfRequest(s,'GET',`/services/data/${API_VERSION}/tooling/sobjects/${type}/${id}`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function executeAnonymous(s,code) {
  const r=await sfRequest(s,'GET',`/services/data/${API_VERSION}/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(code)}`);
  if (r.status!==200) throw new Error(sfErr(r)); return r.body;
}
async function runTests(s,classNames) {
  const r=await sfRequest(s,'POST',`/services/data/${API_VERSION}/tooling/runTestsAsynchronous`,{tests:classNames.map(n=>({className:n}))});
  if (r.status!==200&&r.status!==201) throw new Error(sfErr(r));
  const testRunId=typeof r.body==='string'?r.body.replace(/"/g,''):r.body;
  for (let i=0;i<30;i++) {
    await new Promise(r=>setTimeout(r,2000));
    const st=await toolingQuery(s,`SELECT Id,Status,TestTime,MethodsCompleted,MethodsFailed FROM ApexTestRunResult WHERE AsyncApexJobId='${testRunId}'`);
    const run=st.records&&st.records[0]; if (!run) continue;
    if (run.Status==='Completed'||run.Status==='Failed') {
      const res=await toolingQuery(s,`SELECT MethodName,Outcome,Message,StackTrace,ApexClass.Name FROM ApexTestResult WHERE AsyncApexJobId='${testRunId}' ORDER BY ApexClass.Name,MethodName`);
      return {summary:{status:run.Status,testTime:run.TestTime,completed:run.MethodsCompleted,failed:run.MethodsFailed},results:(res.records||[]).map(r=>({class:r.ApexClass&&r.ApexClass.Name,method:r.MethodName,outcome:r.Outcome,message:r.Message}))};
    }
  }
  throw new Error('Test run timed out.');
}
async function saveApexClass(s,name,body,existingId) {
  const c=await toolingCreate(s,'MetadataContainer',{Name:'PC_'+Date.now()});
  const cid=c.id;
  try {
    if (existingId) await toolingCreate(s,'ApexClassMember',{MetadataContainerId:cid,ContentEntityId:existingId,Body:body});
    else await toolingCreate(s,'ApexClassMember',{MetadataContainerId:cid,FullName:name,Body:body});
    const d=await toolingCreate(s,'ContainerAsyncRequest',{MetadataContainerId:cid,IsCheckOnly:false,IsRunTests:false});
    for (let i=0;i<20;i++) {
      await new Promise(r=>setTimeout(r,1500));
      const st=await toolingGet(s,'ContainerAsyncRequest',d.id);
      if (st.State==='Completed') return {success:true,state:st.State,name};
      if (st.State==='Failed'||st.State==='Aborted') {
        let msg=st.CompilerErrors||st.ErrorMsg||st.State;
        try{msg=JSON.parse(msg).map(e=>`Line ${e.line}: ${e.problem}`).join('\n');}catch{}
        throw new Error('Apex compile failed:\n'+msg);
      }
    }
    throw new Error('Apex deploy timed out.');
  } finally { try{await sfRequest(s,'DELETE',`/services/data/${API_VERSION}/tooling/sobjects/MetadataContainer/${cid}`);}catch{} }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS_READONLY = [
  {name:'sf_query',description:'Run a SOQL SELECT query.',inputSchema:{type:'object',properties:{soql:{type:'string',description:'SOQL SELECT statement'}},required:['soql']}},
  {name:'sf_search',description:'Run a SOSL search across objects.',inputSchema:{type:'object',properties:{sosl:{type:'string',description:'SOSL query string'}},required:['sosl']}},
  {name:'sf_describe',description:'Get the schema of a Salesforce object.',inputSchema:{type:'object',properties:{object_name:{type:'string',description:'API name, e.g. Account'}},required:['object_name']}},
  {name:'sf_list_objects',description:'List all queryable sObjects in the org.',inputSchema:{type:'object',properties:{}}},
  {name:'sf_get_record',description:'Fetch a single record by Id.',inputSchema:{type:'object',properties:{object_name:{type:'string'},record_id:{type:'string'},fields:{type:'array',items:{type:'string'}}},required:['object_name','record_id']}}
];
const TOOLS_FULL = [
  ...TOOLS_READONLY,
  {name:'sf_create_record',description:'Create a new record.',inputSchema:{type:'object',properties:{object_name:{type:'string'},fields:{type:'object'}},required:['object_name','fields']}},
  {name:'sf_update_record',description:'Update an existing record.',inputSchema:{type:'object',properties:{object_name:{type:'string'},record_id:{type:'string'},fields:{type:'object'}},required:['object_name','record_id','fields']}},
  {name:'sf_upsert_record',description:'Upsert using an external Id field.',inputSchema:{type:'object',properties:{object_name:{type:'string'},external_id_field:{type:'string'},external_id_value:{type:'string'},fields:{type:'object'}},required:['object_name','external_id_field','external_id_value','fields']}},
  {name:'sf_delete_record',description:'Delete a record by Id.',inputSchema:{type:'object',properties:{object_name:{type:'string'},record_id:{type:'string'}},required:['object_name','record_id']}},
  {name:'sf_list_apex_classes',description:'List all Apex classes.',inputSchema:{type:'object',properties:{name_filter:{type:'string'}}}},
  {name:'sf_get_apex_class',description:'Read the full body of an Apex class.',inputSchema:{type:'object',properties:{class_name:{type:'string'}},required:['class_name']}},
  {name:'sf_save_apex_class',description:'Create or update an Apex class.',inputSchema:{type:'object',properties:{class_name:{type:'string'},body:{type:'string'}},required:['class_name','body']}},
  {name:'sf_execute_anonymous',description:'Execute anonymous Apex code.',inputSchema:{type:'object',properties:{apex_code:{type:'string'}},required:['apex_code']}},
  {name:'sf_run_tests',description:'Run Apex test classes.',inputSchema:{type:'object',properties:{class_names:{type:'array',items:{type:'string'}}},required:['class_names']}},
  {name:'sf_list_flows',description:'List all flows.',inputSchema:{type:'object',properties:{name_filter:{type:'string'}}}},
  {name:'sf_get_flow',description:'Read a flow definition.',inputSchema:{type:'object',properties:{flow_api_name:{type:'string'}},required:['flow_api_name']}},
  {name:'sf_deploy_flow',description:'Deploy a flow via Metadata API.',inputSchema:{type:'object',properties:{flow_api_name:{type:'string'},flow_xml:{type:'string'}},required:['flow_api_name','flow_xml']}},
  {name:'sf_activate_flow',description:'Activate a flow version.',inputSchema:{type:'object',properties:{flow_api_name:{type:'string'}},required:['flow_api_name']}}
];

// ── Tool handler ──────────────────────────────────────────────────────────────
async function handleTool(session, name, args) {
  const text = v => ({content:[{type:'text',text:typeof v==='string'?v:JSON.stringify(v,null,2)}]});
  switch(name) {
    case 'sf_query': { const r=await sfQuery(session,args.soql); return text({totalSize:r.totalSize,done:r.done,records:r.records}); }
    case 'sf_search': return text(await sfSearch(session,args.sosl));
    case 'sf_describe': { const r=await sfDescribe(session,args.object_name); return text({name:r.name,label:r.label,fields:r.fields.map(f=>({name:f.name,label:f.label,type:f.type,length:f.length,nillable:f.nillable,referenceTo:f.referenceTo}))}); }
    case 'sf_list_objects': { const r=await sfListObjects(session); return text(r.sobjects.filter(o=>o.queryable).map(o=>({name:o.name,label:o.label,custom:o.custom})).sort((a,b)=>a.name.localeCompare(b.name))); }
    case 'sf_get_record': return text(await sfGetRecord(session,args.object_name,args.record_id,args.fields));
    case 'sf_create_record': return text(await sfCreateRecord(session,args.object_name,args.fields));
    case 'sf_update_record': return text(await sfUpdateRecord(session,args.object_name,args.record_id,args.fields));
    case 'sf_upsert_record': return text(await sfUpsertRecord(session,args.object_name,args.external_id_field,args.external_id_value,args.fields));
    case 'sf_delete_record': return text(await sfDeleteRecord(session,args.object_name,args.record_id));
    case 'sf_list_apex_classes': {
      let soql=`SELECT Id,Name,Status,LastModifiedDate FROM ApexClass WHERE ManageableState='unmanaged'`;
      if (args.name_filter) soql+=` AND Name LIKE '%${args.name_filter.replace(/'/g,"\\'")}%'`;
      soql+=' ORDER BY Name';
      return text((await toolingQuery(session,soql)).records);
    }
    case 'sf_get_apex_class': {
      const r=await toolingQuery(session,`SELECT Id,Name,Body,Status,LastModifiedDate FROM ApexClass WHERE Name='${args.class_name.replace(/'/g,"\\'")}' AND ManageableState='unmanaged'`);
      if (!r.records||r.records.length===0) throw new Error(`Apex class "${args.class_name}" not found.`);
      return text(r.records[0]);
    }
    case 'sf_save_apex_class': {
      const ex=await toolingQuery(session,`SELECT Id FROM ApexClass WHERE Name='${args.class_name.replace(/'/g,"\\'")}' AND ManageableState='unmanaged'`);
      const eid=ex.records&&ex.records[0]?ex.records[0].Id:null;
      return text({...await saveApexClass(session,args.class_name,args.body,eid),action:eid?'updated':'created'});
    }
    case 'sf_execute_anonymous': {
      const r=await executeAnonymous(session,args.apex_code);
      if (!r.compiled) throw new Error(`Compile error (line ${r.line}): ${r.compileProblem}`);
      return text({success:r.success,compiled:r.compiled,exceptionMessage:r.exceptionMessage,exceptionStackTrace:r.exceptionStackTrace});
    }
    case 'sf_run_tests': return text(await runTests(session,args.class_names));
    case 'sf_list_flows': {
      let soql=`SELECT Id,ApiName,Label,ProcessType,Status,VersionNumber,LastModifiedDate FROM FlowDefinition`;
      if (args.name_filter) soql+=` WHERE ApiName LIKE '%${args.name_filter.replace(/'/g,"\\'")}%'`;
      soql+=' ORDER BY ApiName';
      return text((await toolingQuery(session,soql)).records);
    }
    case 'sf_get_flow': {
      const d=await toolingQuery(session,`SELECT Id,ApiName,ActiveVersionId,LatestVersionId FROM FlowDefinition WHERE ApiName='${args.flow_api_name.replace(/'/g,"\\'")}' LIMIT 1`);
      if (!d.records||!d.records[0]) throw new Error(`Flow "${args.flow_api_name}" not found.`);
      const verId=d.records[0].ActiveVersionId||d.records[0].LatestVersionId;
      return text(await toolingGet(session,'Flow',verId));
    }
    case 'sf_activate_flow': {
      const d=await toolingQuery(session,`SELECT Id,LatestVersionId FROM FlowDefinition WHERE ApiName='${args.flow_api_name.replace(/'/g,"\\'")}' LIMIT 1`);
      if (!d.records||!d.records[0]) throw new Error(`Flow "${args.flow_api_name}" not found.`);
      await toolingUpdate(session,'FlowDefinition',d.records[0].Id,{ActiveVersionId:d.records[0].LatestVersionId});
      return text({success:true,flow:args.flow_api_name,activatedVersionId:d.records[0].LatestVersionId});
    }
    default: throw new Error('Unknown tool: '+name);
  }
}

// ── Stripe: create checkout session ──────────────────────────────────────────
app.post('/checkout', async (req, res) => {
  const { tier, billing, instance_url, email } = req.body;
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  // Check if user already has an active subscription
  if (email) {
    try {
      const customers = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 1 });
      if (customers.data && customers.data.length > 0) {
        const customer = customers.data[0];
        const subscriptions = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
        if (subscriptions.data && subscriptions.data.length > 0) {
          // Already subscribed — validate tier
          const sub = subscriptions.data[0];
          const subTier = sub.metadata && sub.metadata.tier ? sub.metadata.tier : null;

          // If they have readonly but are requesting full, deny it
          if (tier === 'full' && subTier === 'readonly') {
            return res.json({ tier_mismatch: true, subscribed_tier: 'readonly', message: 'Your current subscription is Read Only. Please upgrade to Full Access to use this tier.' });
          }

          // Use their subscribed tier (don't let them self-upgrade)
          const allowedTier = subTier || tier;
          return res.json({ already_subscribed: true, tier: allowedTier, instance_url: instance_url || '' });
        }
      }
    } catch(err) {
      // If check fails, proceed to checkout normally
      console.error('Subscription check error:', err.message);
    }
  }

  const priceKey = `${tier}_${billing}`; // e.g. readonly_monthly
  const priceId  = PRICES[priceKey];

  if (!priceId) {
    // No price ID configured yet — create on the fly using amount
    const amounts = {
      readonly_monthly: 2000,  // $20
      readonly_annual:  22000, // $220
      full_monthly:     4000,  // $40
      full_annual:      44000, // $440
    };
    const amount = amounts[priceKey];
    if (!amount) return res.status(400).json({ error: 'Invalid tier/billing' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: billing.includes('monthly') ? 'subscription' : 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Platinum Cubed MCP — ${tier === 'full' ? 'Full Access' : 'Read Only'} (${billing === 'monthly' ? 'Monthly' : 'Annual'})`,
            description: tier === 'full'
              ? 'Full Salesforce access: read, write, Apex, Flows'
              : 'Read-only Salesforce access: query, search, describe'
          },
          unit_amount: amount,
          ...(billing === 'monthly' ? { recurring: { interval: 'month' } } : {})
        },
        quantity: 1
      }],
      success_url: `${SERVER_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SERVER_URL}/`,
      metadata: { tier, billing, instance_url: instance_url || '' },
      subscription_data: { metadata: { tier, billing } }
    });

    pendingCheckouts.set(session.id, { tier, instanceUrl: instance_url || '' });
    return res.json({ url: session.url });
  }

  // Use pre-configured price ID
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${SERVER_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${SERVER_URL}/`,
    metadata: { tier, billing, instance_url: instance_url || '' },
    subscription_data: { metadata: { tier, billing } }
  });

  pendingCheckouts.set(session.id, { tier, instanceUrl: instance_url || '' });
  res.json({ url: session.url });
});

// ── Checkout success page ─────────────────────────────────────────────────────
app.get('/checkout/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id || !stripe) return res.redirect('/');

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(session_id);
    const email       = checkoutSession.customer_details?.email;
    const tier        = checkoutSession.metadata?.tier || 'readonly';
    const instanceUrl = checkoutSession.metadata?.instance_url || '';

    // Grant access
    if (email) {
      paidUsers.set(email, {
        tier,
        stripeCustomerId: checkoutSession.customer,
        paidAt: new Date().toISOString()
      });
    }

    // Redirect to OAuth connect
    const connectUrl = `/oauth/start?tier=${tier}&instance_url=${encodeURIComponent(instanceUrl)}&email=${encodeURIComponent(email||'')}`;
    res.send(`<!DOCTYPE html><html><head><title>Payment Successful!</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0B1829;color:white;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:#132035;border:1px solid #1e3a5f;border-radius:16px;padding:40px;max-width:500px;width:90%;text-align:center;}
  h1{color:#4CAF50;margin-bottom:16px;}
  p{color:#9ab;margin-bottom:24px;line-height:1.6;}
  .btn{display:inline-block;background:#2D7DD2;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;}
  .btn:hover{opacity:0.88;}
</style></head><body>
<div class="card">
  <h1>🎉 Payment Successful!</h1>
  <p>Thank you! Now let's connect your Salesforce org to Claude.</p>
  <a class="btn" href="${connectUrl}">Connect Salesforce →</a>
  ${checkoutSession.customer ? `<p style="margin-top:20px;font-size:13px;color:#9ab;">Want to cancel? <a href="/portal?customer_id=${checkoutSession.customer}" style="color:#4A9EE0;">Manage subscription</a></p>` : ""}
</div></body></html>`);
  } catch (err) {
    res.redirect('/');
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  // Handle subscription cancellations etc. in the future
  res.json({ received: true });
});

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.get('/oauth/start', (req, res) => {
  const tier        = req.query.tier        || 'readonly';
  const instanceUrl = req.query.instance_url || 'https://login.salesforce.com';
  const email       = req.query.email       || '';
  const stateToken  = crypto.randomBytes(16).toString('hex');
  const state       = stateToken + '|' + tier + '|' + encodeURIComponent(instanceUrl) + '|' + encodeURIComponent(email);
  const scope       = tier === 'full' ? 'full refresh_token' : 'api refresh_token';
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  pkceStore.set(stateToken, codeVerifier);
  if (pkceStore.size > 200) pkceStore.delete([...pkceStore.keys()][0]);
  const authUrl = `${instanceUrl}/services/oauth2/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: PC_CLIENT_ID, redirect_uri: CALLBACK_URL,
    scope, state, code_challenge: codeChallenge, code_challenge_method: 'S256'
  });
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error} — ${error_description}`);
  if (!code || !state) return res.status(400).send('Missing code or state');
  const parts = state.split('|');
  const stateToken  = parts[0];
  const tier        = parts[1] || 'readonly';
  const instanceUrl = decodeURIComponent(parts[2] || 'https://login.salesforce.com');
  const email       = decodeURIComponent(parts[3] || '');
  const codeVerifier = pkceStore.get(stateToken);
  pkceStore.delete(stateToken);
  try {
    const tokenParams = { grant_type:'authorization_code', code, client_id:PC_CLIENT_ID, client_secret:PC_CLIENT_SECRET, redirect_uri:CALLBACK_URL };
    if (codeVerifier) tokenParams.code_verifier = codeVerifier;
    const tokenRes = await request({ url:`${instanceUrl}/services/oauth2/token`, method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'} }, new URLSearchParams(tokenParams).toString());
    if (tokenRes.status!==200||!tokenRes.body.access_token) return res.status(400).send('Token exchange failed: '+JSON.stringify(tokenRes.body));
    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, { accessToken:tokenRes.body.access_token, refreshToken:tokenRes.body.refresh_token, instanceUrl:tokenRes.body.instance_url||instanceUrl, tier });
    if (sessions.size>100) sessions.delete([...sessions.keys()][0]);
    const mcpUrl = `${SERVER_URL}/mcp/${tier}?session=${sessionId}`;
    res.send(`<!DOCTYPE html><html><head><title>Connected! — Platinum Cubed MCP</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#0B1829;color:white;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:#132035;border:1px solid #1e3a5f;border-radius:16px;padding:40px;max-width:600px;width:90%;}
  h1{color:#4CAF50;font-size:24px;margin-bottom:8px;}
  p{color:#9ab;margin:8px 0;line-height:1.6;}
  .url-box{background:#0B1829;border:1px solid #2D7DD2;border-radius:8px;padding:16px;margin:20px 0;font-family:monospace;font-size:13px;color:#7BAEDB;word-break:break-all;}
  .steps{background:#0d1f33;border-radius:10px;padding:20px;margin-top:20px;}
  .steps h3{color:#7BAEDB;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;}
  .step{display:flex;gap:12px;margin:10px 0;color:#cdd;font-size:14px;}
  .num{background:#2D7DD2;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;}
  .badge{display:inline-block;background:${tier==='full'?'#7B2FBE':'#1565C0'};color:white;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600;text-transform:uppercase;margin-left:8px;}
  button{background:#2D7DD2;color:white;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;margin-top:8px;}
</style></head><body>
<div class="card">
  <h1>✅ Connected to Salesforce!</h1>
  <p>Your <span class="badge">${tier}</span> MCP server is ready.</p>
  <p>Add this URL to Claude as a custom connector:</p>
  <div class="url-box" id="mcpUrl">${mcpUrl}</div>
  <button onclick="navigator.clipboard.writeText('${mcpUrl}').then(()=>this.textContent='Copied!')">Copy URL</button>
  <div class="steps">
    <h3>Add to Claude</h3>
    <div class="step"><div class="num">1</div><span>Open Claude → Settings → Connectors</span></div>
    <div class="step"><div class="num">2</div><span>Click "Add custom connector"</span></div>
    <div class="step"><div class="num">3</div><span>Paste the URL above and click Add</span></div>
    <div class="step"><div class="num">4</div><span>Enable it via the + button in your conversation</span></div>
  </div>
</div></body></html>`);
  } catch(err) { res.status(500).send('Error: '+(err.message||err)); }
});

// ── MCP endpoints ─────────────────────────────────────────────────────────────
function mcpHandler(tier) {
  return async (req, res) => {
    const sessionId = req.query.session;
    const session   = sessions.get(sessionId);
    if (!session) return res.status(401).json({ error: 'Invalid or expired session. Please reconnect at '+SERVER_URL });
    if (req.method==='GET') {
      res.setHeader('Content-Type','text/event-stream');
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Connection','keep-alive');
      res.flushHeaders();
      const ping=setInterval(()=>res.write(': ping\n\n'),30000);
      req.on('close',()=>clearInterval(ping));
      return;
    }
    if (req.method!=='POST') return res.status(405).send('Method not allowed');
    let body='';
    req.on('data',d=>body+=d);
    req.on('end',async()=>{
      let msg; try{msg=JSON.parse(body);}catch{return res.status(400).json({error:'Invalid JSON'});}
      const {id,method,params}=msg;
      const tools=tier==='full'?TOOLS_FULL:TOOLS_READONLY;
      const send=result=>res.json({jsonrpc:'2.0',id,result});
      const sendErr=(code,message)=>res.json({jsonrpc:'2.0',id,error:{code,message:String(message)}});
      try {
        switch(method) {
          case 'initialize': return send({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:`platinum-cubed-mcp-${tier}`,version:'1.0.0'}});
          case 'initialized': return res.status(204).send();
          case 'tools/list': return send({tools});
          case 'tools/call': {
            try { return send(await handleTool(session,params.name,params.arguments||{})); }
            catch(e){ return send({content:[{type:'text',text:'Error: '+(e.message||e)}],isError:true}); }
          }
          case 'ping': return send({});
          default: if (id!=null) return sendErr(-32601,'Method not found: '+method); return res.status(204).send();
        }
      } catch(err){ return sendErr(-32000,err.message||err); }
    });
  };
}
app.get('/mcp/readonly', mcpHandler('readonly'));
app.post('/mcp/readonly', mcpHandler('readonly'));
app.get('/mcp/full',     mcpHandler('full'));
app.post('/mcp/full',    mcpHandler('full'));

// ── Landing page ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head>
<title>Platinum Cubed MCP — Salesforce for Claude</title>
<meta name="viewport" content="width=device-width,initial-scale=1">

<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0B1829;color:#e0e8f0;min-height:100vh;}
  nav{background:#0d1f33;border-bottom:1px solid #1e3a5f;padding:0 40px;height:60px;display:flex;align-items:center;justify-content:space-between;}
  .logo{font-size:16px;font-weight:600;color:white;}.logo span{color:#4A9EE0;}
  .hero{text-align:center;padding:80px 20px 60px;}
  .hero h1{font-size:42px;font-weight:700;line-height:1.2;margin-bottom:16px;}
  .hero h1 span{color:#4A9EE0;}
  .hero p{font-size:18px;color:#8aabcc;max-width:540px;margin:0 auto 40px;line-height:1.6;}
  .tiers{display:flex;gap:24px;justify-content:center;padding:0 20px 80px;flex-wrap:wrap;max-width:960px;margin:0 auto;}
  .tier{background:#132035;border:1px solid #1e3a5f;border-radius:16px;padding:36px;flex:1;min-width:300px;max-width:420px;}
  .tier.featured{border-color:#7B2FBE;background:#1a1535;}
  .tier-badge{font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:4px 12px;border-radius:99px;display:inline-block;margin-bottom:16px;}
  .badge-ro{background:#1565C0;color:white;}.badge-full{background:#7B2FBE;color:white;}
  .tier h2{font-size:24px;font-weight:700;margin-bottom:8px;}
  .tier p{color:#8aabcc;font-size:14px;margin-bottom:20px;line-height:1.6;}
  .price-toggle{display:flex;gap:8px;margin-bottom:20px;}
  .ptab{padding:8px 16px;border-radius:8px;border:1px solid #2a4a6e;background:transparent;color:#8aabcc;cursor:pointer;font-size:13px;transition:all 0.2s;}
  .ptab.active{background:#2D7DD2;color:white;border-color:#2D7DD2;}
  .price-display{font-size:32px;font-weight:700;color:white;margin-bottom:4px;}
  .price-sub{font-size:13px;color:#556;margin-bottom:20px;}
  .features{list-style:none;margin-bottom:28px;}
  .features li{padding:6px 0;font-size:14px;color:#cdd;display:flex;gap:10px;}
  .features li::before{content:'✓';color:#4CAF50;font-weight:700;flex-shrink:0;}
  .url-input{width:100%;background:#0B1829;border:1px solid #2a4a6e;border-radius:8px;padding:12px 14px;color:white;font-size:14px;outline:none;margin-bottom:12px;}
  .url-input:focus{border-color:#4A9EE0;}
  .url-input::placeholder{color:#445;}
  .btn{width:100%;padding:14px;border-radius:10px;border:none;font-size:15px;font-weight:600;cursor:pointer;text-align:center;}
  .btn-blue{background:#2D7DD2;color:white;}.btn-purple{background:#7B2FBE;color:white;}
  .btn:hover{opacity:0.88;}
  footer{text-align:center;padding:40px;color:#445;font-size:13px;border-top:1px solid #1a2e45;}
  footer a{color:#4A9EE0;text-decoration:none;}
  .save-badge{background:#1a4a1a;color:#4CAF50;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;margin-left:8px;}
</style></head><body>
<nav>
  <div class="logo">Platinum <span>Cubed</span> MCP</div>
  <a href="/manage" style="font-size:13px;color:#4A9EE0;text-decoration:none;">Manage subscription</a>
</nav>
<div class="hero">
  <h1>Connect <span>Salesforce</span> to Claude</h1>
  <p>Give Claude secure access to your Salesforce org. Ask questions, create records, deploy Apex — all from your Claude conversation.</p>
</div>
<div class="tiers">

  <div class="tier">
    <div class="tier-badge badge-ro">Read Only</div>
    <h2>Explore & Analyze</h2>
    <p>Safe, read-only access. Perfect for reporting, data analysis, and answering questions about your org.</p>
    <div class="price-toggle">
      <button class="ptab active" onclick="setPrice('ro','monthly',this)">Monthly</button>
      <button class="ptab" onclick="setPrice('ro','annual',this)">Annual <span class="save-badge">Save 8%</span></button>
    </div>
    <div class="price-display" id="ro-price">$20</div>
    <div class="price-sub" id="ro-sub">per month</div>
    <ul class="features">
      <li>Query any Salesforce object (SOQL)</li>
      <li>Search across your org (SOSL)</li>
      <li>Explore object schemas & fields</li>
      <li>Fetch specific records by ID</li>
      <li>No changes to your data</li>
    </ul>
    <input class="url-input" id="ro-url" type="text" placeholder="https://yourorg.my.salesforce.com" />
    <input class="url-input" id="ro-email" type="email" placeholder="your@email.com" />
    <button class="btn btn-blue" id="btn-readonly" onclick="doCheckout('readonly')">Get Started →</button>
  </div>

  <div class="tier featured">
    <div class="tier-badge badge-full">Full Access</div>
    <h2>Build & Automate</h2>
    <p>Complete access for admins and developers. Read, write, deploy Apex classes, and manage flows.</p>
    <div class="price-toggle">
      <button class="ptab active" onclick="setPrice('full','monthly',this)">Monthly</button>
      <button class="ptab" onclick="setPrice('full','annual',this)">Annual <span class="save-badge">Save 8%</span></button>
    </div>
    <div class="price-display" id="full-price">$40</div>
    <div class="price-sub" id="full-sub">per month</div>
    <ul class="features">
      <li>Everything in Read Only</li>
      <li>Create, update & delete records</li>
      <li>Deploy & manage Apex classes</li>
      <li>Build & activate Flows</li>
      <li>Execute anonymous Apex</li>
      <li>Run Apex tests</li>
    </ul>
    <input class="url-input" id="full-url" type="text" placeholder="https://yourorg.my.salesforce.com" />
    <input class="url-input" id="full-email" type="email" placeholder="your@email.com" />
    <button class="btn btn-purple" id="btn-full" onclick="doCheckout('full')">Get Started →</button>
  </div>

</div>
<footer>Built by <a href="https://platinumcubed.com" target="_blank">Platinum Cubed</a> · Salesforce consulting & AI innovation</footer>
<script src="/app.js"></script>
const pricing = {
  ro:   { monthly: { price: '$20', sub: 'per month', billing: 'monthly' }, annual: { price: '$220', sub: 'per year ($18.33/mo)', billing: 'annual' } },
  full: { monthly: { price: '$40', sub: 'per month', billing: 'monthly' }, annual: { price: '$440', sub: 'per year ($36.67/mo)', billing: 'annual' } }
};
const selected = { ro: 'monthly', full: 'monthly' };

function setPrice(tier, billing, btn) {
  selected[tier] = billing;
  const p = pricing[tier][billing];
  document.getElementById(tier+'-price').textContent = p.price;
  document.getElementById(tier+'-sub').textContent = p.sub;
  btn.closest('.price-toggle').querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function doCheckout(tier) {
  const urlId   = tier === 'full' ? 'full-url'   : 'ro-url';
  const emailId = tier === 'full' ? 'full-email' : 'ro-email';
  const btnId   = 'btn-' + tier;

  const urlEl   = document.getElementById(urlId);
  const emailEl = document.getElementById(emailId);
  const btn     = document.getElementById(btnId);

  if (!urlEl || !emailEl) { alert('Form fields not found. Please refresh the page.'); return; }

  const instanceUrl = urlEl.value.trim() || 'https://login.salesforce.com';
  const email = emailEl.value.trim();

  if (!email) { alert('Please enter your email address.'); return; }

  const billing = selected[tier === 'full' ? 'full' : 'ro'];
  btn.textContent = 'Checking...';
  btn.disabled = true;

  try {
    const res = await fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, billing, instance_url: instanceUrl, email })
    });
    const data = await res.json();
    if (data.tier_mismatch) {
      alert(data.message + '\n\nClick OK to manage your subscription.');
      window.location.href = '/manage';
    } else if (data.already_subscribed) {
      window.location.href = '/oauth/start?tier=' + data.tier + '&instance_url=' + encodeURIComponent(data.instance_url || 'https://login.salesforce.com') + '&email=' + encodeURIComponent(email);
    } else if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
      btn.textContent = 'Get started →';
      btn.disabled = false;
    }
  } catch(err) {
    alert('Error: ' + err.message);
    btn.textContent = 'Get started →';
    btn.disabled = false;
  }
}
</body></html>`);
});

// ── Manage subscription page ─────────────────────────────────────────────────
app.get('/manage', (req, res) => {
  const error = req.query.error || '';
  res.send(`<!DOCTYPE html><html><head><title>Manage Subscription — Platinum Cubed MCP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0B1829;color:#e0e8f0;min-height:100vh;display:flex;flex-direction:column;}
  nav{background:#0d1f33;border-bottom:1px solid #1e3a5f;padding:0 40px;height:60px;display:flex;align-items:center;justify-content:space-between;}
  .logo{font-size:16px;font-weight:600;color:white;}.logo span{color:#4A9EE0;}
  .nav-link{font-size:13px;color:#4A9EE0;text-decoration:none;}
  .center{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 20px;}
  .card{background:#132035;border:1px solid #1e3a5f;border-radius:16px;padding:40px;max-width:460px;width:100%;text-align:center;}
  h1{font-size:22px;font-weight:600;margin-bottom:8px;}
  .sub{color:#8aabcc;font-size:14px;margin-bottom:28px;line-height:1.6;}
  input{width:100%;background:#0B1829;border:1px solid #2a4a6e;border-radius:8px;padding:12px 14px;color:white;font-size:14px;outline:none;margin-bottom:12px;}
  input:focus{border-color:#4A9EE0;}
  input::placeholder{color:#445;}
  .btn{width:100%;padding:13px;border-radius:10px;border:none;background:#2D7DD2;color:white;font-size:15px;font-weight:600;cursor:pointer;}
  .btn:hover{opacity:0.88;}
  .error{color:#E24B4A;font-size:13px;margin-bottom:16px;}
  .footer-note{color:#445;font-size:12px;margin-top:20px;line-height:1.6;}
</style></head><body>
<nav>
  <div class="logo">Platinum <span>Cubed</span> MCP</div>
  <a class="nav-link" href="/">← Back to pricing</a>
</nav>
<div class="center">
  <div class="card">
    <h1>Manage subscription</h1>
    <p class="sub">Enter the email address you used to subscribe. We'll redirect you to the Stripe portal where you can cancel, update your payment method, or view invoices.</p>
    ${error ? `<p class="error">${error}</p>` : ''}
    <form action="/manage/lookup" method="POST">
      <input type="email" name="email" placeholder="your@email.com" required autofocus />
      <button class="btn" type="submit">Access my subscription →</button>
    </form>
    <p class="footer-note">You'll be redirected to Stripe's secure portal. Your payment info is never stored on our servers.</p>
  </div>
</div>
</body></html>`);
});

app.post('/manage/lookup', async (req, res) => {
  const email = req.body && req.body.email;
  if (!email || !stripe) return res.redirect('/manage?error=Please+enter+your+email');
  try {
    const customers = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 1 });
    if (!customers.data || customers.data.length === 0) {
      return res.redirect('/manage?error=No+subscription+found+for+that+email+address');
    }
    const customer = customers.data[0];
    const portalConfig = process.env.STRIPE_PORTAL_CONFIG || undefined;
    const session = await stripe.billingPortal.sessions.create({
      customer:   customer.id,
      return_url: SERVER_URL + '/manage',
      ...(portalConfig ? { configuration: portalConfig } : {})
    });
    res.redirect(session.url);
  } catch(err) {
    res.redirect('/manage?error=' + encodeURIComponent(err.message || 'Something went wrong'));
  }
});

// ── Stripe customer portal (direct, from success page) ────────────────────────
app.get('/portal', async (req, res) => {
  const { customer_id } = req.query;
  if (!stripe || !customer_id) return res.redirect('/manage');
  try {
    const portalConfig = process.env.STRIPE_PORTAL_CONFIG || undefined;
    const session = await stripe.billingPortal.sessions.create({
      customer:   customer_id,
      return_url: SERVER_URL,
      ...(portalConfig ? { configuration: portalConfig } : {})
    });
    res.redirect(session.url);
  } catch(err) {
    res.redirect('/manage?error=' + encodeURIComponent(err.message || 'Something went wrong'));
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size, paidUsers: paidUsers.size }));

app.listen(PORT, () => console.log(`Platinum Cubed MCP running on port ${PORT}`));

// ── Frontend JS ───────────────────────────────────────────────────────────────
app.get('/app.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
const pricing = {
  ro:   { monthly: { price: '$20', sub: 'per month', billing: 'monthly' }, annual: { price: '$220', sub: 'per year ($18.33/mo)', billing: 'annual' } },
  full: { monthly: { price: '$40', sub: 'per month', billing: 'monthly' }, annual: { price: '$440', sub: 'per year ($36.67/mo)', billing: 'annual' } }
};
const selected = { ro: 'monthly', full: 'monthly' };

function setPrice(tier, billing, btn) {
  selected[tier] = billing;
  const p = pricing[tier][billing];
  document.getElementById(tier+'-price').textContent = p.price;
  document.getElementById(tier+'-sub').textContent = p.sub;
  btn.closest('.price-toggle').querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

async function doCheckout(tier) {
  const urlId   = tier === 'full' ? 'full-url'   : 'ro-url';
  const emailId = tier === 'full' ? 'full-email' : 'ro-email';
  const btnId   = 'btn-' + tier;
  const urlEl   = document.getElementById(urlId);
  const emailEl = document.getElementById(emailId);
  const btn     = document.getElementById(btnId);
  if (!urlEl || !emailEl) { alert('Form fields not found. Please refresh the page.'); return; }
  const instanceUrl = urlEl.value.trim() || 'https://login.salesforce.com';
  const email = emailEl.value.trim();
  if (!email) { alert('Please enter your email address.'); return; }
  const billing = selected[tier === 'full' ? 'full' : 'ro'];
  btn.textContent = 'Checking...';
  btn.disabled = true;
  try {
    const res = await fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, billing, instance_url: instanceUrl, email })
    });
    const data = await res.json();
    if (data.tier_mismatch) {
      alert(data.message + '\n\nClick OK to manage your subscription.');
      window.location.href = '/manage';
    } else if (data.already_subscribed) {
      window.location.href = '/oauth/start?tier=' + data.tier + '&instance_url=' + encodeURIComponent(data.instance_url || 'https://login.salesforce.com') + '&email=' + encodeURIComponent(email);
    } else if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Error: ' + (data.error || 'Unknown error'));
      btn.textContent = 'Get started →';
      btn.disabled = false;
    }
  } catch(err) {
    alert('Error: ' + err.message);
    btn.textContent = 'Get started →';
    btn.disabled = false;
  }
}
  `);
});
