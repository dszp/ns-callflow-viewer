/**
 * The internal viewer SPA (served by the Worker at `/`). A domain browser + entity picker that
 * renders a live call-flow diagram with pan/zoom, layout toggle, filter, theme switcher, and export.
 * Auth is handled around it (CF Access for the human + a service token in the Worker); this page just
 * calls /domains, /entities, /flow.
 *
 * Rendering: the Worker returns a LEGACY (dark, no-frontmatter) Mermaid string in `__mermaid`, and the
 * page draws it with Pele (Mermaid syntax, Pele's own layout and plain-SVG output) — loaded through
 * netsapiens-lib's `peleScriptTag()` (pinned + SRI) and passed through its `svgSanitizerScript()`
 * before insertion, the same two pieces the lib's own gallery uses.
 *
 * Theming: the client swaps each `classDef` line for the chosen theme's palette (Pele honors classDef)
 * and maps the theme's line/text/background colors onto Pele's `--pele-*` CSS variables, so switching
 * themes needs no server round-trip. Mermaid's `look`/`themeVariables` frontmatter is gone: Pele ignores
 * it, so a hand-drawn theme renders as its plain palette. The whole SPA chrome re-skins via CSS
 * variables. Themes come from the shared netsapiens-lib registry (THEMES), injected as data.
 *
 * Self-contained HTML (inline CSS/JS, Pele from CDN). Not the client-visible portal injection —
 * that's a separate, neutral secondary script (Phase 4). This is the internal tool.
 */
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME, rasterizerScript, peleScriptTag, svgSanitizerScript, letterPrintScript } from '@dszp/netsapiens-lib';
import { themesFor, type BrandEnv } from './brand.js';

/**
 * JSON for embedding inside a `<script>` element.
 *
 * Plain JSON.stringify is NOT safe here: the HTML parser finds `</script` before any JS parser
 * runs, so a `</script>` inside a string ends the element early. THEMES carries BRAND_LABEL /
 * BRAND_NAME (brand.ts), so the value is operator-controlled rather than attacker-controlled —
 * self-XSS, hence low severity — but the escape is free and removes the class outright.
 * `<` parses back to `<`, so the data the page sees is byte-identical.
 * U+2028/U+2029 are legal in JSON but were line terminators in older JS parsers.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The viewer SPA. Takes the brand config so the injected theme registry can carry this deployment's
 * branded theme (see brand.ts) — the shared library ships neutral themes only.
 */
