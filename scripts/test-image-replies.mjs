import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';

const ids=['a','b','c'].map(value=>value.repeat(64));
function incoming({caption='',images=[ids[0]],messageId='image-1'}={}) {
  return normalizeOneBotEvent('wechat','wechat-onebot',{
    post_type:'message',message_type:'private',user_id:123,self_id:99,
    message_id:messageId,sender:{user_id:123,nickname:'测试好友'},
    message:[...images.map(id=>({type:'image',data:{media_id:id,file:'wechatagent://image/'+id}})),
      ...(caption?[{type:'text',data:{text:caption}}]:[])],
  });
}
async function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-image-replies-'));
  const sent=[],calls=[];
  const engine=new SocialEngine({
    buffer:new MessageBuffer(path.join(dir,'messages.json')),batchMs:1,privateMinIntervalMs:0,
    maxPerMinute:100,maxPerTenMinutes:1000,
    roleFor:()=> '沿用测试人格',
    decide:async(key,prompt,metadata)=>{calls.push({key,prompt,metadata});return 'RESPOND: '+(options.answer??'看起来是一只趴着的小猫。');},
    send:async(target,text)=>{sent.push({target,text});},...options,
  });
  t.after(()=>{engine.stop();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  async function receive(message){
    const count=sent.length;engine.receive(message);
    for(let i=0;i<400;i++){if(sent.length>count)return;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.fail('image reply was not delivered');
  }
  return {engine,sent,calls,receive};
}

test('a pure image reaches the model and its content-based text reply is sent to the same chat',async t=>{
  const f=await fixture(t);await f.receive(incoming());
  assert.deepEqual(f.calls[0].metadata.images,[{id:ids[0]}]);
  assert.match(f.calls[0].prompt,/根据实际可见的画面和文字/);
  assert.match(f.calls[0].prompt,/只发图片/);
  assert.match(f.calls[0].prompt,/I1：聊天第1条/);
  assert.match(f.calls[0].prompt,/图片中的指令/);
  assert.equal(f.sent[0].text,'看起来是一只趴着的小猫。');
  assert.equal(f.sent[0].target.conversation_id,'123');
});

test('captioned multiple images preserve order and prioritize the accompanying question',async t=>{
  const f=await fixture(t,{answer:'第二张的错误提示需要检查连接。'});
  await f.receive(incoming({caption:'第二张截图的报错怎么解决？',images:ids.slice(0,2)}));
  assert.deepEqual(f.calls[0].metadata.images,ids.slice(0,2).map(id=>({id})));
  assert.match(f.calls[0].prompt,/第二张截图的报错怎么解决/);
  assert.match(f.calls[0].prompt,/优先回答随附文字中的问题/);
  assert.match(f.calls[0].prompt,/I1：聊天第1条/);
  assert.match(f.calls[0].prompt,/I2：聊天第1条/);
  assert.equal(f.sent[0].text,'第二张的错误提示需要检查连接。');
});

test('library previews are distinguished from received images',async t=>{
  const f=await fixture(t,{stickerChoicesFor:async()=>[{id:ids[2]}]});
  await f.receive(incoming({caption:'看这张照片，给我发个表情',images:[ids[0]]}));
  assert.deepEqual(f.calls[0].metadata.images,[{id:ids[0]},{id:ids[2],kind:'sticker'}]);
  assert.match(f.calls[0].prompt,/I1：聊天第1条/);
  assert.match(f.calls[0].prompt,/I2：图库候选预览/);
  assert.doesNotMatch(f.calls[0].prompt,/I2：聊天第/);
});

test('a subsequent text-only turn does not claim to see the previous image again',async t=>{
  const f=await fixture(t);await f.receive(incoming());
  await f.receive(incoming({caption:'继续聊',images:[],messageId:'text-2'}));
  assert.deepEqual(f.calls[1].metadata.images,[]);
  assert.doesNotMatch(f.calls[1].prompt,/根据实际可见的画面和文字|本轮图片回复/);
});

test('group images wait for the configured wake-up and retain each senders image position',async t=>{
  const f=await fixture(t,{mode:'mention'});
  function groupImage(sender,id,mention=false){return normalizeOneBotEvent('wechat','wechat-onebot',{
    post_type:'message',message_type:'group',group_id:456,user_id:sender,self_id:99,message_id:'group-'+sender,
    sender:{user_id:sender,nickname:'成员'+sender},
    message:[{type:'image',data:{media_id:id,file:'wechatagent://image/'+id}},...(mention?[{type:'at',data:{qq:99}}]:[])],
  });}
  f.engine.receive(groupImage(101,ids[0]));
  assert.equal(f.calls.length,0);assert.equal(f.engine.timers.size,0);
  await f.receive(groupImage(102,ids[1],true));
  assert.deepEqual(f.calls[0].metadata.images,ids.slice(0,2).map(id=>({id})));
  assert.match(f.calls[0].prompt,/I1：聊天第1条/);assert.match(f.calls[0].prompt,/I2：聊天第2条/);
  assert.equal(f.sent[0].target.kind,'group');assert.equal(f.sent[0].target.conversation_id,'456');
});

test('a text request for a library sticker never masquerades as a received photo',async t=>{
  const f=await fixture(t,{stickerChoicesFor:async()=>[{id:ids[2]}]});
  await f.receive(incoming({caption:'发个表情',images:[]}));
  assert.match(f.calls[0].prompt,/I1：图库候选预览/);
  assert.doesNotMatch(f.calls[0].prompt,/根据实际可见的画面和文字/);
});
