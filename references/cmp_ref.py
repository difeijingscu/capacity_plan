import pathlib, io, json, sys
from playwright.sync_api import sync_playwright

B = pathlib.Path('.').resolve()

SCEN = [
    ('long_agent', 'deepseek_v3', 32768, 1024, 50, 5000, 50, 131072),
    ('rag',        'glm5_3_flash', 8192, 1024, 100, 3000, 50, 32768),
    ('think',      'deepseek_r1', 2048, 8192, 500, 8000, 80, 32768),
]

def setv(pg, eid, val):
    pg.evaluate("""([id,val])=>{const e=document.getElementById(id); if(!e) return;
      e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));}""", [eid, val])

out = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, model, plen, olen, conc, ttft, tpot, ctx in SCEN:
        pg = b.new_page(viewport={'width': 1500, 'height': 1200})
        pg.goto((B / 'inference.original.html').as_uri()); pg.wait_for_timeout(800)
        setv(pg, 'chipSel', '910c'); pg.wait_for_timeout(250)
        setv(pg, 'presetModel', model); pg.wait_for_timeout(400)
        setv(pg, 'precSel', 'int8'); pg.wait_for_timeout(150)
        setv(pg, 'sceneSelect', 'custom'); pg.wait_for_timeout(150)
        for k, v in [('promptLen', plen), ('outputLen', olen), ('concurrency', conc),
                     ('ttftTarget', ttft), ('tpotTarget', tpot), ('maxCtx', ctx)]:
            setv(pg, k, v)
        pg.wait_for_timeout(500)
        pg.evaluate("setDeployPd('mixed')"); pg.wait_for_timeout(700)
        r = pg.evaluate("""()=>{
          const bars={};
          document.querySelectorAll('.hero-bar-row').forEach(row=>{
            const lbl=row.querySelector('.hero-bar-lbl'); const num=row.lastElementChild;
            if(lbl) bars[lbl.textContent.replace('★','').trim()] = (num.textContent||'').trim();
          });
          const tab=[];
          document.querySelectorAll('table').forEach(t=>{
            [...t.querySelectorAll('tr')].forEach(tr=>{
              tab.push([...tr.children].map(c=>c.textContent.trim().replace(/\\s+/g,' ')));
            });
          });
          const g=id=>{const e=document.getElementById(id);return e?e.textContent.trim().replace(/\\s+/g,' '):''};
          return {bars, hero:g('heroNum'), bn:g('heroBottleneck'), dep:g('depSummary'),
                  floor:g('capFloorNote'), tab, inputs:{conc:g('concurrency'),plen:g('promptLen')}};
        }""")
        out[name] = r
        print('==', name, model, 'conc', conc)
        print('  bars', json.dumps(r['bars'], ensure_ascii=False))
        print('  hero', r['hero'], '|', r['bn'])
        print('  dep', r['dep'][:120])
        print('  floor', r['floor'][:200])
        pg.close()
    b.close()

io.open('ref_cmp.json', 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=1))
