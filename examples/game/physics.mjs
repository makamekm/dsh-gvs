export function createWorld(dim=2,scenario='default'){
 const world={dim,tick:0,x:1,z:0,y:0,vy:0,speed:4,grounded:true,wallHits:0,groundHits:0,won:false,lost:false,camera:{yaw:.55,distance:10}};
 if(scenario==='win'){world.x=5.8;world.z=2;}
 if(scenario==='hazard')world.z=3.4;
 if(scenario==='overlap')world.x=3.1;
 if(scenario==='highspeed')world.speed=80;
 return world;
}
export function jump(world){if(world.dim===3&&world.grounded){world.vy=6;world.grounded=false;}}
function resolveAxis(old,next,minimum,maximum){
 const radius=.25,left=minimum-radius,right=maximum+radius;
 if(old<=left&&next>left)return left;
 if(old>=right&&next<right)return right;
 if(next>left&&next<right)return next-minimum<maximum-next?left:right;
 return next;
}
export function advance(world,keys,frames=1,solid=true){
 for(let frame=0;frame<frames;frame++){
  world.tick++;if(world.won||world.lost)continue;
  const dt=1/60,speed=world.speed*dt;
  let x=world.x+(keys.has('ArrowRight')?speed:0)-(keys.has('ArrowLeft')?speed:0);
  let z=world.z+(keys.has('ArrowDown')?speed:0)-(keys.has('ArrowUp')?speed:0);
  if(world.dim===3){world.vy-=9.8*dt;world.y+=world.vy*dt;if(world.y<=0){if(!world.grounded)world.groundHits++;world.y=0;world.vy=0;world.grounded=true;}}
  if(solid&&world.y<2){
   if(world.z> -1.25&&world.z<1.25){const corrected=resolveAxis(world.x,x,3,3.5);if(corrected!==x)world.wallHits++;x=corrected;}
   if(x>2.75&&x<3.75){const corrected=resolveAxis(world.z,z,-1,1);if(corrected!==z)world.wallHits++;z=corrected;}
  }
  world.x=Math.max(.25,Math.min(7.75,x));world.z=Math.max(-1.75,Math.min(3.9,z));
  if(world.dim===3)world.camera.yaw+=(keys.has('KeyE')?.025:0)-(keys.has('KeyQ')?.025:0);
  if(world.z>3.6)world.lost=true;
  if(world.x>=6&&world.z>1.4&&world.z<2.6)world.won=true;
 }
}
export function snapshot(world){return {tick:world.tick,dimension:world.dim,player:{x:world.x,y:world.y,z:world.z,grounded:world.grounded},events:{wallHits:world.wallHits,groundHits:world.groundHits},game:{won:world.won,lost:world.lost},camera:{...world.camera}};}