export function viewerHtml(env: BrandEnv = {}): string {
  // Pele has no hand-drawn style, so a theme that only differs by Mermaid's `look: handDrawn` would draw
  // as its plain palette under a name that promises otherwise. Offer only themes this page can draw; a
  // saved or deep-linked choice of one falls back to the default (defaultTheme() ignores unknown ids).
  const THEMES = Object.fromEntries(Object.entries(themesFor(env)).filter(([, t]) => t.look !== 'handDrawn'));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call-Flow Viewer</title>
${peleScriptTag()}
<style>
  :root {
    color-scheme: dark;
    --bg:#141a24; --panel:#1b2230; --panel2:#151b26; --border:#2b3444;
    --text:#dbe2ea; --dim:#8c99ab; --input-bg:#1c2431; --diagram-bg:#121821;
    --item-hover:#1f2836; --item-active:#233046; --accent:#5b8bc0; --notes:#c9a24a; --brand:#dbe2ea;
  }
  * { box-sizing: border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,sans-serif; }
  header { display:flex; gap:10px; align-items:center; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--border); flex:0 0 auto; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0 10px 0 0; white-space:nowrap; color:var(--brand); }
  label { white-space:nowrap; }
  select, button, input { background:var(--input-bg); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:6px 10px; font:inherit; }
  select, button { cursor:pointer; }
  button:hover, select:hover { border-color:var(--accent); }
  button:disabled { opacity:.5; cursor:default; }
  /* Domain combobox (type-to-filter over ~70 domains) */
  .combo { position:relative; display:inline-block; }
  #domainInput { min-width:240px; }
  .combo-menu { position:absolute; z-index:30; top:calc(100% + 4px); left:0; min-width:340px; max-height:min(60vh,380px);
    overflow:auto; background:var(--panel); border:1px solid var(--border); border-radius:8px; box-shadow:0 10px 28px rgba(0,0,0,.4); padding:4px; }
  .combo-opt { padding:6px 9px; border-radius:6px; cursor:pointer; white-space:nowrap; }
  .combo-opt:hover, .combo-opt.active { background:var(--item-active); }
  .combo-opt .desc { color:var(--dim); }
  .combo-opt .lock { color:var(--notes); font-size:11px; margin-left:6px; }
  .combo-empty { padding:6px 9px; color:var(--dim); }
  .spacer { flex:1; }
  .wrap { flex:1; display:flex; min-height:0; }
  aside { width:300px; flex:0 0 auto; display:flex; flex-direction:column; border-right:1px solid var(--border); background:var(--panel2); }
  #filter { margin:10px 12px; flex:0 0 auto; }
  #list { flex:1; overflow:auto; }
  details.top { border-top:1px solid var(--border); }
  details.top > summary { padding:8px 14px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  details.sub > summary { padding:5px 14px 5px 26px; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); }
  summary { cursor:pointer; list-style:none; user-select:none; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:'▸'; display:inline-block; width:14px; color:var(--dim); }
  details[open] > summary::before { content:'▾'; }
  .item { padding:6px 14px 7px 40px; cursor:pointer; border-left:3px solid transparent; }
  .item:hover { background:var(--item-hover); }
  .item.active { background:var(--item-active); border-left-color:var(--accent); }
  .item .pri { font-size:13.5px; color:var(--text); }
  .item .sec { font-size:12px; color:var(--dim); margin-top:1px; }
  #diagram .pele-node.navq { cursor:pointer; }
  #diagram .pele-node.navq:hover { filter:brightness(1.15); }
  #diagram svg { max-width:none !important; }
  main { flex:1; position:relative; overflow:hidden; background:var(--diagram-bg); }
  #stage { position:absolute; inset:0; cursor:grab; }
  #stage.dragging { cursor:grabbing; }
  #pane { transform-origin:0 0; padding:20px; }
  #hint { position:absolute; top:12px; left:50%; transform:translateX(-50%); color:var(--dim); font-size:13px; }
  #err { position:absolute; top:12px; left:50%; transform:translateX(-50%); color:#e0736b; font-size:13px; max-width:80%; text-align:center; }
  .notes { position:absolute; bottom:0; left:0; right:0; max-height:30%; overflow:auto; padding:8px 16px; margin:0; background:var(--panel); border-top:1px solid var(--border); color:var(--notes); font-size:12px; }
  .notes li { margin:2px 0; }
</style></head>
<body>
  <header>
    <h1>📞 Call-Flow Viewer</h1>
    <label>Domain <span class="combo" id="domainCombo"><input id="domainInput" type="search" placeholder="Loading…" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="domainMenu" disabled><div id="domainMenu" class="combo-menu" role="listbox" hidden></div></span></label>
    <span id="status" style="color:var(--dim)"></span>
    <span class="spacer"></span>
    <label>Theme <select id="theme"></select></label>
    <button id="dir" title="Toggle diagram direction (top-down / left-right)">Dir: TD</button>
    <button id="nav" title="Click a user/queue/AA/DID node to jump to it">🔗 Nav: on</button>
    <button id="zin" title="Zoom in">+</button>
    <button id="zout" title="Zoom out">−</button>
    <button id="zfit" title="Reset view">Fit</button>
    <button id="svg" disabled>Download SVG</button>
    <button id="png" disabled>Download PNG</button>
    <button id="pdf" disabled title="Print or save as PDF (Letter)">Download PDF</button>
    <button id="mmd" disabled>Copy Mermaid</button>
  </header>
  <div class="wrap">
    <aside>
      <input id="filter" type="search" placeholder="Filter by name, ext, note…" autocomplete="off">
      <div id="list"></div>
    </aside>
    <main>
      <div id="stage" title="Scroll to pan · Ctrl/⌘+scroll to zoom · drag to pan"><div id="pane"><div id="diagram"></div></div></div>
      <div id="hint">Pick a domain, then an entity on the left.</div>
      <div id="err" hidden></div>
      <ul class="notes" id="notes" hidden></ul>
    </main>
  </div>
