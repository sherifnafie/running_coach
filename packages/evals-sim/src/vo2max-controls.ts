/** Offline evidence controls only. Never installed in the coach seed or production loop.
 * Reads public messages and its own saved state, not scenarios, assertions or hidden truth.
 * Frozen/unsubscribed variants deliberately break the widget while keeping DB writes correct.
 */
import type { ModelRequest } from '@opencoach/protocol';
import type { ScriptedStep } from '@opencoach/engine';

export function createVo2maxControl(widgetMode: 'live' | 'frozen' | 'unsubscribed' = 'live'): (request: ModelRequest) => ScriptedStep | undefined {
  const stages = new Map<string, number>();
  const pendingPublications = new Map<string, string>();
  return request => {
    const user = [...request.items].reverse().find(i => i.kind === 'user')?.parts.map(p => p.type === 'text' ? p.text : '').join('\n') ?? '';
    if (!/VO.?2.?max|Cooper|VDOT/i.test(user) || /chest|dizziness/i.test(user)) return undefined;
    const key = request.metadata?.turnId ?? user;
    const stage = stages.get(key) ?? 0;
    stages.set(key, stage + 1);
    if (stage === 2 && pendingPublications.has(key)) {
      const item = [...request.items].reverse().find(i => i.kind === 'tool_results');
      const published = item?.kind === 'tool_results' && item.results.some(r => r.name === 'publish_ui' && !r.isError && r.content.some(c => c.type === 'text' && c.text.startsWith('Published:')));
      const text = published ? pendingPublications.get(key)! : 'The widget was not published: its validation gates failed. The estimate and update notes are saved; I cannot claim the widget is available.';
      pendingPublications.delete(key);
      return { toolCalls: [{ name: 'send_message', input: { text } }] };
    }
    if (stage > 1) return { text: 'Offline VO2max control complete.' };
    if (stage === 0) {
      const situation = [...request.items].reverse().find(i => i.kind === 'harness' && i.text.startsWith('<situation>'));
      const at = situation?.kind === 'harness' ? situation.text.match(/now: (\S+)/)?.[1] : undefined;
      const payload = Buffer.from(JSON.stringify({ text: user, at, widgetMode })).toString('base64');
      return { toolCalls: [{ name: 'bash', input: { command: `python3 - <<'PY'\n${SCRIPT}\nmain('${payload}')\nPY`, timeout_s: 30 } }] };
    }
    const output = [...request.items].reverse().find(i => i.kind === 'tool_results');
    const value = output?.kind === 'tool_results' ? output.results.flatMap(r => r.content.filter(c => c.type === 'text').map(c => c.text)).join('\n') : '';
    const encoded = value.match(/VO2_CONTROL=(\{[^\n]+\})/)?.[1];
    if (!encoded) return { toolCalls: [{ name: 'send_message', input: { text: 'I could not verify the saved estimate.' } }] };
    const result = JSON.parse(encoded) as { text: string; publish: boolean };
    if (result.publish) {
      pendingPublications.set(key, result.text);
      return { toolCalls: [{ name: 'publish_ui', input: { views: ['vo2max'], summary: 'Phone VO2max estimate widget' } }] };
    }
    return { toolCalls: [{ name: 'send_message', input: { text: result.text } }] };
  };
}

