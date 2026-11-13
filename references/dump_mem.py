import pathlib, json
from playwright.sync_api import sync_playwright
B = pathlib.Path('.').resolve()
def setv(pg, eid, val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""", [eid, val])
CFG = [('think','deepseek_r1',2048,8192,500,8000,80,32768),
       ('rag','glm5_3_flash',8192,1024,100,3000,50,32768)]
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1400})
    for name, model, plen, olen, conc, ttft, tpot, ctx in CFG:
        pg.goto((B/'inference.original.html').as_uri()); pg.wait_for_timeout(800)
        setv(pg,'chipSel','910c'); pg.wait_for_timeout(250)
        setv(pg,'presetModel',model); pg.wait_for_timeout(400)
        setv(pg,'precSel','int8'); pg.wait_for_timeout(150)
        setv(pg,'sceneSelect','custom'); pg.wait_for_timeout(150)
        for k,v in [('promptLen',plen),('outputLen',olen),('ttftTarget',ttft),('tpotTarget',tpot),('maxCtx',ctx),('concurrency',conc)]:
            setv(pg,k,v)
        pg.wait_for_timeout(500); pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(600)
        print('########', name)
        for i in ['dbb-k','dbb-p','dbb-d']:
            loc=pg.locator('#'+i)
            if loc.count():
                print('----',i)
                print(loc.first.inner_text()[:1400])
    b.close()
