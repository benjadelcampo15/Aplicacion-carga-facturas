const fs = require('fs');
const { extractData } = require('../src/extractor');
const dir = 'C:/Users/benja/AppData/Local/Temp/claude/C--Users-benja-Downloads-nero-nero-tickets/7bdd9464-08f6-4eae-be7a-a59e19c16df4/scratchpad/err';
(async () => {
  for (const f of ['img1.jpg', 'img4.jpg']) {
    const buf = fs.readFileSync(`${dir}/${f}`);
    const t = Date.now();
    try {
      const d = await extractData(buf, 'image/jpeg');
      console.log(`${f}: OK ${Date.now()-t}ms -> $${d.monto} | ${d.fecha} | ${d.banco_origen} | ref ${d.referencia}`);
    } catch (e) {
      console.log(`${f}: FALLO ${Date.now()-t}ms -> ${(e.message||'').slice(0,80)}`);
    }
  }
})();
