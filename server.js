#!/usr/bin/env node
/**
 * Platinum Cubed MCP Server
 * Hosted on Railway — serves two MCP endpoints:
 *   /mcp/readonly   — read-only Salesforce access
 *   /mcp/full       — full read/write/apex/flow access
 *
 * OAuth flow:
 *   /oauth/start?tier=readonly|full&instance_url=...
 *   /oauth/callback
 */

const express  = require('express');
const https    = require('https');
const http     = require('http');
const urlLib   = require('url');
const zlib     = require('zlib');
const crypto   = require('crypto');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
// Your Platinum Cubed Connected App credentials (set as Railway env vars)
const PC_CLIENT_ID     = process.env.PC_CLIENT_ID     || '';
const PC_CLIENT_SECRET = process.env.PC_CLIENT_SECRET || '';
const SERVER_URL       = process.env.SERVER_URL        || `http://localhost:${PORT}`;
const CALLBACK_URL     = `${SERVER_URL}/oauth/callback`;
const API_VERSION      = 'v62.0';
const API_VER_NUM      = '62.0';

// In-memory session store (token keyed by session id)
const sessions = new Map(); // sessionId -> { accessToken, instanceUrl, tier }

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

// ── Salesforce helpers ────────────────────────────────────────────────────────
async function sfRequest(session, method, urlPath, body, contentType) {
  const ct = contentType || 'application/json';
  const headers = { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': ct };
  if (ct === 'application/json' && body && typeof body === 'object') body = JSON.stringify(body);
  const res = await request({ url: session.instanceUrl + urlPath, method, headers }, body || undefined);
  return res;
}

function sfErr(res) {
  const b = res.body;
  if (Array.isArray(b) && b[0]) return b[0].message || JSON.stringify(b[0]);
  if (b && b.message) return b.message;
  if (b && b.error) return b.error + ': ' + (b.error_description || '');
  return typeof b === 'string' ? b.slice(0, 300) : JSON.stringify(b).slice(0, 300);
}

async function sfQuery(session, soql) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function sfSearch(session, sosl) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/search?q=${encodeURIComponent(sosl)}`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function sfDescribe(session, objectName) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/sobjects/${objectName}/describe`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function sfListObjects(session) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/sobjects`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function sfGetRecord(session, objectName, recordId, fields) {
  let p = `/services/data/${API_VERSION}/sobjects/${objectName}/${recordId}`;
  if (fields && fields.length) p += '?fields=' + fields.join(',');
  const res = await sfRequest(session, 'GET', p);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function sfCreateRecord(session, objectName, fields) {
  const res = await sfRequest(session, 'POST', `/services/data/${API_VERSION}/sobjects/${objectName}`, fields);
  if (res.status !== 201) throw new Error(sfErr(res));
  return res.body;
}
async function sfUpdateRecord(session, objectName, recordId, fields) {
  const res = await sfRequest(session, 'PATCH', `/services/data/${API_VERSION}/sobjects/${objectName}/${recordId}`, fields);
  if (res.status !== 204 && res.status !== 200) throw new Error(sfErr(res));
  return { success: true, id: recordId };
}
async function sfUpsertRecord(session, objectName, externalIdField, externalIdValue, fields) {
  const res = await sfRequest(session, 'PATCH', `/services/data/${API_VERSION}/sobjects/${objectName}/${externalIdField}/${encodeURIComponent(externalIdValue)}`, fields);
  if (![200, 201, 204].includes(res.status)) throw new Error(sfErr(res));
  return { success: true, created: res.status === 201 };
}
async function sfDeleteRecord(session, objectName, recordId) {
  const res = await sfRequest(session, 'DELETE', `/services/data/${API_VERSION}/sobjects/${objectName}/${recordId}`);
  if (res.status !== 204) throw new Error(sfErr(res));
  return { success: true, id: recordId };
}
async function toolingQuery(session, soql) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}
async function toolingCreate(session, type, body) {
  const res = await sfRequest(session, 'POST', `/services/data/${API_VERSION}/tooling/sobjects/${type}`, body);
  if (res.status !== 201) throw new Error(sfErr(res));
  return res.body;
}
async function toolingUpdate(session, type, id, body) {
  const res = await sfRequest(session, 'PATCH', `/services/data/${API_VERSION}/tooling/sobjects/${type}/${id}`, body);
  if (res.status !== 204 && res.status !== 200) throw new Error(sfErr(res));
  return { success: true, id };
}
async function toolingGet(session, type, id) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/tooling/sobjects/${type}/${id}`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}

