import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,join,sep,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','dist'),prefix='/CopperReview/',port=Number(process.env.PORT||9390);
const mime={'.js':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.copper':'text/plain'};
createServer(async(req,res)=>{
 try{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
  const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);if(!path.startsWith(prefix)){res.writeHead(404);res.end();return;}
  const target=resolve(root,path.slice(prefix.length)||'index.html');if(!target.startsWith(root+sep)||!(await stat(target)).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':mime[extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:await readFile(target));
 }catch{res.writeHead(404);res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`Static CopperReview: http://127.0.0.1:${port}${prefix}`));
