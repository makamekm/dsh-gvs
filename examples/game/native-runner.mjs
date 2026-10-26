import {createWorld,advance,jump} from './physics.mjs';
const cases=[];let w=createWorld(2);advance(w,new Set(['ArrowRight']),90);cases.push({name:'2D wall',category:'collision',passed:w.x===2.75,actual:w.x,expected:2.75});
w=createWorld(3,'highspeed');advance(w,new Set(['ArrowRight']),10);cases.push({name:'3D high speed wall',category:'collision',passed:w.x===2.75,actual:w.x,expected:2.75});
w=createWorld(3);jump(w);advance(w,new Set(),130);cases.push({name:'3D ground',category:'collision',passed:w.y===0&&w.grounded,actual:{y:w.y,grounded:w.grounded},expected:{y:0,grounded:true}});
w=createWorld(3,'win');advance(w,new Set(['ArrowRight']),10);cases.push({name:'Win',category:'gameplay',passed:w.won,actual:w.won,expected:true});
w=createWorld(3);advance(w,new Set(['ArrowDown']),10);cases.push({name:'Movement input',category:'controls',passed:w.z>0,actual:w.z,expected:'>0'});
const yaw=w.camera.yaw;advance(w,new Set(['KeyE']),20);cases.push({name:'Camera input',category:'camera',passed:w.camera.yaw>yaw,actual:w.camera.yaw,expected:`>${yaw}`});
console.log('GVS_GAME_RESULT: '+JSON.stringify({schema:'gvs.game/1',engine:'Node test runner of the same production physics module used by Canvas/WebGL fixture',cases}));
if(cases.some(item=>!item.passed))process.exitCode=1;