async function executeAnonymous(session, apexCode) {
  const res = await sfRequest(session, 'GET', `/services/data/${API_VERSION}/tooling/executeAnonymous?anonymousBody=${encodeURIComponent(apexCode)}`);
  if (res.status !== 200) throw new Error(sfErr(res));
  return res.body;
}

async function runTests(session, classNames) {
  const payload = { tests: classNames.map(n => ({ className: n })) };
  const res = await sfRequest(session, 'POST', `/services/data/${API_VERSION}/tooling/runTestsAsynchronous`, payload);
  if (res.status !== 200 && res.status !== 201) throw new Error(sfErr(res));
  const testRunId = typeof res.body === 'string' ? res.body.replace(/"/g, '') : res.body;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await toolingQuery(session, `SELECT Id, Status, TestTime, ClassesCompleted, MethodsCompleted, MethodsFailed FROM ApexTestRunResult WHERE AsyncApexJobId = '${testRunId}'`);
    const run = statusRes.records && statusRes.records[0];
    if (!run) continue;
    if (run.Status === 'Completed' || run.Status === 'Failed') {
      const resultRes = await toolingQuery(session, `SELECT MethodName, Outcome, Message, StackTrace, ApexClass.Name FROM ApexTestResult WHERE AsyncApexJobId = '${testRunId}' ORDER BY ApexClass.Name, MethodName`);
      return { summary: { status: run.Status, testTime: run.TestTime, completed: run.MethodsCompleted, failed: run.MethodsFailed }, results: (resultRes.records || []).map(r => ({ class: r.ApexClass && r.ApexClass.Name, method: r.MethodName, outcome: r.Outcome, message: r.Message })) };
    }
  }
  throw new Error('Test run timed out.');
}

async function saveApexClass(session, name, body, existingId) {
  const containerRes = await toolingCreate(session, 'MetadataContainer', { Name: 'PC_' + Date.now() });
  const containerId = containerRes.id;
  try {
    if (existingId) {
      await toolingCreate(session, 'ApexClassMember', { MetadataContainerId: containerId, ContentEntityId: existingId, Body: body });
    } else {
      await toolingCreate(session, 'ApexClassMember', { MetadataContainerId: containerId, FullName: name, Body: body });
    }
    const deployRes = await toolingCreate(session, 'ContainerAsyncRequest', { MetadataContainerId: containerId, IsCheckOnly: false, IsRunTests: false });
    const requestId = deployRes.id;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const statusRes = await toolingGet(session, 'ContainerAsyncRequest', requestId);
      if (statusRes.State === 'Completed') return { success: true, state: statusRes.State, name };
      if (statusRes.State === 'Failed' || statusRes.State === 'Aborted') {
        const errs = statusRes.CompilerErrors || statusRes.ErrorMsg || statusRes.State;
        let msg = errs;
        try { msg = JSON.parse(errs).map(e => `Line ${e.line}: ${e.problem}`).join('\n'); } catch {}
        throw new Error('Apex compile failed:\n' + msg);
      }
    }
    throw new Error('Apex deploy timed out.');
  } finally {
    try { await sfRequest(session, 'DELETE', `/services/data/${API_VERSION}/tooling/sobjects/MetadataContainer/${containerId}`); } catch {}
  }
}

