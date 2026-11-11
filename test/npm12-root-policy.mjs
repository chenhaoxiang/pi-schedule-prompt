#!/usr/bin/env node
// Explicit manual npm12 policy check. Synthetic loopback packages only; no provider/credentials.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const npmArg=process.argv[2]??process.env.npm_execpath;
assert(npmArg&&path.isAbsolute(npmArg),'Pass the absolute npm12 bin/npm-cli.js path');
const npm=fs.realpathSync(npmArg),version=execFileSync(process.execPath,[npm,'--version'],{encoding:'utf8'}).trim();assert(Number(version.split('.')[0])>=12,'This manual policy test requires npm12+');
const policy=fs.readFileSync(path.join(repository,'.npmrc'),'utf8');
assert.deepEqual(policy.split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')),['allow-remote=root']);
const fixtures=path.join(repository,'tmp/npm12-policy-fixtures');fs.mkdirSync(fixtures,{recursive:true});
const root=fs.mkdtempSync(path.join(fixtures,'case-'));const routes=new Map();let server;
const env={PATH:process.env.PATH,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),LANG:'C',NO_COLOR:'1'};
fs.mkdirSync(env.HOME,{recursive:true});const userConfig=path.join(root,'empty-user.npmrc'),globalConfig=path.join(root,'empty-global.npmrc');fs.writeFileSync(userConfig,'');fs.writeFileSync(globalConfig,'');
const run=(args,cwd)=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[npm,...args],{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',d=>{stdout=(stdout+d).slice(-65536)});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-65536)});
 const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('owned synthetic npm process exceeded 90s'))},90000);
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
});
const tarball=(name,dependencies={})=>{
 const base=path.join(root,'tar-'+name),pkg=path.join(base,'package');fs.mkdirSync(pkg,{recursive:true});
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name,version:'1.0.0',dependencies,scripts:{postinstall:"node -e \"require('fs').writeFileSync('SCRIPT_RAN','unexpected')\""}}));
 const file=path.join(base,name+'.tgz');execFileSync('tar',['-czf',file,'-C',base,'package']);const bytes=fs.readFileSync(file);return {name,bytes,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),dependencies};
};
try{
 server=http.createServer((req,res)=>{const bytes=routes.get(req.url);if(!bytes){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length});res.end(bytes);});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const base='http://127.0.0.1:'+server.address().port;
 const child=tarball('fixture-child'),childUrl=base+'/child.tgz';routes.set('/child.tgz',child.bytes);
 const direct=tarball('fixture-direct'),directUrl=base+'/direct.tgz';routes.set('/direct.tgz',direct.bytes);
 const parent=tarball('fixture-parent',{'fixture-child':childUrl}),parentUrl=base+'/parent.tgz';routes.set('/parent.tgz',parent.bytes);
 const cases=[{name:'none-denies-direct',pkg:direct,url:directUrl,config:'',expected:1},{name:'root-allows-pinned-direct',pkg:direct,url:directUrl,config:policy,expected:0},{name:'root-denies-transitive',pkg:parent,url:parentUrl,config:policy,expected:1}];const results=[];
 for(const c of cases){
  const cwd=path.join(root,c.name);fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'.npmrc'),c.config);
  const manifest={name:'fixture-project',version:'1.0.0',private:true,devDependencies:{[c.pkg.name]:c.url}};
  const packages={'':{name:manifest.name,version:manifest.version,devDependencies:manifest.devDependencies},['node_modules/'+c.pkg.name]:{version:'1.0.0',resolved:c.url,integrity:c.pkg.integrity,dev:true,hasInstallScript:true,...(Object.keys(c.pkg.dependencies).length?{dependencies:c.pkg.dependencies}:{})}};
  if(c.pkg===parent)packages['node_modules/fixture-child']={version:'1.0.0',resolved:childUrl,integrity:child.integrity,dev:true,hasInstallScript:true};
  fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(cwd,'package-lock.json'),JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages}));
  const beforeLock=fs.readFileSync(path.join(cwd,'package-lock.json'));
  const result=await run(['ci','--ignore-scripts','--no-audit','--no-fund','--userconfig',userConfig,'--globalconfig',globalConfig,'--cache',path.join(cwd,'fresh-cache'),'--registry','https://registry.npmjs.org'],cwd);
  fs.writeFileSync(path.join(cwd,'npm.stdout.log'),result.stdout);fs.writeFileSync(path.join(cwd,'npm.stderr.log'),result.stderr);
  if(c.expected===0){assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(cwd,'node_modules',c.pkg.name,'package.json'))).version,'1.0.0');assert(!fs.existsSync(path.join(cwd,'node_modules',c.pkg.name,'SCRIPT_RAN')));}else{assert.notEqual(result.code,0);assert(result.stderr.includes('EALLOWREMOTE'),result.stderr);if(c.pkg===parent)assert(/non-root/.test(result.stderr),result.stderr);}
  assert.deepEqual(fs.readFileSync(path.join(cwd,'package-lock.json')),beforeLock);results.push({name:c.name,expectedPolicyResultObserved:true,lifecycleScriptsRan:false,lockUnchanged:true});
 }
 const report={ok:true,npmVersion:version,syntheticLoopbackOnly:true,realProviderRequests:0,realCredentialUse:false,globalOrUserConfigWritten:false,cases:results};
 const reportPath=path.join(repository,'tmp/npm12-policy-report.json');fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
