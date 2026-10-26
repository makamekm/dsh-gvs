const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 const file=path.join(__dirname,['/','/2d.html','/3d.html'].includes(pathname)?'index.html':pathname);
 if(!file.startsWith(__dirname+path.sep)){res.writeHead(403).end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',path.extname(file)==='.html'?'text/html; charset=utf-8':path.extname(file)==='.mjs'?'text/javascript':'text/plain');res.end(data);});
}).listen(4186,'127.0.0.1',()=>console.log('Game fixture http://127.0.0.1:4186/2d.html and /3d.html'));
