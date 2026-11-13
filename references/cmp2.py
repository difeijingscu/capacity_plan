import pathlib, json
from playwright.sync_api import sync_playwright
B = pathlib.Path('.').resolve()
SCEN = [('long_agent','deepseek_v3',32768,1024,50,5000,50,131072),
        ('rag','glm5_3_flash',8192,1024,100,3000,50,32768),
        ('think','deepseek_r1',2048,8192,500,8000,80,32768)]
def setv(pg,eid,val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""",[eid,val])
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,model,plen,olen,conc,ttft,tpot,ctx in SCEN:
        pg=b.new_page(viewport={'width':1500,'height':1200})
        pg.goto((B/'inference.original.html').as_uri()); pg.wait_for_timeout(800)
        setv(pg,'chipSel','910c'); pg.wait_for_timeout(250)
        setv(pg,'presetModel',model); pg.wait_for_timeout(400)
        setv(pg,'precSel','int8'); pg.wait_for_timeout(150)
        setv(pg,'sceneSelect','custom'); pg.wait_for_timeout(150)
        for k,v in [('promptLen',plen),('outputLen',olen),('ttftTarget',ttft),('tpotTarget',tpot),('maxCtx',ctx),('concurrency',conc)]:
            setv(pg,k,v)
        pg.wait_for_timeout(500); pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(700)
        r=pg.evaluate("""()=>{
          const bars={}; document.querySelectorAll('.hero-bar-row').forEach(row=>{const l=row.querySelector('.hero-bar-lbl'); const n=row.lastElementChild; if(l) bars[l.textContent.replace('★','').trim()]=(n.textContent||'').trim();});
          let sla=[]; document.querySelectorAll('table').forEach(t=>{const hd=(t.querySelector('tr')||{}).textContent||''; if(hd.indexOf('SLA 指标')>=0){[...t.querySelectorAll('tr')].forEach(tr=>sla.push([...tr.children].map(c=>c.textContent.trim().replace(/\\s+/g,' '))));}});
          const g=id=>{const e=document.getElementById(id);return e?e.textContent.trim().replace(/\\s+/g,' '):''};
          return {bars, hero:g('heroNum'), ttft:(sla[1]||[])[2]||'', tpot:(sla[2]||[])[2]||'', conc:(sla[3]||[])[2]||'', dep:g('depSummary')};
        }""")
        print(name, json.dumps(r,ensure_ascii=False))
        pg.close()
    b.close()
