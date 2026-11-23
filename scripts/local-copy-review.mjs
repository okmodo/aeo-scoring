// Offline-only review: serves a build and frozen fictional assessment, never a live audit.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const password = process.env.LOCAL_REVIEW_PASSWORD;
if (!password) throw new Error('Set LOCAL_REVIEW_PASSWORD for this local-only review.');
const root = resolve('dist');
const fixture = readFileSync('test/fixtures/customer-copy/assessment.json');
const bridge = `const realFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{const request=new Request(input,init);const url=new URL(request.url);if(url.origin==='https://aeo-audit-public-20261105.aeo-scoring-kk7.workers.dev'){return realFetch(location.origin+url.pathname+url.search,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),credentials:'omit',redirect:'error',signal:request.signal});}return realFetch(input,init);};`;
const types={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'};
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const path = new URL(req.url,'http://localhost').pathname;
  if(path.startsWith('/api/')) {
    if(req.headers.authorization !== 'Bearer '+password){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Testing password required.'}}));return;}
    if(path==='/api/v1/preview-access'&&req.method==='POST'){res.writeHead(204);res.end();return;}
    if((path==='/api/v1/audits'&&req.method==='POST')||(path==='/api/v1/audits/customer-copy-review'&&req.method==='GET')){res.writeHead(200,{'Content-Type':'application/json'});res.end(fixture);return;}
    res.writeHead(404);res.end();return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  if(path==='/local-copy-review.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(bridge);return;}
  let decoded;
  try { decoded=decodeURIComponent(path==='/'?'/index.html':path); } catch { res.writeHead(400);res.end();return; }
  const file=resolve(root, '.'+decoded);
  if(!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
  try {
    let body=readFileSync(file);
    if(file.endsWith('index.html')) body=Buffer.from(body.toString().replace('<head>','<head><script src="/local-copy-review.js"></script>').replace('<body>','<body><div style="padding:12px;background:#fff1c6;text-align:center;font:16px system-ui">LOCAL DESIGN REVIEW · Fictional results · Enter any product URL to view the 24-test report. No live audit is run.</div>'));
    res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end();}
}).listen(Number(process.env.PORT??4384),'0.0.0.0',()=>console.log('Offline copy review listening on port '+(process.env.PORT??4384)));
