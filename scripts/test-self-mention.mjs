import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HookOneBot,conversationId} from './hook-onebot.mjs';
import {normalizeOneBotEvent} from '../components/qq-bridge/src/onebot/normalize.js';
import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
import {buildSocialPrompt,isDirectMention} from '../components/qq-bridge/src/core/social-engine.js';

function fixture(t,nicknames=['微信机器人','小助手']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-self-mention-'));
  for(const dir of ['config','state/hook'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const group=conversationId('fixture@chatroom');
  const peer=conversationId('wxid_peer');
  fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},account:{nicknames},hook:{baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.1.10.27'},wechat:{whitelist:{groups:[group],private:[peer]}}}));
  fs.writeFileSync(path.join(root,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'fixture'}));
  fs.writeFileSync(path.join(root,'state/hook/native-token.txt'),'c'.repeat(64));
  const hook=new HookOneBot({directory:root});hook.ownWxid='wxid_bot';
  t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const payload=(content,extra={})=>({event:'message.new',type:1,sessionId:'fixture@chatroom',talkerId:'wxid_peer',rawid:content,content,...extra});
  const normalize=event=>normalizeOneBotEvent('wechat','wechat-onebot',event);
  return {root,hook,payload,normalize};
}

test('self mention wakes the group without exposing the WeChat nickname in the model prompt',t=>{
  const f=fixture(t),event=f.hook.incoming(f.payload('@微信机器人\u2005 今天天气怎么样？'));
  const message=f.normalize(event);
  assert.equal(message.text,'今天天气怎么样？');assert.equal(isDirectMention(message),true);
  assert.equal(event.raw_message,'@微信机器人\u2005 今天天气怎么样？');
  const buffer=new MessageBuffer(path.join(f.root,'messages.json'));buffer.append(message);
  const rows=new MessageBuffer(buffer.file).recent('wechat:group:'+event.group_id);
  const prompt=buildSocialPrompt({key:'wechat:group:'+event.group_id,rows,direct:true,role:'小鲸鱼'});
  assert(prompt.includes('今天天气怎么样？'));assert(!prompt.includes('@微信机器人'));
});

test('only self labels are removed; other mentions, body names and text order remain intact',t=>{
  const f=fixture(t);
  const message=f.normalize(f.hook.incoming(f.payload('请看 @微信机器人\u2005 @群友\u2005解释一下，微信机器人这个词是什么意思？ @小助手')));
  assert.equal(message.text,'请看 @群友\u2005解释一下，微信机器人这个词是什么意思？');
  assert.equal(isDirectMention(message),true);
});

test('a standalone self mention retains a model-visible wake-up without the nickname',t=>{
  const f=fixture(t);
  for(const content of ['@微信机器人','@微信机器人\u2005','@微信机器人 ']){
    const message=f.normalize(f.hook.incoming(f.payload(content)));
    assert.equal(message.text,'[有人@你]');assert.equal(isDirectMention(message),true);
  }
});

test('nickname punctuation and ordinary space separators match literally without eating the question',t=>{
  const f=fixture(t,['Bot (A)+','机器人']);
  for(const content of ['@Bot (A)+\u2005你好','@Bot (A)+ 你好']){
    assert.equal(f.normalize(f.hook.incoming(f.payload(content))).text,'你好');
  }
  const longer=f.normalize(f.hook.incoming(f.payload('@机器人管理员\u2005你好')));
  assert.equal(longer.text,'@机器人管理员\u2005你好');assert.equal(isDirectMention(longer),false);
});

test('private messages and mentions of other people are not rewritten',t=>{
  const f=fixture(t),content='@微信机器人\u2005你好';
  assert.equal(f.normalize(f.hook.incoming(f.payload(content,{sessionId:'wxid_peer'}))).text,content);
  const other=f.normalize(f.hook.incoming(f.payload('@群友\u2005你好')));
  assert.equal(other.text,'@群友\u2005你好');assert.equal(isDirectMention(other),false);
});

test('quoted replies clean only the new self mention and retain historical quotation text',t=>{
  const f=fixture(t),reply='@微信机器人\u2005你怎么看？';
  const quoteReply={version:1,reply,reference:{senderId:'wxid_other',senderName:'群友',conversationId:'fixture@chatroom',messageId:'1',time:'',kind:'1',text:'历史讨论 @微信机器人',unavailable:false}};
  const message=f.normalize(f.hook.incoming(f.payload(reply,{type:49,quoteReply})));
  assert.equal(message.text,'你怎么看？');assert.equal(message.quoteReply.reply,'你怎么看？');
  assert.equal(message.quoteReply.reference.text,'历史讨论 @微信机器人');assert.equal(isDirectMention(message),true);
});