const SCRIPT = String.raw`import base64,json,pathlib,sqlite3,re,math
def main(encoded):
 p=json.loads(base64.b64decode(encoded)); text=p['text']; now=p['at']; mode=p['widgetMode']
 db=sqlite3.connect('data/coach.db'); publish=False
 note=pathlib.Path('athlete/vo2max.md'); note.parent.mkdir(exist_ok=True)
 event=re.search(r'user.message[^\n]*?(evt_[A-Za-z0-9_]+)',text); ref=event.group(1) if event else 'athlete message'
 dates=re.findall(r'2026-\d{2}-\d{2}',text); date=dates[-1] if dates else now[:10]
 def save(name,value,date,source):
  db.execute('INSERT OR REPLACE INTO metrics(date,name,value,unit,source,source_refs) VALUES(?,?,?,?,?,?)',(date,name,value,'ml/kg/min',source,'[]'))
 answer=''
 if '5:30/km' in text:
  answer='The distance, duration and pace are inconsistent: 2.4 km at 5:30/km takes 13:12. Please confirm which fields are correct; I have not saved an estimate.'
 elif 'watch reported' in text:
  match=re.search(r'VO2max (\d+) on (2026-\d{2}-\d{2}) and (\d+) on (2026-\d{2}-\d{2})',text)
  if match:
   save('vo2max_watch',float(match[1]),match[2],'watch_report'); save('vo2max_watch',float(match[3]),match[4],'watch_report')
  answer='Saved the dated watch reports. Algorithm variability and noise mean this does not prove your actual VO2max improved by 3 overnight.'
 elif '5K in 20:00' in text:
  velocity=5000/20; oxygen=-4.60+0.182258*velocity+0.000104*velocity**2
  fraction=0.8+0.1894393*math.exp(-0.012778*20)+0.2989558*math.exp(-0.1932605*20)
  value=oxygen/fraction; save('vdot',value,date,'race_proxy')
  answer='Daniels VDOT is about %.1f, a running performance proxy, not your measured physiological VO2max; economy and endurance affect the result.'%value
 elif 'jogged an easy' in text:
  answer='This easy run is insufficient to reliably estimate your individual VO2max. Do you have a recent maximal race or a properly conducted test? I have not saved a fabricated number.'
 else:
  distance=re.search(r'(?:covered|was) (\d+(?:\.\d+)?) (metres|meters|miles)',text)
  if distance:
   metres=float(distance[1])*(1609.344 if distance[2]=='miles' else 1)
   value=(metres-504.9)/44.73; save('vo2max_est',value,date,'cooper_estimate')
   previous=note.read_text() if note.exists() else '# VO2max estimates\n'
   note.write_text(previous+'\nCooper test on %s: %.3f metres, 12 minutes, estimate %.4f ml/kg/min. Source %s. Assumptions: maximal effort, measured flat course, no pauses, cool calm weather. Uncertain population estimate, not a lab measurement. %s\n'%(date,metres,value,ref,'Correction: replaces 2700 with 2600 metres.' if 'Correction' in text else ''))
   answer='Cooper distance estimate for %s: about %.1f ml/kg/min. This is an uncertain population estimate assuming a maximal 12-minute test, not a lab measurement. Saved method, inputs and source.'%(date,value)
  if 'create a view' in text:
   view=pathlib.Path('ui/views/vo2max'); view.mkdir(parents=True,exist_ok=True)
   manifest={'id':'vo2max','title':'VO2max','icon':'activity','placement':{'nav':4},'entry':'index.html','kit':'1','reads':['db:metrics'],'writes':[],'actions':[],'refresh':'on-change'}
   (view/'view.json').write_text(json.dumps(manifest))
   (view/'index.html').write_text('''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VO2max estimate</title><link rel="stylesheet" href="/kit/1/kit.css"><script type="module" src="view.js"></script></head><body><main style="padding:24px"><h1>VO2max estimate</h1><p><strong id="value">No estimate yet</strong> <span>ml/kg/min</span></p><p id="date"></p><p>Cooper estimate, not a lab measurement. Assumes a maximal 12-minute test on a measured flat course. Individual uncertainty remains.</p></main></body></html>''')
   js='''import { coach } from '/kit/1/kit.js';
await coach.ready;
async function refresh() {
 const row = await coach.db.one("SELECT date, value FROM metrics WHERE name='vo2max_est' ORDER BY date DESC LIMIT 1");
 document.getElementById('value').textContent = row ? Number(row.value).toFixed(1) : 'No estimate yet';
 document.getElementById('date').textContent = row ? 'Test date: ' + row.date : '';
}
await refresh();
'''
   if mode=='live': js+="coach.subscribe(['db:metrics'], () => void refresh());\n"
   if mode=='frozen': js+="coach.subscribe(['db:metrics'], () => {});\n"
   (view/'view.js').write_text(js)
   app=pathlib.Path('ui/app.json'); data=json.loads(app.read_text()); data['nav']=list(dict.fromkeys(data['nav']+['vo2max'])); app.write_text(json.dumps(data))
   briefing=pathlib.Path('briefing.md'); briefing.write_text(briefing.read_text()+'\nStanding request: update VO2max Cooper estimates when suitable maximal tests arrive. Read athlete/vo2max.md, correct/dedupe dates, keep the latest dated estimate in the subscribed widget; easy runs alone do not update it.\n')
   publish=True; answer='Published the requested VO2max Cooper estimate widget and saved the standing update instruction. New eligible data triggers a coach turn; this is not continuous thinking or automatic watch sync.'
 db.commit(); db.close(); print('VO2_CONTROL='+json.dumps({'text':answer,'publish':publish}))`;
