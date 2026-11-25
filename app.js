'use strict';
/* Assistidos: lista de acompanhamento da Brasil TV.
   Tudo fica no localStorage deste navegador. A box avisa por um canal ntfy.sh. */

const CHAVE = 'assistidos.v1';
const TIPOS = { serie: 'Série', anime: 'Anime', filme: 'Filme' };
const INTERVALO_MS = 20000;

// ---------- estado ----------
function estadoInicial() {
  return {
    itens: [],
    recebidos: [],
    cfg: { servidor: 'https://ntfy.sh', topico: novoTopico(), ativo: true, ultimoId: null },
  };
}
function novoTopico() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return 'assistidos-' + Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}
function carregar() {
  try {
    const s = JSON.parse(localStorage.getItem(CHAVE));
    if (s && Array.isArray(s.itens)) {
      const base = estadoInicial();
      return { ...base, ...s, cfg: { ...base.cfg, ...(s.cfg || {}) }, recebidos: s.recebidos || [] };
    }
  } catch (e) { /* armazenamento indisponível */ }
  return estadoInicial();
}
let E = carregar();
function salvar() {
  try { localStorage.setItem(CHAVE, JSON.stringify(E)); } catch (e) { avisar('Não consegui salvar neste navegador.'); }
}

// ---------- utilidades ----------
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function normalizar(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function quando(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
let timerAviso;
function avisar(txt) {
  const el = $('#aviso');
  el.textContent = txt; el.hidden = false;
  clearTimeout(timerAviso); timerAviso = setTimeout(() => (el.hidden = true), 4000);
}
const chaveEp = (t, e) => t + 'x' + e;
function totalEps(it) { return it.tipo === 'filme' ? 1 : it.temporadas.reduce((a, n) => a + n, 0); }
function vistos(it) { return it.tipo === 'filme' ? (it.visto ? 1 : 0) : Object.keys(it.eps || {}).length; }

// ---------- leitura do texto que a box manda ----------
/* Aceita JSON {"titulo","temporada","episodio"} ou texto livre como
   "One Piece T2 E15", "Naruto S01E05", "Dark - Temporada 2 Episódio 3", "Bleach Ep. 12". */
function interpretar(msg) {
  let titulo = String(msg || '').trim(), temp = null, ep = null;
  try {
    const j = JSON.parse(titulo);
    if (j && typeof j === 'object') {
      titulo = String(j.titulo || j.title || '');
      temp = j.temporada != null ? +j.temporada : null;
      ep = j.episodio != null ? +j.episodio : null;
      return { titulo, temp, ep };
    }
  } catch (e) { /* texto livre */ }
  const pad = [
    /\bs(\d{1,2})\s*e(\d{1,4})\b/i,
    /\bt(\d{1,2})\s*[:.\-]?\s*e(?:p(?:is[oó]dio)?)?\.?\s*(\d{1,4})\b/i,
    /\btemporada\s*(\d{1,2})\D{0,20}?ep(?:is[oó]dio)?\.?\s*(\d{1,4})\b/i,
    /\b(\d{1,2})\s*x\s*(\d{1,4})\b/i,
  ];
  for (const p of pad) {
    const m = titulo.match(p);
    if (m) { temp = +m[1]; ep = +m[2]; titulo = titulo.slice(0, m.index); break; }
  }
  if (ep == null) {
    const m = titulo.match(/\b(?:ep(?:is[oó]dio)?|cap(?:[ií]tulo)?)\.?\s*(\d{1,4})\b/i);
    if (m) { ep = +m[1]; titulo = titulo.slice(0, m.index); }
  }
  return { titulo: titulo.replace(/[\s\-–—:|·,]+$/, '').trim(), temp, ep };
}
function encontrarItem(textoOriginal, tituloLimpo) {
  const alvo = ' ' + normalizar(textoOriginal) + ' ';
  const limpo = normalizar(tituloLimpo);
  let melhor = null, tam = 0;
  for (const it of E.itens) {
    for (const nome of [it.titulo, ...(it.apelidos || [])]) {
      const n = normalizar(nome);
      if (!n) continue;
      if ((n === limpo || alvo.includes(' ' + n + ' ')) && n.length > tam) { melhor = it; tam = n.length; }
    }
  }
  return melhor;
}
/* Episódio sem temporada: conta em sequência (útil para anime com numeração absoluta). */
function localizarEp(it, temp, ep) {
  if (temp != null) return { t: temp, e: ep };
  let resto = ep;
  for (let i = 0; i < it.temporadas.length; i++) {
    if (resto <= it.temporadas[i]) return { t: i + 1, e: resto };
    resto -= it.temporadas[i];
  }
  return { t: 1, e: ep };
}
function garantirEp(it, t, e) {
  while (it.temporadas.length < t) it.temporadas.push(e);
  if (it.temporadas[t - 1] < e) it.temporadas[t - 1] = e;
}
/* Marca a partir de um aviso. Devolve texto descritivo ou null se não achou o título. */
function aplicarAviso(texto, ts, itemForcado) {
  const r = interpretar(texto);
  const it = itemForcado || encontrarItem(texto, r.titulo);
  if (!it) return null;
  if (it.tipo === 'filme') {
    it.visto = it.visto || ts;
    it.recente = 'filme';
    return it.titulo;
  }
  if (r.ep == null) return it.titulo + ' (sem número de episódio, nada marcado)';
  const { t, e } = localizarEp(it, r.temp, r.ep);
  garantirEp(it, t, e);
  it.eps = it.eps || {};
  if (!it.eps[chaveEp(t, e)]) it.eps[chaveEp(t, e)] = ts;
  it.recente = chaveEp(t, e);
  it.atualizado = ts;
  return `${it.titulo} T${t} E${e}`;
}

// ---------- render ----------
let filtro = 'todos', busca = '', abertos = new Set();
function render() {
  renderLista(); renderRecebidos(); renderAjustes();
}
function renderLista() {
  const el = $('#lista');
  const q = normalizar(busca);
  const itens = E.itens
    .filter(it => filtro === 'todos' || it.tipo === filtro)
    .filter(it => !q || normalizar([it.titulo, ...(it.apelidos || [])].join(' ')).includes(q))
    .sort((a, b) => (b.atualizado || b.criado) - (a.atualizado || a.criado));
  if (!E.itens.length) { el.innerHTML = '<p class="vazio">Sua lista está vazia. Adicione uma série, anime ou filme acima.</p>'; return; }
  if (!itens.length) { el.innerHTML = '<p class="vazio">Nada encontrado.</p>'; return; }
  el.innerHTML = itens.map(it => {
    const tot = totalEps(it), v = vistos(it), pct = tot ? Math.round(v / tot * 100) : 0;
    const sub = it.tipo === 'filme' ? (it.visto ? 'Assistido em ' + quando(it.visto) : 'Não assistido')
      : `${v} de ${tot} episódios` + (proximo(it) ? ` · próximo: ${proximo(it)}` : ' · em dia');
    return `<article class="item" data-id="${it.id}">
      <div class="item-cab" data-acao="abrir">
        <div class="tit"><strong>${esc(it.titulo)}</strong><span class="sub">${esc(sub)}</span></div>
        <span class="tag">${TIPOS[it.tipo]}</span>
      </div>
      <div class="barra"><div style="width:${pct}%"></div></div>
      ${abertos.has(it.id) ? corpo(it) : ''}
    </article>`;
  }).join('');
}
function proximo(it) {
  for (let t = 1; t <= it.temporadas.length; t++)
    for (let e = 1; e <= it.temporadas[t - 1]; e++)
      if (!it.eps || !it.eps[chaveEp(t, e)]) return `T${t} E${e}`;
  return '';
}
function corpo(it) {
  if (it.tipo === 'filme') {
    return `<div class="item-corpo">
      <label class="filme-ok"><input type="checkbox" data-acao="filme" ${it.visto ? 'checked' : ''}> Já assisti</label>
      ${acoes(it)}</div>`;
  }
  const temps = it.temporadas.map((n, i) => {
    const t = i + 1;
    let eps = '';
    for (let e = 1; e <= n; e++) {
      const k = chaveEp(t, e), ok = it.eps && it.eps[k];
      eps += `<button class="ep${ok ? ' ok' : ''}${it.recente === k ? ' recente' : ''}" data-acao="ep" data-t="${t}" data-e="${e}"
        title="${ok ? 'Assistido em ' + quando(ok) : 'Marcar como assistido'}">${e}</button>`;
    }
    const v = Array.from({ length: n }, (_, j) => it.eps && it.eps[chaveEp(t, j + 1)]).filter(Boolean).length;
    return `<div class="temp"><div class="temp-cab"><span>Temporada ${t} · ${v}/${n}</span>
      <span><button data-acao="tempTudo" data-t="${t}">${v === n ? 'Desmarcar todos' : 'Marcar todos'}</button>
      <button data-acao="epMais" data-t="${t}" title="Adicionar episódio">+ ep</button></span></div>
      <div class="eps">${eps}</div></div>`;
  }).join('');
  return `<div class="item-corpo">${temps}${acoes(it)}</div>`;
}
function acoes(it) {
  return `<div class="acoes">
    ${it.tipo !== 'filme' ? '<button data-acao="tempMais">+ temporada</button>' : ''}
    <button data-acao="apelidos">Outros nomes${it.apelidos && it.apelidos.length ? ' (' + it.apelidos.length + ')' : ''}</button>
    <button data-acao="renomear">Renomear</button>
    <button data-acao="remover" class="perigo">Remover</button>
  </div>`;
}
function renderRecebidos() {
  const pend = E.recebidos.filter(r => !r.resolvido);
  const b = $('#contRecebidos');
  b.hidden = !pend.length; b.textContent = pend.length;
  const el = $('#recebidos');
  if (!E.recebidos.length) { el.innerHTML = '<p class="vazio">Nada recebido ainda.</p>'; return; }
  const opcoes = E.itens.map(it => `<option value="${it.id}">${esc(it.titulo)}</option>`).join('');
  el.innerHTML = E.recebidos.slice().reverse().slice(0, 100).map(r => `
    <div class="receb" data-rid="${r.id}">
      <div class="txt">${esc(r.texto)}<small>${quando(r.ts)} · ${r.resolvido ? '✓ ' + esc(r.resolvido) : 'não reconhecido'}</small></div>
      ${r.resolvido ? '' : `<select data-acao="ligar"><option value="">Ligar a…</option>${opcoes}<option value="__novo">+ Criar novo título</option></select>
      <button data-acao="ignorar">Ignorar</button>`}
    </div>`).join('');
}
function renderAjustes() {
  const c = E.cfg;
  if (document.activeElement !== $('#cfgTopico')) $('#cfgTopico').value = c.topico;
  if (document.activeElement !== $('#cfgServidor')) $('#cfgServidor').value = c.servidor;
  $('#cfgAtivo').checked = c.ativo;
  $('#cfgUrl').textContent = urlCanal();
}
const urlCanal = () => E.cfg.servidor.replace(/\/+$/, '') + '/' + encodeURIComponent(E.cfg.topico);
function status(txt, classe) { const s = $('#status'); s.textContent = '● box: ' + txt; s.className = 'status ' + (classe || ''); }

// ---------- eventos da interface ----------
$('.abas').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-aba]'); if (!b) return;
  document.querySelectorAll('.abas button').forEach(x => x.classList.toggle('ativa', x === b));
  ['lista', 'recebidos', 'ajustes'].forEach(a => ($('#aba-' + a).hidden = a !== b.dataset.aba));
});
$('#novoTipo').addEventListener('change', () => ($('#linhaEps').hidden = $('#novoTipo').value === 'filme'));
$('#formNovo').addEventListener('submit', ev => {
  ev.preventDefault();
  const titulo = $('#novoTitulo').value.trim(); if (!titulo) return;
  const tipo = $('#novoTipo').value;
  const nt = Math.max(1, Math.min(99, +$('#novoTemps').value || 1));
  const ne = Math.max(1, Math.min(2000, +$('#novoEps').value || 1));
  const it = {
    id: id(), tipo, titulo, criado: Date.now(),
    apelidos: $('#novoApelidos').value.split(',').map(s => s.trim()).filter(Boolean),
    temporadas: tipo === 'filme' ? [] : Array(nt).fill(ne), eps: {}, visto: null,
  };
  E.itens.push(it); abertos.add(it.id); salvar();
  ev.target.reset(); $('#linhaEps').hidden = false;
  render(); avisar(`"${titulo}" adicionado.`);
});
$('#busca').addEventListener('input', ev => { busca = ev.target.value; renderLista(); });
$('#filtroTipo').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  filtro = b.dataset.f;
  document.querySelectorAll('#filtroTipo button').forEach(x => x.classList.toggle('ativa', x === b));
  renderLista();
});
$('#lista').addEventListener('click', ev => {
  const alvo = ev.target.closest('[data-acao]'); if (!alvo) return;
  const it = E.itens.find(x => x.id === alvo.closest('.item').dataset.id); if (!it) return;
  const a = alvo.dataset.acao, t = +alvo.dataset.t, e = +alvo.dataset.e;
  if (a === 'abrir') { abertos.has(it.id) ? abertos.delete(it.id) : abertos.add(it.id); return renderLista(); }
  if (a === 'filme') { it.visto = alvo.checked ? Date.now() : null; }
  else if (a === 'ep') {
    const k = chaveEp(t, e); it.eps = it.eps || {};
    if (it.eps[k]) delete it.eps[k]; else { it.eps[k] = Date.now(); it.recente = k; }
  } else if (a === 'tempTudo') {
    const n = it.temporadas[t - 1], todos = Array.from({ length: n }, (_, j) => it.eps[chaveEp(t, j + 1)]).every(Boolean);
    for (let j = 1; j <= n; j++) { const k = chaveEp(t, j); if (todos) delete it.eps[k]; else if (!it.eps[k]) it.eps[k] = Date.now(); }
  } else if (a === 'epMais') { it.temporadas[t - 1]++; }
  else if (a === 'tempMais') { it.temporadas.push(it.temporadas[it.temporadas.length - 1] || 10); }
  else if (a === 'apelidos') {
    const v = prompt('Outros nomes que aparecem na TV para "' + it.titulo + '" (separados por vírgula):', (it.apelidos || []).join(', '));
    if (v === null) return; it.apelidos = v.split(',').map(s => s.trim()).filter(Boolean);
  } else if (a === 'renomear') {
    const v = prompt('Novo título:', it.titulo); if (!v || !v.trim()) return; it.titulo = v.trim();
  } else if (a === 'remover') {
    if (!confirm('Remover "' + it.titulo + '" e o histórico dele?')) return;
    E.itens = E.itens.filter(x => x !== it);
  }
  if (a !== 'remover') it.atualizado = Date.now();
  salvar(); render();
});
$('#recebidos').addEventListener('change', ev => {
  const sel = ev.target.closest('select[data-acao="ligar"]'); if (!sel || !sel.value) return;
  const r = E.recebidos.find(x => x.id === sel.closest('.receb').dataset.rid); if (!r) return;
  let it;
  if (sel.value === '__novo') {
    const p = interpretar(r.texto);
    const titulo = prompt('Título para a lista:', p.titulo || r.texto); if (!titulo) { sel.value = ''; return; }
    it = { id: id(), tipo: p.ep != null ? 'serie' : 'filme', titulo: titulo.trim(), criado: Date.now(), apelidos: [], temporadas: p.ep != null ? [Math.max(p.ep, 10)] : [], eps: {}, visto: null };
    E.itens.push(it);
  } else {
    it = E.itens.find(x => x.id === sel.value);
    const p = interpretar(r.texto);
    if (p.titulo && normalizar(p.titulo) !== normalizar(it.titulo) && !(it.apelidos || []).some(n => normalizar(n) === normalizar(p.titulo)))
      (it.apelidos = it.apelidos || []).push(p.titulo); // aprende o nome que a TV usa
  }
  r.resolvido = aplicarAviso(r.texto, r.ts, it) || it.titulo;
  salvar(); render(); avisar('Marcado: ' + r.resolvido);
});
$('#recebidos').addEventListener('click', ev => {
  if (!ev.target.matches('[data-acao="ignorar"]')) return;
  const r = E.recebidos.find(x => x.id === ev.target.closest('.receb').dataset.rid);
  if (r) { r.resolvido = 'ignorado'; salvar(); renderRecebidos(); }
});
$('#cfgTopico').addEventListener('change', ev => { const v = ev.target.value.trim(); if (v) { E.cfg.topico = v; E.cfg.ultimoId = null; salvar(); renderAjustes(); buscar(); } });
$('#cfgServidor').addEventListener('change', ev => { const v = ev.target.value.trim(); if (/^https:\/\//.test(v)) { E.cfg.servidor = v; E.cfg.ultimoId = null; salvar(); renderAjustes(); buscar(); } else avisar('O servidor precisa começar com https://'); });
$('#cfgAtivo').addEventListener('change', ev => { E.cfg.ativo = ev.target.checked; salvar(); ciclo(); });
$('#btnNovoTopico').addEventListener('click', () => {
  if (!confirm('Gerar outro canal? A box vai precisar ser configurada com o novo endereço.')) return;
  E.cfg.topico = novoTopico(); E.cfg.ultimoId = null; salvar(); renderAjustes();
});
$('#btnTeste').addEventListener('click', async () => {
  const txt = $('#testeTexto').value.trim(); if (!txt) return;
  $('#testeResultado').textContent = 'Enviando…';
  try {
    const r = await fetch(urlCanal(), { method: 'POST', body: txt });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    $('#testeResultado').textContent = 'Enviado. Buscando…';
    await buscar();
    $('#testeResultado').textContent = 'Enviado e recebido. Veja a lista ou a aba "Da box".';
  } catch (e) { $('#testeResultado').textContent = 'Falhou: ' + e.message; }
});
$('#btnExportar').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(E, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'assistidos-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#arqImportar').addEventListener('change', async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.itens)) throw new Error('arquivo sem lista');
    if (!confirm(`Substituir a lista atual por ${d.itens.length} títulos do arquivo?`)) return;
    const base = estadoInicial();
    E = { ...base, ...d, cfg: { ...base.cfg, ...(d.cfg || {}) }, recebidos: d.recebidos || [] };
    salvar(); render(); avisar('Lista importada.');
  } catch (e) { avisar('Arquivo inválido: ' + e.message); }
  ev.target.value = '';
});

