import pathlib, json
from playwright.sync_api import sync_playwright
B = pathlib.Path('.').resolve()
def setv(pg, eid, val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""", [eid, val])
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1200})
    pg.goto((B/'inference.original.html').as_uri()); pg.wait_for_timeout(800)
    setv(pg,'chipSel','910c'); pg.wait_for_timeout(250)
    setv(pg,'precSel','int8'); pg.wait_for_timeout(150)
    setv(pg,'sceneSelect','custom'); pg.wait_for_timeout(150)
    for k,v in [('promptLen',32768),('outputLen',1024),('ttftTarget',20000),('tpotTarget',50),('maxCtx',131072),('concurrency',1)]:
        setv(pg,k,v)
    pg.wait_for_timeout(400); pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(300)
    def read():
        return pg.evaluate("""()=>{
          const bars={}; document.querySelectorAll('.hero-bar-row').forEach(row=>{const l=row.querySelector('.hero-bar-lbl'); const n=row.lastElementChild; if(l) bars[l.textContent.replace('★','').trim()]=(n.textContent||'').trim();});
          let sla=[]; document.querySelectorAll('table').forEach(t=>{const hd=(t.querySelector('tr')||{}).textContent||''; if(hd.indexOf('SLA 指标')>=0){[...t.querySelectorAll('tr')].forEach(tr=>sla.push([...tr.children].map(c=>c.textContent.trim().replace(/\\s+/g,' '))));}});
          return {bars, ttft:(sla[1]||[])[2]||''};
        }""")
    for m in ['qwen25_72b','qwen3_32b','deepseek_v3','glm5_3_flash']:
        setv(pg,'presetModel',m); pg.wait_for_timeout(800)
        print(m, json.dumps(read(),ensure_ascii=False))
    b.close()
