import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

test('SIGINT cancels a waiting decision and exits 130',async t=>{
  let cancelled=false; let statusStarted!:()=>void; const waiting=new Promise<void>(r=>statusStarted=r);
  const server=createServer(async(req,res)=>{for await(const _ of req) {} if(req.url?.endsWith('/request')) res.end(JSON.stringify({id:'decision-1',decision:{id:'decision-1',status:'pending'}})); else if(req.url?.endsWith('/status')) statusStarted(); else if(req.url?.endsWith('/cancel')) {cancelled=true;res.end('{}');} });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.closeAllConnections()); t.after(()=>server.close());
  const addr=server.address() as any; const child=spawn(process.execPath,['--import','tsx',new URL('../image/floq.mts',import.meta.url).pathname,'decision','request','--question','Choose','--wait'],{env:{...process.env,FLOQ_API_URL:`http://127.0.0.1:${addr.port}`,FLOQ_AGENT_TOKEN:'test'}});
  const closed=new Promise<number|null>(r=>child.on('close',r)); await waiting; child.kill('SIGINT'); assert.equal(await closed,130); assert.equal(cancelled,true);
});
