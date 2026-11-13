import pathlib, json
from playwright.sync_api import sync_playwright
B = pathlib.Path('.').resolve()
def setv(pg, eid, val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""", [eid, val])
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1200})
    pg.goto((B/'inference.original.html').as_uri()); pg.wait_for_timeout(800)
    setv(pg,'presetModel','deepseek_v3'); pg.wait_for_timeout(400)
    setv(pg,'precSel','int8'); pg.wait_for_timeout(150)
    setv(pg,'sceneSelect','custom'); pg.wait_for_timeout(150)
    for k,v in [('promptLen',32768),('outputLen',1024),('ttftTarget',5000),('tpotTarget',50),('maxCtx',131072),('concurrency',1)]:
        setv(pg,k,v)
    pg.wait_for_timeout(400); pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(400)
    def read():
        return pg.evaluate("""()=>{
          const bars={}; document.querySelectorAll('.hero-bar-row').forEach(row=>{const l=row.querySelector('.hero-bar-lbl'); const n=row.lastElementChild; if(l) bars[l.textContent.replace('★','').trim()]=(n.textContent||'').trim();});
          let sla=[]; document.querySelectorAll('table').forEach(t=>{const hd=(t.querySelector('tr')||{}).textContent||''; if(hd.indexOf('SLA 指标')>=0){[...t.querySelectorAll('tr')].forEach(tr=>sla.push([...tr.children].map(c=>c.textContent.trim().replace(/\\s+/g,' '))));}});
          const g=id=>{const e=document.getElementById(id);return e?e.textContent.trim().replace(/\\s+/g,' '):''};
          return {bars, hero:g('heroNum'), ttft:(sla[1]||[])[2]||'', tpot:(sla[2]||[])[2]||''};
        }""")
    for chip in ['910c','950(547T)','950(425T)','910b']:
        setv(pg,'chipSel',chip); pg.wait_for_timeout(800)
        print(chip, json.dumps(read(),ensure_ascii=False))
    b.close()