// ── Metadata API helper (SOAP deploy) ────────────────────────────────────────
async function sfDeployMetadata(session, files) {
  // Build zip in-memory (stored/uncompressed, pure Node.js)
  function crc32(buf) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[i]=c; }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = t[(crc^buf[i])&0xFF]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
  }
  const u32 = n => { const b=Buffer.alloc(4); b.writeUInt32LE(n,0); return b; };
  const u16 = n => { const b=Buffer.alloc(2); b.writeUInt16LE(n,0); return b; };

  const locals = [], centrals = [];
  let off = 0;
  for (const file of files) {
    const name = Buffer.from(file.path,'utf8');
    const data = Buffer.from(file.content,'utf8');
    const crc  = crc32(data);
    const lh = Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);
    locals.push(lh);
    centrals.push(Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(off),name]));
    off += lh.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(cd.length),u32(off),u16(0)]);
  const zipB64 = Buffer.concat([...locals,cd,eocd]).toString('base64');

  // SOAP deploy via Metadata API
  const metadataUrl = session.instanceUrl + '/services/Soap/m/' + API_VER_NUM;
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:CallOptions><met:client>PlatinumCubedMCP</met:client></met:CallOptions>
    <met:SessionHeader><met:sessionId>${session.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:deploy>
      <met:ZipFile>${zipB64}</met:ZipFile>
      <met:DeployOptions>
        <met:allowMissingFiles>false</met:allowMissingFiles>
        <met:autoUpdatePackage>false</met:autoUpdatePackage>
        <met:checkOnly>false</met:checkOnly>
        <met:ignoreWarnings>true</met:ignoreWarnings>
        <met:purgeOnDelete>false</met:purgeOnDelete>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
        <met:testLevel>RunSpecifiedTests</met:testLevel>
      </met:DeployOptions>
    </met:deploy>
  </soapenv:Body>
</soapenv:Envelope>`;

  const deployRes = await request({
    url: metadataUrl, method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' }
  }, soapBody);

  // Extract async job ID from SOAP response
  const jobMatch = deployRes.raw.match(/<id>([^<]+)<\/id>/);
  if (!jobMatch) throw new Error('Deploy SOAP call failed: ' + deployRes.raw.slice(0,500));
  const jobId = jobMatch[1];

  // Poll checkDeployStatus
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollBody = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <soapenv:Header>
    <met:SessionHeader><met:sessionId>${session.accessToken}</met:sessionId></met:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <met:checkDeployStatus>
      <met:asyncProcessId>${jobId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>
  </soapenv:Body>
</soapenv:Envelope>`;
    const pollRes = await request({ url: metadataUrl, method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' } }, pollBody);
    const doneMatch    = pollRes.raw.match(/<done>([^<]+)<\/done>/);
    const successMatch = pollRes.raw.match(/<success>([^<]+)<\/success>/);
    const statusMatch  = pollRes.raw.match(/<status>([^<]+)<\/status>/);
    if (doneMatch && doneMatch[1] === 'true') {
      if (successMatch && successMatch[1] === 'true') {
        const deployed = (pollRes.raw.match(/<numberComponentsDeployed>([^<]+)<\/numberComponentsDeployed>/) || [])[1] || '?';
        return { success: true, status: statusMatch && statusMatch[1], numberComponentsDeployed: deployed };
      }
      // Extract errors
      const errMsgs = [...pollRes.raw.matchAll(/<problem>([^<]+)<\/problem>/g)].map(m=>m[1]);
      throw new Error('Deployment failed:\n' + (errMsgs.join('\n') || pollRes.raw.slice(0,800)));
    }
  }
  throw new Error('Metadata deploy timed out.');
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS_READONLY = [
  { name: 'sf_query',        description: 'Run a SOQL SELECT query.',
    inputSchema: { type:'object', properties:{ soql:{ type:'string', description:'SOQL SELECT statement' } }, required:['soql'] } },
  { name: 'sf_search',       description: 'Run a SOSL search across objects.',
    inputSchema: { type:'object', properties:{ sosl:{ type:'string', description:'SOSL query string' } }, required:['sosl'] } },
  { name: 'sf_describe',     description: 'Get the schema of a Salesforce object.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string', description:'API name, e.g. Account' } }, required:['object_name'] } },
  { name: 'sf_list_objects', description: 'List all queryable sObjects in the org.',
    inputSchema: { type:'object', properties:{} } },
  { name: 'sf_get_record',   description: 'Fetch a single record by Id.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string' }, record_id:{ type:'string' }, fields:{ type:'array', items:{ type:'string' } } }, required:['object_name','record_id'] } }
];

