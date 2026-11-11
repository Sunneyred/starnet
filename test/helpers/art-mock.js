/* test/helpers/art-mock.js — a scripted model provider that PLAYS the art line (Art Studio Phase 5).

   It speaks the OpenRouter chat-completions wire the sidecar already uses, costs nothing, and needs no key. For each
   request it works out which of the four art steps is asking (from that step's own shipped instructions) and answers
   with the next REAL tool call of that step — so every print file, preview, mockup and record a run leaves behind is
   made by the product's own tools. Used by test/art-line.e2e.test.js and dev/gallery-shots.mjs (the live Gallery).

   The script, per design: STRATEGIST looks and plans tee-front (black) + sticker-4x4; DESIGNER makes both; INSPECTOR
   looks, sends the tee back once, passes the sticker; DESIGNER remakes the tee with an outline; INSPECTOR passes it;
   MOCKUP renders both. An "[Art redo: …]" or "[Art resume: …]" item is carried on from, never re-planned.

   startArtMock(pricePerPromptToken) -> Promise<{ server, S, base }>   S = { requests, seen, vision, toolsOffered, toolErrors } */
'use strict';
const http = require('http');
const fs = require('fs');
const WorkflowLine = require('../../frontend/app/workflowline.js');

const HOST = '127.0.0.1';
const ROLES = ['STRATEGIST', 'DESIGNER', 'INSPECTOR', 'MOCKUP'];
const BRIEFS = {}; for (const r of ROLES) BRIEFS[r] = WorkflowLine.defaultBrief(r);
const mock_last = S => S.seen[S.seen.length - 1];

