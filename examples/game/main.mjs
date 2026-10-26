import {createWorld,advance,jump,snapshot} from './physics.mjs';
const dim=location.pathname.includes('3d')?3:2,params=new URLSearchParams(location.search),testMode=params.get('gvs_test')==='1',solid=!testMode||params.get('broken')!=='1';
const canvas=document.querySelector('canvas'),status=document.querySelector('#status'),keys=new Set();let world=createWorld(dim);
document.querySelector('h1').textContent=`Испытательный полигон · ${dim}D`;
document.querySelector('#keys').textContent=dim===3?'Стрелки — движение · Space — прыжок · Q/E — камера · R — заново':'Стрелки — движение · R — заново';
const renderer=dim===3?webglRenderer(canvas):canvas2D(canvas);
function render(){renderer(world);status.textContent=world.won?'Победа! R — начать заново':world.lost?'Опасная зона. R — попробовать ещё раз':'Обойди стену и доберись до зелёной площадки. Красная полоса опасна.';}
function reset(scenario='default'){world=createWorld(dim,scenario);keys.clear();render();return snapshot(world);}
addEventListener('keydown',event=>{if(['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Space'].includes(event.code))event.preventDefault();keys.add(event.code);if(event.code==='KeyR')reset();if(event.code==='Space')jump(world);});
addEventListener('keyup',event=>keys.delete(event.code));
document.querySelector('button').onclick=()=>reset();
if(testMode)window.__gvsGame={version:1,engine:dim===3?'WebGL + fixture production physics':'Canvas2D + fixture production physics',reset,step(frames){advance(world,keys,frames,solid);render();},state:()=>snapshot(world)};
else{let previous=performance.now(),accumulator=0;function loop(now){accumulator+=Math.min(.1,(now-previous)/1000);previous=now;while(accumulator>=1/60){advance(world,keys,1,solid);accumulator-=1/60;}render();requestAnimationFrame(loop);}requestAnimationFrame(loop);}
render();
function canvas2D(canvas){
 const ctx=canvas.getContext('2d');const scale=82,offsetX=90,offsetY=170;
 return world=>{ctx.fillStyle='#112831';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='#2c4650';ctx.lineWidth=1;for(let i=0;i<=8;i++){ctx.beginPath();ctx.moveTo(offsetX+i*scale,30);ctx.lineTo(offsetX+i*scale,500);ctx.stroke();}for(let i=-2;i<=4;i++){ctx.beginPath();ctx.moveTo(offsetX,offsetY+i*scale);ctx.lineTo(offsetX+8*scale,offsetY+i*scale);ctx.stroke();}
  ctx.fillStyle='#853b40';ctx.fillRect(offsetX,offsetY+3.6*scale,8*scale,.4*scale);
  ctx.fillStyle='#d47d69';ctx.fillRect(offsetX+3*scale,offsetY-scale,.5*scale,2*scale);
  ctx.fillStyle='#71c9ab';ctx.fillRect(offsetX+6*scale,offsetY+1.5*scale,scale,scale);
  ctx.fillStyle='#eee9d9';ctx.beginPath();ctx.arc(offsetX+world.x*scale,offsetY+world.z*scale,.25*scale,0,Math.PI*2);ctx.fill();
 };
}
function webglRenderer(canvas){
 const gl=canvas.getContext('webgl',{antialias:true,preserveDrawingBuffer:true});if(!gl)throw new Error('WebGL rendering is unavailable');
 const shader=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
 const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 p;uniform float yaw;varying float shade;void main(){float x=p.x-4.;float z=p.z-1.;float rx=cos(yaw)*x-sin(yaw)*z;float rz=sin(yaw)*x+cos(yaw)*z;gl_Position=vec4(rx*.19,(p.y*.72-rz*.40-.2)*.34,-rz*.08-p.y*.015,1.);shade=.72+.28*clamp(p.y/2.,0.,1.);}'));
 gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;uniform vec3 color;varying float shade;void main(){gl_FragColor=vec4(color*shade,1.);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Shader link failed');gl.useProgram(program);
 const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,3,gl.FLOAT,false,0,0);gl.enable(gl.DEPTH_TEST);
 const indices=[0,1,2,0,2,3,4,7,6,4,6,5,0,4,5,0,5,1,3,2,6,3,6,7,1,5,6,1,6,2,0,3,7,0,7,4];
 function box(x,y,z,w,h,d,color){const v=[[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z],[x,y,z+d],[x+w,y,z+d],[x+w,y+h,z+d],[x,y+h,z+d]];gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(indices.flatMap(i=>v[i])),gl.DYNAMIC_DRAW);gl.uniform3fv(gl.getUniformLocation(program,'color'),color);gl.drawArrays(gl.TRIANGLES,0,36);}
 return world=>{gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(.066,.157,.192,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.uniform1f(gl.getUniformLocation(program,'yaw'),world.camera.yaw);
  box(0,-.12,-2,8,.1,6,[.25,.36,.39]);box(0,0,3.6,8,.02,.4,[.7,.22,.25]);box(6,0,1.5,1,.025,1,[.35,.8,.62]);box(3,0,-1,.5,2,2,[.86,.43,.32]);box(world.x-.25,world.y,world.z-.25,.5,.8,.5,[.92,.9,.79]);
 };
}
