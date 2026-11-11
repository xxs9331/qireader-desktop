const calls = { adds: [], reads: [] };
let held, release, rejectAdd = true;
const html = `<!doctype html><meta charset="utf-8"><title>全部订阅源 · 测试</title>
<style>body{margin:0;font:18px sans-serif}#items{height:420px;overflow:auto}[data-is-entry]{height:220px;padding:16px;box-sizing:border-box;border-bottom:1px solid #ddd}.summary{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:2}#portal [tabindex]{padding:10px}</style>
<button title="视图选项" id="options">视图选项</button>
<div data-focus-container="entryList" id="items"></div><div id="portal"></div>
<script>
window.nativeOpened=false;
window.prefs=JSON.parse(localStorage.getItem('screening-prefs')||'null')||{magazine:false,scroll:false,lines:2};
const savePrefs=()=>{localStorage.setItem('screening-prefs',JSON.stringify(prefs));for(const n of document.querySelectorAll('.summary'))n.style.webkitLineClamp=prefs.lines;};
const items=document.getElementById('items'),portal=document.getElementById('portal');
for(const id of ['screen-a','screen-b','already','bad','menu-only','tail']){
 const row=document.createElement('div');row.tabIndex=0;row.setAttribute('data-is-entry',id);
 row.innerHTML='<a data-is-entry-title href="https://example.test/'+id+'">'+id+'</a><p class="summary">第一行摘要<br>第二行摘要<br>第三行摘要<br>第四行摘要</p><button title="稍后阅读"><svg fill="'+(id==='already'?'currentColor':'none')+'"></svg></button>';
 row.onclick=()=>{window.nativeOpened=true;};
 row.querySelector('button').onclick=async event=>{
  event.stopPropagation();const icon=row.querySelector('svg'),saved=icon.getAttribute('fill')!=='none';
  icon.setAttribute('fill',saved?'none':'currentColor');
  const r=await fetch('/api/entries/saved/'+id+'/tags/later',{method:saved?'DELETE':'PUT'});
  if(!r.ok)icon.setAttribute('fill',saved?'currentColor':'none');
 };
 if(id==='menu-only'){
  row.querySelector('button').remove();
  row.oncontextmenu=event=>{
   event.preventDefault();portal.innerHTML='<a tabindex="0">稍后阅读</a>';
   const n=document.createElement('div');n.tabIndex=0;n.innerHTML='<svg><rect width="10" height="10"></rect>'+(window.menuSaved?'<path d="M1 1L2 2"></path>':'')+'</svg><span>稍后阅读</span>';
   n.onclick=async()=>{const r=await fetch('/api/entries/saved/'+id+'/tags/later',{method:window.menuSaved?'DELETE':'PUT'});if(r.ok)window.menuSaved=true;portal.replaceChildren();};portal.append(n);
  };
 }
 items.append(row);
}
const menu=()=>{
 portal.replaceChildren();
 const option=(text,value,action)=>{const n=document.createElement('div');n.tabIndex=0;n.textContent=text;n.setAttribute('aria-checked',String(value));n.onclick=action;portal.append(n);return n;};
 option('杂志',prefs.magazine,()=>{prefs.magazine=true;savePrefs();portal.replaceChildren();});
 option('滚动标记为已读',prefs.scroll,()=>{prefs.scroll=!prefs.scroll;savePrefs();menu();});
 const summary=document.createElement('div');summary.innerHTML='<span>摘要行数</span><button>−</button><span>'+prefs.lines+'</span><button>＋</button>';
 summary.querySelectorAll('button').forEach((b,i)=>b.onclick=()=>{prefs.lines+=i?1:-1;savePrefs();summary.querySelectorAll('span')[1].textContent=prefs.lines;});portal.append(summary);
};
document.getElementById('options').onclick=menu;
document.addEventListener('keydown',e=>{if(e.key==='Escape')portal.replaceChildren();});
const seen=new Set();
items.addEventListener('scroll',async()=>{
 if(!prefs.scroll)return;const id=items.scrollTop<300?'screen-a':'screen-b';if(seen.has(id))return;seen.add(id);
 const response=await fetch('/api/markers/reads',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({type:'entries',entryIds:[id]})});
 if(!response.ok)seen.delete(id);
});
savePrefs();
</script>`;
async function respond(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/markers/reads' && request.method === 'PUT') {
    const body = await request.json(); calls.reads.push(body);
    if (held) await held;
    return Response.json({ result: {} }, { status: body.entryIds?.includes('screen-b') ? 503 : 200 });
  }
  if (url.pathname.startsWith('/api/entries/') && url.pathname.endsWith('/tags/later') && request.method === 'PUT') {
    const id = url.pathname.split('/').at(-3); calls.adds.push(id);
    if (id === 'bad' && rejectAdd) { rejectAdd = false; return Response.json({}, { status: 503 }); }
    return Response.json({ result: {} });
  }
}
module.exports = { html, respond, calls, hold: () => { held = new Promise(resolve => { release = resolve; }); }, release: () => { release?.(); held = null; } };
