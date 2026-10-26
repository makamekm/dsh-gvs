import test from 'node:test';import assert from 'node:assert/strict';import {createWorld,advance,jump,snapshot} from './physics.mjs';
test('2D wall stops actual movement',()=>{const w=createWorld(2);advance(w,new Set(['ArrowRight']),90);assert.equal(w.x,2.75);assert.ok(w.wallHits>0);});
test('initial overlap is resolved',()=>{const w=createWorld(2,'overlap');advance(w,new Set(),1);assert.ok(w.x<=2.75||w.x>=3.75);});
test('3D swept movement prevents high-speed tunnelling',()=>{const w=createWorld(3,'highspeed');advance(w,new Set(['ArrowRight']),10);assert.equal(w.x,2.75);assert.ok(w.wallHits>0);});
test('3D jump lands on the actual ground',()=>{const w=createWorld(3);jump(w);advance(w,new Set(),25);assert.ok(w.y>0);advance(w,new Set(),100);assert.equal(w.y,0);assert.equal(w.grounded,true);assert.ok(w.groundHits>0);});
test('win, hazard failure and restart are real game states',()=>{let w=createWorld(2,'win');advance(w,new Set(['ArrowRight']),10);assert.equal(w.won,true);w=createWorld(3,'hazard');advance(w,new Set(['ArrowDown']),10);assert.equal(w.lost,true);w=createWorld(3);assert.equal(w.lost,false);assert.equal(w.won,false);});
test('camera input changes the actual 3D render parameter',()=>{const w=createWorld(3),before=snapshot(w).camera.yaw;advance(w,new Set(['KeyE']),20);assert.ok(w.camera.yaw>before);});
test('negative control demonstrates a missing collider is detectable',()=>{const w=createWorld(2);advance(w,new Set(['ArrowRight']),90,false);assert.ok(w.x>3.5);assert.equal(w.wallHits,0);});
