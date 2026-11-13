import pathlib, json
from playwright.sync_api import sync_playwright
B = pathlib.Path('.').resolve()
def setv(pg, eid, val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""", [eid, val])
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':1500,'height':1400})
    pg.goto((B/'inference.original.html').as_uri()); pg.wait_for_timeout(800)
    setv(pg,'chipSel','910c'); pg.wait_for_timeout(250)
    setv(pg,'presetModel','deepseek_v3'); pg.wait_for_timeout(400)
    setv(pg,'precSel','int8'); pg.wait_for_timeout(150)
    setv(pg,'sceneSelect','custom'); pg.wait_for_timeout(150)
    for k,v in [('promptLen',32768),('outputLen',1024),('ttftTarget',5000),('tpotTarget',50),('maxCtx',131072),('concurrency',50)]:
        setv(pg,k,v)
    pg.wait_for_timeout(500); pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(600)
    for i in ['dbb-p','dbb-d','dbr-p','dbr-d']:
        loc=pg.locator('#'+i)
        if loc.count():
            t=loc.first.inner_text()
            print('====',i,'====')
            print(t[:1800])
    b.close()