<script type="module">
  // Pele options. responsive/autoDirection off: this page pans and zooms the diagram itself, and the
  // Dir button owns the direction.
  const RENDER = { responsive:false, autoDirection:false, fontFamily:'system-ui, sans-serif', fontSize:14 };

  // ---- SVG sanitizer (shared @dszp/netsapiens-lib source of truth) → defines cleanSvg() ----
  ${svgSanitizerScript()}

  // ---- US Letter print layout (shared @dszp/netsapiens-lib source of truth) → defines cfLetterPrint() ----
  ${letterPrintScript()}

  // ---- SVG→PNG rasterizer (shared @dszp/netsapiens-lib source of truth) → defines svgToPngBlob() ----
  ${rasterizerScript()}

  // ---- theme registry: injected from the shared @dszp/netsapiens-lib source of truth ----
  const THEMES = ${jsonForScript(THEMES)};
  const DEFAULT_LIGHT = ${jsonForScript(DEFAULT_LIGHT_THEME)}, DEFAULT_DARK = ${jsonForScript(DEFAULT_DARK_THEME)};
  const CHROME_VARS = { bg:'--bg', panel:'--panel', panel2:'--panel2', border:'--border', text:'--text', dim:'--dim', inputBg:'--input-bg', diagramBg:'--diagram-bg', itemHover:'--item-hover', itemActive:'--item-active', accent:'--accent', notes:'--notes', brand:'--brand' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const params = new URLSearchParams(location.search); // deep-link: ?domain=&kind=&ref=&dir=&theme=
  let current = { domain:'', mermaid:'', entity:null, graph:null };
  let dir = params.get('dir') === 'LR' ? 'LR' : 'TD';
  let navOn = params.get('nav') !== 'off';
  let curTheme;
  const view = { scale:1, tx:0, ty:0 };
  let dragMoved = false;

  function applyView(){ $('pane').style.transform = 'translate('+view.tx+'px,'+view.ty+'px) scale('+view.scale+')'; }
  function resetView(){ view.scale=1; view.tx=0; view.ty=0; applyView(); }

  function defaultTheme(){
    const q = params.get('theme'); if(q && THEMES[q]) return q;
    try { const s = localStorage.getItem('cf-theme'); if(s && THEMES[s]) return s; } catch(e){}
    return matchMedia('(prefers-color-scheme: light)').matches ? DEFAULT_LIGHT : DEFAULT_DARK;
  }
  function applyTheme(id, persist){
    curTheme = THEMES[id] ? id : defaultTheme();
    const t = THEMES[curTheme], c = t.chrome, root = document.documentElement.style;
    for(const k in CHROME_VARS) if(c[k] != null) root.setProperty(CHROME_VARS[k], c[k]);
    root.setProperty('color-scheme', t.mode);
    // Pele draws lines, label text and edge-label backgrounds from these.
    root.setProperty('--pele-bg', c.diagramBg); root.setProperty('--pele-fg', t.textColor);
    root.setProperty('--pele-line', t.lineColor); root.setProperty('--pele-font', 'system-ui, sans-serif');
    $('theme').value = curTheme;
    if(persist){ try { localStorage.setItem('cf-theme', curTheme); } catch(e){} }
    if(current.mermaid) render();
  }
  // Re-theme the legacy Mermaid string: apply direction and swap each classDef to the theme palette.
  // Pure string ops on our own emitted output. The result is plain Mermaid (Copy Mermaid pastes it).
  function buildSrc(){
    const t = THEMES[curTheme];
    let body = current.mermaid.replace(/^flowchart (TD|LR)/, 'flowchart '+dir);
    return body.replace(/^ {2}classDef (\\w+) .*$/gm, (m,k) => t.palette[k] ? '  classDef '+k+' '+t.palette[k] : m);
  }

  async function api(path){
    const r = await fetch(path, { headers:{ 'Accept':'application/json' } });
    if(!r.ok){ let d; try{ d=(await r.json()).error }catch{ d=r.statusText } throw new Error(d||('HTTP '+r.status)); }
    return r.json();
  }
  function showErr(m){ const e=$('err'); e.textContent='⚠ '+m; e.hidden=false; }
  function clearErr(){ $('err').hidden=true; }

  // Reset the diagram pane + flow state (used when switching/clearing the domain so a stale flow from
  // another domain never lingers).
  function clearView(){
    document.querySelectorAll('.item.active').forEach(x=>x.classList.remove('active'));
    current.mermaid=''; current.entity=null; current.graph=null;
    $('diagram').replaceChildren(); $('notes').hidden=true; clearErr();
    $('hint').hidden=false; resetView();
    $('svg').disabled=true; $('mmd').disabled=true; $('png').disabled=true; $('pdf').disabled=true;
  }

  // ---- domain combobox: type-to-filter over domain OR description (mirrors the sidebar filter) ----
  let domains=[], selectedDomain='', curMatches=[], activeIdx=-1;
  function filterDomains(){
    const raw=$('domainInput').value.trim().toLowerCase();
    const q=(raw && raw!==selectedDomain.toLowerCase()) ? raw : ''; // input showing the selection ⇒ list all
    curMatches = domains.filter(d => !q || (d.domain+' '+(d.description||'')).toLowerCase().includes(q));
  }
  function drawMenu(){
    const m=$('domainMenu');
    if(!curMatches.length){ m.innerHTML='<div class="combo-empty">No domains match</div>'; return; }
    m.innerHTML = curMatches.map((d,i)=>
      '<div class="combo-opt'+(i===activeIdx?' active':'')+'" role="option" data-i="'+i+'">'
      +'<span class="d">'+esc(d.domain)+'</span>'
      +(d.description?'<span class="desc"> — '+esc(d.description)+'</span>':'')
      +(d.locked?'<span class="lock">(locked)</span>':'')+'</div>').join('');
    m.querySelectorAll('.combo-opt').forEach(el=>{ const i=+el.dataset.i;
      el.onmousedown=(e)=>{ e.preventDefault(); pickDomain(curMatches[i].domain); }; // mousedown fires before input blur
      el.onmouseenter=()=>{ activeIdx=i; highlight(); }; });
  }
  function highlight(){ const m=$('domainMenu'); m.querySelectorAll('.combo-opt').forEach(el=>el.classList.toggle('active',+el.dataset.i===activeIdx)); const a=m.querySelector('.combo-opt.active'); if(a) a.scrollIntoView({block:'nearest'}); }
  function openMenu(){ filterDomains(); activeIdx=curMatches.length?0:-1; drawMenu(); $('domainMenu').hidden=false; $('domainInput').setAttribute('aria-expanded','true'); }
  function closeMenu(){ $('domainMenu').hidden=true; $('domainInput').setAttribute('aria-expanded','false'); }
  function pickDomain(domain){ if(!domain) return; selectedDomain=domain; $('domainInput').value=domain; closeMenu(); loadEntities(domain); }

  async function loadDomains(){
    try {
      domains = await api('/domains');
      const di=$('domainInput'); di.disabled=false;
      if(!domains.length){ di.placeholder='(no domains)'; return; }
      di.placeholder='Select or filter domain…';
      const pd=params.get('domain');
      if(pd && domains.some(d=>d.domain===pd)) pickDomain(pd);  // deep-link ?domain=
      else { selectedDomain=''; di.value=''; clearView(); }       // otherwise start blank (no auto-select)
    } catch(e){ showErr('Loading domains: '+e.message); }
  }

  function makeItem(kind, ref, primary, secondary){
    const el=document.createElement('div'); el.className='item';
    el.dataset.kind=kind; el.dataset.ref=String(ref);
    el.dataset.search=(String(primary)+' '+String(secondary||'')+' '+String(ref)).toLowerCase();
    el.innerHTML = '<div class="pri">'+esc(primary)+'</div>'+(secondary?'<div class="sec">'+esc(secondary)+'</div>':'');
    el.onclick=()=>select(el, kind, ref);
    return el;
  }
  function makeGroup(title, cls, open){
    const d=document.createElement('details'); d.className=cls; d.open=open; d.dataset.defaultOpen=open?'1':'0';
    const s=document.createElement('summary'); s.textContent=title; d.appendChild(s);
    return d;
  }

  async function loadEntities(domain){
    clearView(); current.domain=domain; $('list').innerHTML='';
    if(!domain){ $('status').textContent=''; return; }
    $('status').textContent='loading entities…';
    try {
      const ents = await api('/entities?domain='+encodeURIComponent(domain));
      $('status').textContent='';
      const list=$('list');

      // DIDs — ONE top-level group; its action types are nested subgroups.
      const dids = ents.dids || [];
      if(dids.length){
        const didGroup = makeGroup('DIDs ('+dids.length+')', 'top', true);
        const byAction=new Map();
        for(const d of dids){ const k=d.actionLabel||'Other'; if(!byAction.has(k)) byAction.set(k,[]); byAction.get(k).push(d); }
        for(const [label,arr] of byAction){
          const sub = makeGroup(label+' ('+arr.length+')', 'sub', true);
          for(const d of arr) sub.appendChild(makeItem('did', d.ref, d.label, d.desc));
          didGroup.appendChild(sub);
        }
        list.appendChild(didGroup);
      }
      // Auto Attendants / Queues / Users — sibling top-level groups. Users starts collapsed (usually many).
      for(const [kind,title,arr,open] of [['attendant','Auto Attendants',ents.attendants,true],['queue','Queues',ents.queues,true],['user','Users',ents.users,false]]){
        const items=arr||[]; if(!items.length) continue;
        const g=makeGroup(title+' ('+items.length+')', 'top', open);
        for(const it of items) g.appendChild(makeItem(kind, it.ref, it.label||it.ref, 'ext '+it.ref));
        list.appendChild(g);
      }

      applyFilter($('filter').value); // re-apply any active filter to the fresh list

      // deep-link auto-select ?kind=&ref= (open its ancestor groups first)
      const pk=params.get('kind'), pr=params.get('ref');
      const target = (pk&&pr) ? list.querySelector('.item[data-kind="'+pk+'"][data-ref="'+CSS.escape(pr)+'"]') : null;
      if(target){ for(let p=target.parentElement; p; p=p.parentElement){ if(p.tagName==='DETAILS') p.open=true; }
        select(target, target.dataset.kind, target.dataset.ref); target.scrollIntoView({block:'center'}); }
    } catch(e){ $('status').textContent=''; showErr('Loading entities: '+e.message); }
  }

  function applyFilter(q){
    q=(q||'').trim().toLowerCase();
    const list=$('list');
    list.querySelectorAll('.item').forEach(it=>{ it.style.display = (!q || it.dataset.search.includes(q)) ? '' : 'none'; });
    // hide empty groups; while filtering, open groups that contain a match, else restore default state
    list.querySelectorAll('details').forEach(d=>{
      const vis=[...d.querySelectorAll('.item')].some(it=>it.style.display!=='none');
      d.style.display = vis ? '' : 'none';
      d.open = q ? vis : (d.dataset.defaultOpen==='1');
    });
  }

  function select(el, kind, ref){
    document.querySelectorAll('.item.active').forEach(x=>x.classList.remove('active'));
    el.classList.add('active');
    const query=new URLSearchParams({ domain:current.domain, kind, ref:String(ref), dir });
    history.replaceState(null,'',location.pathname+'?'+query.toString());
    loadFlow(kind, ref);
  }

  async function loadFlow(kind, ref){
    clearErr(); $('hint').hidden=true; $('notes').hidden=true; $('diagram').textContent='Rendering…';
    try {
      const g = await api('/flow?domain='+encodeURIComponent(current.domain)+'&kind='+kind+'&ref='+encodeURIComponent(ref)+'&format=json');
      current.mermaid = g.__mermaid; current.entity = kind+'-'+ref; current.graph = g;
      await render();
      $('svg').disabled=false; $('mmd').disabled=false; $('png').disabled=false; $('pdf').disabled=false;
      if(g.notes && g.notes.length){ const n=$('notes'); n.innerHTML=g.notes.map(x=>'<li>'+esc(x)+'</li>').join(''); n.hidden=false; }
    } catch(e){ $('diagram').replaceChildren(); showErr('Rendering flow: '+e.message); }
  }

  async function render(){
    if(!current.mermaid) return;
    $('diagram').replaceChildren(cleanSvg(pele.render(buildSrc(), RENDER).svg)); resetView(); wireNav();
  }

  // Click-to-navigate (dedicated viewer only; the injected build omits this). Reconstruct which
  // diagram node (n<i>, by graph order) is a navigable entity, then wire clicks on the SVG nodes —
  // Pele marks each one g.pele-node[data-id="n<i>"].
  function navFor(n){
    let m;
    if(n.kind==='user' && (m=n.id.match(/^user_(.+)$/))) return {kind:'user', ref:m[1]};
    if(n.kind==='queue' && (m=n.id.match(/^queue_(.+)$/))) return {kind:'queue', ref:m[1]};
    if(n.kind==='attendant' && (m=n.id.match(/^aa_(\\d+)$/))) return {kind:'attendant', ref:m[1]};
    if(n.kind==='did' && (m=n.id.match(/^did_(.+)$/))) return {kind:'did', ref:m[1]};
    return null;
  }
  function wireNav(){
    const svg=$('diagram').querySelector('svg'); if(!svg || !current.graph) return;
    const nodes=current.graph.nodes||[]; const root=current.graph.rootId;
    const nav={}, title={};
    nodes.forEach((n,i)=>{ if(navOn && n.id!==root){ const t=navFor(n); if(t) nav['n'+i]=t; } if(n.title) title['n'+i]=n.title; });
    svg.querySelectorAll('g.pele-node').forEach(gel=>{
      const key=gel.getAttribute('data-id');
      if(!key) return;
      if(title[key] && !gel.querySelector(':scope>title')){ const el=document.createElementNS('http://www.w3.org/2000/svg','title'); el.textContent=title[key]; gel.insertBefore(el, gel.firstChild); }
      const t=nav[key];
      if(t){ gel.classList.add('navq'); gel.addEventListener('click',(e)=>{ if(dragMoved) return; e.stopPropagation(); navigateTo(t.kind,t.ref); }); }
    });
  }
  function navigateTo(kind,ref){
    const el=$('list').querySelector('.item[data-kind="'+kind+'"][data-ref="'+CSS.escape(String(ref))+'"]');
    if(el){ for(let p=el.parentElement;p;p=p.parentElement){ if(p.tagName==='DETAILS') p.open=true; } select(el,kind,ref); el.scrollIntoView({block:'center'}); }
    else { const q=new URLSearchParams({domain:current.domain,kind,ref:String(ref),dir}); history.replaceState(null,'',location.pathname+'?'+q.toString()); loadFlow(kind,ref); }
  }

  // pan/zoom: scroll to PAN (two-finger / wheel), Ctrl/⌘+scroll to ZOOM at cursor, drag to pan.
  const stage=$('stage');
  stage.addEventListener('wheel',(e)=>{
    e.preventDefault();
    if(e.ctrlKey || e.metaKey){
      const f=e.deltaY<0?1.1:1/1.1; const r=stage.getBoundingClientRect();
      const cx=e.clientX-r.left, cy=e.clientY-r.top;
      view.tx=cx-(cx-view.tx)*f; view.ty=cy-(cy-view.ty)*f; view.scale*=f; applyView();
    } else {
      view.tx -= e.deltaX; view.ty -= e.deltaY; applyView();
    }
  },{passive:false});
  let drag=null;
  stage.addEventListener('mousedown',(e)=>{ drag={x:e.clientX-view.tx,y:e.clientY-view.ty}; dragMoved=false; stage.classList.add('dragging'); });
  window.addEventListener('mousemove',(e)=>{ if(!drag)return; dragMoved=true; view.tx=e.clientX-drag.x; view.ty=e.clientY-drag.y; applyView(); });
  window.addEventListener('mouseup',()=>{ drag=null; stage.classList.remove('dragging'); });
  $('zin').onclick=()=>{ view.scale*=1.2; applyView(); };
  $('zout').onclick=()=>{ view.scale/=1.2; applyView(); };
  $('zfit').onclick=resetView;

  // theme picker
  { const sel=$('theme'); for(const id in THEMES){ const o=document.createElement('option'); o.value=id; o.textContent=THEMES[id].label; sel.appendChild(o); }
    sel.onchange=(e)=>applyTheme(e.target.value, true); }
  applyTheme(defaultTheme(), false);

  $('dir').textContent='Dir: '+dir;
  $('dir').onclick=()=>{ dir = dir==='TD'?'LR':'TD'; $('dir').textContent='Dir: '+dir;
    const q=new URLSearchParams(location.search); q.set('dir',dir); history.replaceState(null,'',location.pathname+'?'+q.toString());
    render(); };
  $('nav').textContent='🔗 Nav: '+(navOn?'on':'off');
  $('nav').onclick=()=>{ navOn=!navOn; $('nav').textContent='🔗 Nav: '+(navOn?'on':'off');
    const q=new URLSearchParams(location.search); q.set('nav',navOn?'on':'off'); history.replaceState(null,'',location.pathname+'?'+q.toString());
    render(); };
  $('filter').oninput=(e)=>applyFilter(e.target.value);
  { const di=$('domainInput');
    di.addEventListener('focus',()=>{ di.select(); openMenu(); });
    di.addEventListener('input',openMenu);
    di.addEventListener('blur',()=>setTimeout(()=>{ closeMenu(); di.value=selectedDomain; },150));
    di.addEventListener('keydown',(e)=>{
      if($('domainMenu').hidden && (e.key==='ArrowDown'||e.key==='ArrowUp')){ openMenu(); return; }
      if(e.key==='ArrowDown'){ e.preventDefault(); if(curMatches.length){ activeIdx=(activeIdx+1)%curMatches.length; highlight(); } }
      else if(e.key==='ArrowUp'){ e.preventDefault(); if(curMatches.length){ activeIdx=(activeIdx-1+curMatches.length)%curMatches.length; highlight(); } }
      else if(e.key==='Enter'){ e.preventDefault(); if(activeIdx>=0&&curMatches[activeIdx]) pickDomain(curMatches[activeIdx].domain); }
      else if(e.key==='Escape'){ e.preventDefault(); closeMenu(); di.value=selectedDomain; di.blur(); }
    }); }
  // Exports: a light theme saves on white (matching print and the portal); a dark one keeps its
  // diagram background, which its light text needs. The edge-label boxes are filled from --pele-bg, so
  // point it at the export background while the standalone copy is built (synchronously, before any
  // await in the exporter, so the screen never repaints with it).
  function exportBg(){ const t=THEMES[curTheme]; return t.mode==='light' ? '#ffffff' : t.chrome.diagramBg; }
  function withExportBg(svg, f){ svg.style.setProperty('--pele-bg', exportBg()); try { return f(); } finally { svg.style.removeProperty('--pele-bg'); } }
  function save(blob, ext){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(current.domain+'.'+current.entity+'.'+ext); a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000); }
  $('svg').onclick=()=>{ const s=$('diagram').querySelector('svg'); if(!s)return;
    try { save(withExportBg(s, ()=>svgToSvgBlob(s,{background:exportBg()})), 'svg'); } catch(e){ showErr('SVG export failed: '+e.message); } };
  $('mmd').onclick=async()=>{ try{ await navigator.clipboard.writeText(buildSrc()); $('mmd').textContent='Copied!'; setTimeout(()=>$('mmd').textContent='Copy Mermaid',1200);}catch{} };
  $('png').onclick=async()=>{
    const s=$('diagram').querySelector('svg'); if(!s)return;
    const btn=$('png'), label=btn.textContent; btn.disabled=true; btn.textContent='Rendering…';
    try{ save(await withExportBg(s, ()=>svgToPngBlob(s,{scale:2,background:exportBg()})), 'png'); }
    catch(e){ showErr('PNG export failed: '+e.message); }
    finally{ btn.textContent=label; btn.disabled=false; }
  };

  // Print / PDF: the library lays the current diagram out on US Letter whenever the page prints (this
  // button or the browser's own Print command); with no diagram open it prints the page as it is.
  const KIND_LABEL = { did:'DID', user:'User', queue:'Queue', attendant:'Auto Attendant' };
  cfLetterPrint(() => $('diagram').querySelector('svg'), () => {
    const e = current.graph && current.graph.entity;
    return (e ? (KIND_LABEL[e.kind] || e.kind)+': '+e.label+' · ' : '')+current.domain;
  });
  $('pdf').onclick=()=>window.print();

  loadDomains();
</script>
</body></html>`;
}