const TOOLS_FULL = [
  ...TOOLS_READONLY,
  { name: 'sf_create_record', description: 'Create a new record.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string' }, fields:{ type:'object' } }, required:['object_name','fields'] } },
  { name: 'sf_update_record', description: 'Update an existing record.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string' }, record_id:{ type:'string' }, fields:{ type:'object' } }, required:['object_name','record_id','fields'] } },
  { name: 'sf_upsert_record', description: 'Upsert using an external Id field.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string' }, external_id_field:{ type:'string' }, external_id_value:{ type:'string' }, fields:{ type:'object' } }, required:['object_name','external_id_field','external_id_value','fields'] } },
  { name: 'sf_delete_record', description: 'Delete a record by Id.',
    inputSchema: { type:'object', properties:{ object_name:{ type:'string' }, record_id:{ type:'string' } }, required:['object_name','record_id'] } },
  { name: 'sf_list_apex_classes', description: 'List all Apex classes in the org.',
    inputSchema: { type:'object', properties:{ name_filter:{ type:'string' } } } },
  { name: 'sf_get_apex_class', description: 'Read the full body of an Apex class.',
    inputSchema: { type:'object', properties:{ class_name:{ type:'string' } }, required:['class_name'] } },
  { name: 'sf_save_apex_class', description: 'Create or update an Apex class.',
    inputSchema: { type:'object', properties:{ class_name:{ type:'string' }, body:{ type:'string' } }, required:['class_name','body'] } },
  { name: 'sf_execute_anonymous', description: 'Execute anonymous Apex code.',
    inputSchema: { type:'object', properties:{ apex_code:{ type:'string' } }, required:['apex_code'] } },
  { name: 'sf_run_tests', description: 'Run Apex test classes.',
    inputSchema: { type:'object', properties:{ class_names:{ type:'array', items:{ type:'string' } } }, required:['class_names'] } },
  { name: 'sf_list_flows', description: 'List all flows.',
    inputSchema: { type:'object', properties:{ name_filter:{ type:'string' } } } },
  { name: 'sf_get_flow', description: 'Read a flow definition.',
    inputSchema: { type:'object', properties:{ flow_api_name:{ type:'string' } }, required:['flow_api_name'] } },
  { name: 'sf_deploy_flow', description: 'Deploy a flow via Metadata API.',
    inputSchema: { type:'object', properties:{ flow_api_name:{ type:'string' }, flow_xml:{ type:'string' } }, required:['flow_api_name','flow_xml'] } },
  { name: 'sf_activate_flow', description: 'Activate a flow version.',
    inputSchema: { type:'object', properties:{ flow_api_name:{ type:'string' } }, required:['flow_api_name'] } },
  { name: 'sf_deploy_metadata', description: 'Deploy Salesforce metadata (custom objects, fields, etc.) via the Metadata API. Pass an array of files each with a path and XML content.',
    inputSchema: { type:'object', properties:{
      files: { type:'array', description: 'Array of metadata files to deploy', items: {
        type:'object', properties:{ path:{ type:'string', description:'Metadata file path e.g. objects/Foo__c/Foo__c.object-meta.xml' }, content:{ type:'string', description:'XML content of the file' } }, required:['path','content']
      }},
      package_xml: { type:'string', description:'Optional package.xml content. If omitted a default is generated.' }
    }, required:['files'] } }
];