// ---------- leitura do canal da box ----------
let buscando = false;
async function buscar() {
  if (!E.cfg.ativo || buscando) return;
  buscando = true;
  try {
    const since = E.cfg.ultimoId || '12h';
    const r = await fetch(urlCanal() + '/json?poll=1&since=' + encodeURIComponent(since), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const linhas = (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } });
    const marcados = [];
    for (const m of linhas) {
      if (!m || m.event !== 'message') continue;
      E.cfg.ultimoId = m.id;
      if (E.recebidos.some(x => x.id === m.id)) continue;
      const ts = (m.time || Date.now() / 1000) * 1000;
      const texto = String(m.message || '').slice(0, 300);
      const res = aplicarAviso(texto, ts);
      E.recebidos.push({ id: m.id, texto, ts, resolvido: res });
      if (res) marcados.push(res);
    }
    if (E.recebidos.length > 300) E.recebidos = E.recebidos.slice(-300);
    salvar(); render();
    if (marcados.length) avisar('Marcado pela box: ' + marcados.join(', '));
    status('conectado · ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), 'on');
  } catch (e) {
    status('sem conexão', 'erro');
  } finally { buscando = false; }
}
let timer;
function ciclo() {
  clearInterval(timer);
  if (!E.cfg.ativo) { status('desligado'); return; }
  buscar(); timer = setInterval(buscar, INTERVALO_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) buscar(); });

salvar();
render();
ciclo();
