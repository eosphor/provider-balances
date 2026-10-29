const fs = require('fs'); const vm = require('vm'); const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '../desktop/plugin.js'),'utf8').replace(/import\s*\{[\s\S]*?\}\s*from\s*'@hermes\/plugin-sdk'/, '').replace(/import\s*\{[^}]*\}\s*from\s*'react\/jsx-runtime'/, '').replace('export default {','const plugin = {');
const rows=[{id:'anthropic:current-session',display:'Anthropic',status:'ok',detail:'Current session',remaining_percent:90},{id:'anthropic:week',display:'Anthropic',status:'ok',detail:'week',remaining_percent:10},{id:'openai-codex:session',display:'Codex',status:'ok',detail:'Session',remaining_percent:97},{id:'openai-codex:week',display:'Codex',status:'ok',detail:'week',remaining_percent:51},{id:'deepseek',display:'DeepSeek',status:'ok',detail:'28 CNY'}];
function run(model, provider, returnedModel=model, returnProps=false) {
 let requests=[]; const atom={get:()=>false}; const host={state:{model:'model',focusedSessionId:'session',focusedSessionProfile:'profile',focusedSessionOwner:'owner',profile:'profile'},request:async(method,params)=>{requests.push([method,params]);return {model:returnedModel,provider}}};
 const sdk={atom:()=>atom,Badge:'Badge',Button:'Button',GlyphSpinner:'Spinner',host,icons:{CreditCard:'Card'},Popover:'Popover',PopoverContent:'PopoverContent',PopoverTrigger:'PopoverTrigger',STATUSBAR_AREAS:{right:'right'},Tip:'Tip',usePluginI18n:()=>x=>x,useValue:a=>a==='model'?model:a==='session'?'session-1':a==='profile'?'default':a==='owner'?{profile:'default',connectionId:'local'}:false,useQuery:o=>{if(o.queryKey[1]==='balances')return {data:rows}; if(o.queryKey[1]==='active-provider')return {data:provider}; return {data:{provider,model:returnedModel}}},jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),document:{}};
 const sandbox={...sdk};vm.createContext(sandbox);vm.runInContext(source+'; globalThis.render=BalancesBar;',sandbox);const tree=sandbox.render({ctx:{},open:atom}); const trigger=tree.props.children.props.children[0].props.children; return returnProps ? trigger.props : trigger.props['aria-label'];
}
assert.match(run('gpt-6.1-terra','openai-codex'), /97%/, 'Codex must show session limit, not the smaller weekly limit');
assert.match(run('claude-opus','anthropic'), /90%/, 'Anthropic must show current session, not weekly limit');
assert.match(run('deepseek-flash','deepseek'), /28 CNY/);
assert.match(run('gpt-6.1-terra','openrouter'), /unavailable|–/i, 'Do not substitute another provider when unavailable');
assert.doesNotMatch(run('gpt-6.1-terra','anthropic','claude-opus'), /10%/, 'Stale provider for a previous model must not be displayed');
for (const [pct, expected] of [[0,true],[4.9,true],[5,false],[5.1,false]]) {
 rows[2].remaining_percent=pct;
 assert.strictEqual(Boolean(run('gpt-6.1-terra','openai-codex','gpt-6.1-terra',true)['data-low-balance']),expected,`warning at ${pct}%`);
}
assert.strictEqual(Boolean(run('deepseek-flash','deepseek','deepseek-flash',true)['data-low-balance']), false, 'no invented threshold for monetary balances');
console.log('provider selection and warning tests passed');