// ── Tool handler ──────────────────────────────────────────────────────────────
async function handleTool(session, name, args) {
  const text = v => ({ content: [{ type:'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

  switch (name) {
    case 'sf_query': {
      const r = await sfQuery(session, args.soql);
      return text({ totalSize: r.totalSize, done: r.done, records: r.records });
    }
    case 'sf_search':       return text(await sfSearch(session, args.sosl));
    case 'sf_describe': {
      const r = await sfDescribe(session, args.object_name);
      return text({ name: r.name, label: r.label, fields: r.fields.map(f => ({ name: f.name, label: f.label, type: f.type, length: f.length, nillable: f.nillable, referenceTo: f.referenceTo })) });
    }
    case 'sf_list_objects': {
      const r = await sfListObjects(session);
      return text(r.sobjects.filter(o => o.queryable).map(o => ({ name: o.name, label: o.label, custom: o.custom })).sort((a,b) => a.name.localeCompare(b.name)));
    }
    case 'sf_get_record':    return text(await sfGetRecord(session, args.object_name, args.record_id, args.fields));
    case 'sf_create_record': return text(await sfCreateRecord(session, args.object_name, args.fields));
    case 'sf_update_record': return text(await sfUpdateRecord(session, args.object_name, args.record_id, args.fields));
    case 'sf_upsert_record': return text(await sfUpsertRecord(session, args.object_name, args.external_id_field, args.external_id_value, args.fields));
    case 'sf_delete_record': return text(await sfDeleteRecord(session, args.object_name, args.record_id));
    case 'sf_list_apex_classes': {
      let soql = `SELECT Id, Name, Status, LastModifiedDate FROM ApexClass WHERE ManageableState = 'unmanaged'`;
      if (args.name_filter) soql += ` AND Name LIKE '%${args.name_filter.replace(/'/g,"\\'")}%'`;
      soql += ' ORDER BY Name';
      return text((await toolingQuery(session, soql)).records);
    }
    case 'sf_get_apex_class': {
      const r = await toolingQuery(session, `SELECT Id, Name, Body, Status, LastModifiedDate FROM ApexClass WHERE Name = '${args.class_name.replace(/'/g,"\\'")}' AND ManageableState = 'unmanaged'`);
      if (!r.records || r.records.length === 0) throw new Error(`Apex class "${args.class_name}" not found.`);
      return text(r.records[0]);
    }
    case 'sf_save_apex_class': {
      const existing = await toolingQuery(session, `SELECT Id FROM ApexClass WHERE Name = '${args.class_name.replace(/'/g,"\\'")}' AND ManageableState = 'unmanaged'`);
      const existingId = existing.records && existing.records[0] ? existing.records[0].Id : null;
      return text({ ...await saveApexClass(session, args.class_name, args.body, existingId), action: existingId ? 'updated' : 'created' });
    }
    case 'sf_execute_anonymous': {
      const r = await executeAnonymous(session, args.apex_code);
      if (!r.compiled) throw new Error(`Compile error (line ${r.line}): ${r.compileProblem}`);
      return text({ success: r.success, compiled: r.compiled, exceptionMessage: r.exceptionMessage, exceptionStackTrace: r.exceptionStackTrace });
    }
    case 'sf_run_tests': return text(await runTests(session, args.class_names));
    case 'sf_list_flows': {
      let soql = `SELECT Id, ApiName, Label, ProcessType, Status, VersionNumber, LastModifiedDate FROM FlowDefinition`;
      if (args.name_filter) soql += ` WHERE ApiName LIKE '%${args.name_filter.replace(/'/g,"\\'")}%'`;
      soql += ' ORDER BY ApiName';
      return text((await toolingQuery(session, soql)).records);
    }
    case 'sf_get_flow': {
      const defRes = await toolingQuery(session, `SELECT Id, ApiName, ActiveVersionId, LatestVersionId FROM FlowDefinition WHERE ApiName = '${args.flow_api_name.replace(/'/g,"\\'")}' LIMIT 1`);
      if (!defRes.records || !defRes.records[0]) throw new Error(`Flow "${args.flow_api_name}" not found.`);
      const def = defRes.records[0];
      const verId = def.ActiveVersionId || def.LatestVersionId;
      return text(await toolingGet(session, 'Flow', verId));
    }
    case 'sf_activate_flow': {
      const defRes = await toolingQuery(session, `SELECT Id, LatestVersionId FROM FlowDefinition WHERE ApiName = '${args.flow_api_name.replace(/'/g,"\\'")}' LIMIT 1`);
      if (!defRes.records || !defRes.records[0]) throw new Error(`Flow "${args.flow_api_name}" not found.`);
      const def = defRes.records[0];
      await toolingUpdate(session, 'FlowDefinition', def.Id, { ActiveVersionId: def.LatestVersionId });
      return text({ success: true, flow: args.flow_api_name, activatedVersionId: def.LatestVersionId });
    }
    case 'sf_deploy_metadata': {
      const files = args.files || [];
      const pkgXml = args.package_xml || (() => {
        const types = {};
        for (const f of files) {
          const parts = f.path.split('/');
          if (parts[0] === 'objects' && parts.length === 2) { types['CustomObject'] = types['CustomObject'] || []; types['CustomObject'].push(parts[1].replace('.object-meta.xml','').replace('.object','')); }
          else if (parts[0] === 'objects' && parts[2] === 'fields') { types['CustomField'] = types['CustomField'] || []; types['CustomField'].push(parts[1] + '.' + parts[3].replace('.field-meta.xml','')); }
          else if (parts[0] === 'objects' && parts.length === 3) { types['CustomObject'] = types['CustomObject'] || []; types['CustomObject'].push(parts[1]); }
        }
        const typeLines = [];
        for (const [t, members] of Object.entries(types)) {
          typeLines.push('  <types>');
          for (const m of members) typeLines.push('    <members>' + m + '</members>');
          typeLines.push('    <name>' + t + '</name>');
          typeLines.push('  </types>');
        }
        return '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' + typeLines.join('\n') + '\n  <version>' + API_VER_NUM + '</version>\n</Package>';
      })();
      const allFiles = files.some(f => f.path === 'package.xml') ? files : [...files, { path: 'package.xml', content: pkgXml }];
      return text(await sfDeployMetadata(session, allFiles));
    }
            default: throw new Error('Unknown tool: ' + name);
  }
}

// ── OAuth routes ──────────────────────────────────────────────────────────────

// PKCE helpers
function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateCodeVerifier() {
  return base64urlEncode(crypto.randomBytes(32));
}
function generateCodeChallenge(verifier) {
  return base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
}

// In-memory store for PKCE verifiers keyed by state
const pkceStore = new Map();

// Step 1: redirect to Salesforce login
app.get('/oauth/start', (req, res) => {
  const tier        = req.query.tier || 'readonly';
  const instanceUrl = req.query.instance_url || 'https://login.salesforce.com';
  const stateToken  = crypto.randomBytes(16).toString('hex');
  const state       = stateToken + '|' + tier + '|' + encodeURIComponent(instanceUrl);
  const scope       = tier === 'full' ? 'full refresh_token' : 'api refresh_token';

  // Generate PKCE
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  pkceStore.set(stateToken, codeVerifier);
  // Clean up old entries
  if (pkceStore.size > 200) pkceStore.delete([...pkceStore.keys()][0]);

  const authUrl = `${instanceUrl}/services/oauth2/authorize?` + new URLSearchParams({
    response_type:          'code',
    client_id:              PC_CLIENT_ID,
    redirect_uri:           CALLBACK_URL,
    scope,
    state,
    code_challenge:         codeChallenge,
    code_challenge_method:  'S256'
  });
  res.redirect(authUrl);
});

// Step 2: handle callback, exchange code for token
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`OAuth error: ${error} — ${error_description}`);
  if (!code || !state) return res.status(400).send('Missing code or state');

  const [stateToken, tier, encodedInstanceUrl] = state.split('|');
  const instanceUrl  = decodeURIComponent(encodedInstanceUrl);
  const codeVerifier = pkceStore.get(stateToken);
  pkceStore.delete(stateToken);

  try {
    const tokenParams = {
      grant_type:    'authorization_code',
      code,
      client_id:     PC_CLIENT_ID,
      client_secret: PC_CLIENT_SECRET,
      redirect_uri:  CALLBACK_URL
    };
    if (codeVerifier) tokenParams.code_verifier = codeVerifier;

    const tokenRes = await request({
      url: `${instanceUrl}/services/oauth2/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, new URLSearchParams(tokenParams).toString());

    if (tokenRes.status !== 200 || !tokenRes.body.access_token) {
      return res.status(400).send('Token exchange failed: ' + JSON.stringify(tokenRes.body));
    }

    const sessionId = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionId, {
      accessToken:  tokenRes.body.access_token,
      refreshToken: tokenRes.body.refresh_token,
      instanceUrl:  tokenRes.body.instance_url || instanceUrl,
      tier
    });

    // Clean up old sessions (keep last 100)
    if (sessions.size > 100) {
      const oldest = [...sessions.keys()][0];
      sessions.delete(oldest);
    }

    const mcpUrl = `${SERVER_URL}/mcp/${tier}?session=${sessionId}`;

    res.send(`<!DOCTYPE html><html><head><title>Connected! — Platinum Cubed MCP</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0B1829; color: white; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #132035; border: 1px solid #1e3a5f; border-radius: 16px; padding: 40px; max-width: 600px; width: 90%; }
  h1 { color: #4CAF50; font-size: 24px; margin-bottom: 8px; }
  p { color: #9ab; margin: 8px 0; line-height: 1.6; }
  .url-box { background: #0B1829; border: 1px solid #2D7DD2; border-radius: 8px; padding: 16px; margin: 20px 0; font-family: monospace; font-size: 13px; color: #7BAEDB; word-break: break-all; }
  .steps { background: #0d1f33; border-radius: 10px; padding: 20px; margin-top: 20px; }
  .steps h3 { color: #7BAEDB; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
  .step { display: flex; gap: 12px; margin: 10px 0; color: #cdd; font-size: 14px; }
  .num { background: #2D7DD2; color: white; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
  .badge { display: inline-block; background: ${tier === 'full' ? '#7B2FBE' : '#1565C0'}; color: white; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-left: 8px; }
  button { background: #2D7DD2; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; margin-top: 8px; }
  button:hover { background: #1a6abf; }
</style></head><body>
<div class="card">
  <h1>✅ Connected to Salesforce!</h1>
  <p>Your <span class="badge">${tier}</span> MCP server is ready.</p>
  <p>Add this URL to Claude as a custom connector:</p>
  <div class="url-box" id="mcpUrl">${mcpUrl}</div>
  <button onclick="navigator.clipboard.writeText('${mcpUrl}').then(()=>this.textContent='Copied!')">Copy URL</button>
  <div class="steps">
    <h3>Add to Claude Desktop</h3>
    <div class="step"><div class="num">1</div><span>Open Claude Desktop → Settings → Connectors</span></div>
    <div class="step"><div class="num">2</div><span>Click "Add custom connector"</span></div>
    <div class="step"><div class="num">3</div><span>Paste the URL above and click Add</span></div>
    <div class="step"><div class="num">4</div><span>Enable it in your next conversation via the + button</span></div>
  </div>
</div></body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + (err.message || err));
  }
});

// ── MCP endpoint (Streamable HTTP transport) ──────────────────────────────────
function mcpHandler(tier) {
  return async (req, res) => {
    const sessionId = req.query.session;
    const session   = sessions.get(sessionId);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session. Please reconnect at ' + SERVER_URL });
    }

    if (req.method === 'GET') {
      // SSE stream for server-initiated messages (required by MCP spec)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      // Keep alive ping every 30s
      const ping = setInterval(() => res.write(': ping\n\n'), 30000);
      req.on('close', () => clearInterval(ping));
      return;
    }

    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

      const { id, method, params } = msg;
      const tools = tier === 'full' ? TOOLS_FULL : TOOLS_READONLY;

      function send(result) { res.json({ jsonrpc: '2.0', id, result }); }
      function sendErr(code, message) { res.json({ jsonrpc: '2.0', id, error: { code, message: String(message) } }); }

      try {
        switch (method) {
          case 'initialize':
            return send({
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: `platinum-cubed-mcp-${tier}`, version: '1.0.0' }
            });
          case 'initialized':
            return res.status(204).send();
          case 'tools/list':
            return send({ tools });
          case 'tools/call': {
            try {
              const result = await handleTool(session, params.name, params.arguments || {});
              return send(result);
            } catch (toolErr) {
              return send({ content: [{ type: 'text', text: 'Error: ' + (toolErr.message || toolErr) }], isError: true });
            }
          }
          case 'ping':
            return send({});
          default:
            if (id != null) return sendErr(-32601, 'Method not found: ' + method);
            return res.status(204).send();
        }
      } catch (err) {
        return sendErr(-32000, err.message || err);
      }
    });
  };
}

app.get('/mcp/readonly', mcpHandler('readonly'));
app.post('/mcp/readonly', mcpHandler('readonly'));
app.get('/mcp/full',     mcpHandler('full'));
app.post('/mcp/full',    mcpHandler('full'));

// ── Setup / landing page ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Platinum Cubed MCP — Salesforce for Claude</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0B1829; color: #e0e8f0; min-height: 100vh; }
  nav { background: #0d1f33; border-bottom: 1px solid #1e3a5f; padding: 0 40px; height: 60px; display: flex; align-items: center; justify-content: space-between; }
  .logo { font-size: 16px; font-weight: 600; color: white; }
  .logo span { color: #4A9EE0; }
  .hero { text-align: center; padding: 80px 20px 60px; }
  .hero h1 { font-size: 42px; font-weight: 700; line-height: 1.2; margin-bottom: 16px; }
  .hero h1 span { color: #4A9EE0; }
  .hero p { font-size: 18px; color: #8aabcc; max-width: 540px; margin: 0 auto 40px; line-height: 1.6; }
  .tiers { display: flex; gap: 24px; justify-content: center; padding: 0 20px 80px; flex-wrap: wrap; max-width: 900px; margin: 0 auto; }
  .tier { background: #132035; border: 1px solid #1e3a5f; border-radius: 16px; padding: 36px; flex: 1; min-width: 300px; max-width: 400px; }
  .tier.featured { border-color: #7B2FBE; background: #1a1535; }
  .tier-badge { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 12px; border-radius: 99px; display: inline-block; margin-bottom: 16px; }
  .badge-ro { background: #1565C0; color: white; }
  .badge-full { background: #7B2FBE; color: white; }
  .tier h2 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .tier p { color: #8aabcc; font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
  .features { list-style: none; margin-bottom: 32px; }
  .features li { padding: 6px 0; font-size: 14px; color: #cdd; display: flex; gap: 10px; }
  .features li::before { content: '✓'; color: #4CAF50; font-weight: 700; flex-shrink: 0; }
  .connect-form { display: flex; flex-direction: column; gap: 12px; }
  .connect-form input { background: #0B1829; border: 1px solid #2a4a6e; border-radius: 8px; padding: 12px 14px; color: white; font-size: 14px; outline: none; }
  .connect-form input:focus { border-color: #4A9EE0; }
  .connect-form input::placeholder { color: #556; }
  .btn { padding: 14px 24px; border-radius: 10px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
  .btn-blue { background: #2D7DD2; color: white; }
  .btn-purple { background: #7B2FBE; color: white; }
  .btn:hover { opacity: 0.88; }
  footer { text-align: center; padding: 40px; color: #445; font-size: 13px; border-top: 1px solid #1a2e45; }
  footer a { color: #4A9EE0; text-decoration: none; }
</style></head><body>
<nav>
  <div class="logo">Platinum <span>Cubed</span> MCP</div>
  <div style="font-size:13px;color:#556;">Salesforce × Claude</div>
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
    <ul class="features">
      <li>Query any Salesforce object (SOQL)</li>
      <li>Search across your org (SOSL)</li>
      <li>Explore object schemas & fields</li>
      <li>Fetch specific records by ID</li>
      <li>No changes to your data</li>
    </ul>
    <div class="connect-form">
      <input type="text" id="ro-url" placeholder="https://yourorg.my.salesforce.com" />
      <a class="btn btn-blue" href="#" onclick="connect('readonly')">Connect Read Only →</a>
    </div>
  </div>

  <div class="tier featured">
    <div class="tier-badge badge-full">Full Access</div>
    <h2>Build & Automate</h2>
    <p>Complete access for admins and developers. Read, write, deploy Apex classes, and manage flows.</p>
    <ul class="features">
      <li>Everything in Read Only</li>
      <li>Create, update & delete records</li>
      <li>Deploy & manage Apex classes</li>
      <li>Build & activate Flows</li>
      <li>Execute anonymous Apex</li>
      <li>Run Apex tests</li>
    </ul>
    <div class="connect-form">
      <input type="text" id="full-url" placeholder="https://yourorg.my.salesforce.com" />
      <a class="btn btn-purple" href="#" onclick="connect('full')">Connect Full Access →</a>
    </div>
  </div>

</div>
<footer>
  Built by <a href="https://platinumcubed.com" target="_blank">Platinum Cubed</a> · Salesforce consulting & AI innovation
</footer>
<script>
function connect(tier) {
  const inputId = tier === 'full' ? 'full-url' : 'ro-url';
  const instanceUrl = document.getElementById(inputId).value.trim() || 'https://login.salesforce.com';
  window.location.href = '/oauth/start?tier=' + tier + '&instance_url=' + encodeURIComponent(instanceUrl);
}
</script>
</body></html>`);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

app.listen(PORT, () => console.log(`Platinum Cubed MCP running on port ${PORT}`));