function startArtMock(price) {
  const S = { requests: [], seen: [], vision: 0, passes: {}, toolsOffered: {}, toolErrors: [] };
  const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('\n') : '');
  // which step is this? A handed-on stage names its own instructions after "YOUR STANDING BRIEF FOR THIS STATION:" (a looped
  // stage's prompt also quotes earlier stages, so "anywhere in the prompt" is not enough); the entry stage carries its
  // instructions in its system prompt.
  const MARK = 'YOUR STANDING BRIEF FOR THIS STATION:';
  const roleOf = all => {
    const i = all.lastIndexOf(MARK), own = i >= 0 ? all.slice(i + MARK.length, i + MARK.length + 400) : all;
    return ROLES.find(r => own.indexOf(BRIEFS[r].does.slice(80, 170)) >= 0) || null;
  };
  function decide(body) {
    const msgs = (body && body.messages) || [];
    const all = msgs.map(m => textOf(m && m.content)).join('\n');
    let lastUser = -1; msgs.forEach((m, i) => { if (m && m.role === 'user') lastUser = i; });
    const done = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool');
    const offeredNames = ((body && body.tools) || []).map(t => (t.function && t.function.name) || t.name);
    // every stage first settles its Task Brief (the station's own rule for consequential work), then works
    const briefTool = offeredNames.find(n => /^brief[._]proceed$/.test(n));
    const step = done.length - (briefTool ? 1 : 0);
    if (process.env.ART_E2E_DEBUG && done.length) console.log('[mock] ' + (roleOf(all) || '?') + ' saw: ' + textOf(done[done.length - 1].content).replace(/\s+/g, ' ').slice(0, 400));
    for (const t of done) { const s = textOf(t.content); if (/^(error|refused|denied)|not permitted|needs your approval|was not approved/i.test(s)) S.toolErrors.push(s.slice(0, 300)); }
    const role = roleOf(all);
    const ids = all.match(/dsn_[a-z0-9]{6,40}/g) || [], id = ids[ids.length - 1] || '';
    if (role) S.toolsOffered[role] = offeredNames;
    S.seen.push({ role, id, step });
    if (process.env.ART_E2E_DUMP && step < 0) { S.dumpN = (S.dumpN || 0) + 1; fs.writeFileSync('/tmp/art-dump-' + S.dumpN + '.txt', msgs.map(m => '### ' + m.role + '\n' + textOf(m.content)).join('\n\n')); }
    const key = role + ':' + id, pass = S.passes[key] || 0;
    const end = text => { S.passes[key] = pass + 1; return { text }; };
    const tool = (name, args) => ({ tool: { name, args } });
    const redo = /\[Art redo:/.test(all), resume = /\[Art resume:/.test(all);
    if (!role || !id) return { text: 'nothing to do' };
    if (step < 0) return tool(briefTool, { objective: role + ': do this step for design ' + id, deliverable: 'the step\'s result, recorded on the design' });
    if (role === 'STRATEGIST') {
      if (resume) return [tool('design_get', { design: id })][step] || end('[Art resume: continuing] The plan for ' + id + ' is already recorded. Design id: ' + id);
      if (redo) return end('Art redo for ' + id + ': the plan stands. Remake tee-front following the owner\'s note. [Art redo: continuing] Design id: ' + id);
      const pv = (all.match(/Preview to LOOK at: (\S+)/) || [])[1];
      return [tool('design_get', { design: id }), tool('image_analyze', { image: pv, prompt: 'What is in this design?' }), tool('product_catalog', {}),
        tool('product_plan_submit', { design: id,
          analysis: { summary: 'A magenta block with a near-black square on a white page, flat and graphic.', subjects: ['block', 'square'], mood: 'bold', palette: ['magenta', 'black'], textInArt: '' },
          products: [{ productId: 'tee-front', fabricId: 'black', score: 88, why: 'A bold flat shape reads clearly across a shirt front.', titleIdeas: ['Magenta Block Tee'] },
            { productId: 'sticker-4x4', score: 71, why: 'A simple outline die-cuts cleanly at sticker size.' }],
          skipped: [{ productId: 'dad-hat-front', reason: 'The square composition is too tall for a cap front.' }] })][step]
        || end('Planned design ' + id + ': tee-front on black, then sticker-4x4. Design id: ' + id);
    }
    if (role === 'DESIGNER') {
      const first = [tool('art_prepare', { design: id, product: 'tee-front', fabric: 'black' }), tool('art_prepare', { design: id, product: 'sticker-4x4' })];
      const again = [tool('art_prepare', { design: id, product: 'tee-front', fabric: 'black', recolor: 'outline' })];
      return ((resume || (pass === 0 && !redo)) ? first : again)[step] || end('Print files made for design ' + id + (redo ? ' [Art redo: continuing]' : '') + (resume ? ' [Art resume: continuing]' : '') + '. Design id: ' + id);
    }
    if (role === 'INSPECTOR') {
      const first = [tool('design_get', { design: id }), tool('image_analyze', { image: 'designs/' + id + '/print/tee-front-black.preview.jpg', prompt: 'Does the art stand out from the fabric?' }),
        tool('design_review', { design: id, product: 'tee-front', verdict: 'redo', notes: 'The near-black square vanishes into the black fabric: remake with recolor outline.' }),
        tool('design_review', { design: id, product: 'sticker-4x4', verdict: 'pass' })];
      const again = [tool('design_review', { design: id, product: 'tee-front', verdict: 'pass', notes: 'The outline separates it from the fabric now.' })];
      if (resume) return [tool('design_review', { design: id, product: 'tee-front', verdict: 'pass' }), tool('design_review', { design: id, product: 'sticker-4x4', verdict: 'pass' })][step]
        || end('[Art resume: continuing] Checked design ' + id + '. Design id: ' + id + '\ntee-front: pass\nsticker-4x4: pass\nVERDICT: approved');
      const firstLook = pass === 0 && !redo;
      return (firstLook ? first : again)[step]
        || end('Checked design ' + id + (redo ? ' [Art redo: continuing]' : '') + '. Design id: ' + id + '\n' + (firstLook ? 'tee-front: redo\nsticker-4x4: pass\nVERDICT: revise' : 'tee-front: pass\nVERDICT: approved'));
    }
    return [tool('design_get', { design: id }), tool('mockup_render', { design: id, product: 'tee-front', fabric: 'black' }), ...(redo ? [] : [tool('mockup_render', { design: id, product: 'sticker-4x4' })])][step]
      || end('Mockups rendered for design ' + id + '. It is waiting for the owner in the Gallery. Nothing was published.');
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 200000, pricing: { prompt: String(price), completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
        S.requests.push(body);
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        const isVision = ((body && body.messages) || []).some(m => Array.isArray(m && m.content) && m.content.some(p => p && p.type === 'image_url'));
        if (isVision || !(body && body.stream)) {
          if (isVision) S.vision++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A magenta rectangle with a small near-black square, on a plain background.' }, finish_reason: 'stop' }], usage }));
        }
        const turn = decide(body);
        if (process.env.ART_E2E_DEBUG) { const l = mock_last(S); console.log('[mock] -> ' + JSON.stringify(l) + ' ' + (turn.tool ? turn.tool.name : 'TEXT ' + String(turn.text).slice(0, 60))); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (turn.tool) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + S.requests.length, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, S, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}


module.exports = { startArtMock, ROLES, BRIEFS };
