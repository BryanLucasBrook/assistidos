'use strict';
/* Assistidos: lista de acompanhamento da Brasil TV.
   Dados no localStorage. Catálogo: TVmaze (séries/animes), AniList (animes) e Wikipédia (filmes).
   A box avisa por um canal ntfy.sh. */

const CHAVE = 'assistidos.v1';
const TIPOS = { serie: 'Série', anime: 'Anime', filme: 'Filme' };
const INTERVALO_MS = 20000;
const TOPICO_PADRAO = 'assistidos-w2nqm5vud';

// ---------- estado ----------
function estadoInicial() {
  return { itens: [], recebidos: [], cfg: { servidor: 'https://ntfy.sh', topico: TOPICO_PADRAO, ativo: true, ultimoId: null } };
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
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const semHtml = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const chaveEp = (t, e) => t + 'x' + e;
function quando(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
let timerAviso;
function avisar(txt) {
  const el = $('#aviso'); el.textContent = txt; el.hidden = false;
  clearTimeout(timerAviso); timerAviso = setTimeout(() => (el.hidden = true), 4000);
}
const totalEps = it => it.tipo === 'filme' ? 1 : it.temporadas.reduce((a, n) => a + n, 0);
const vistos = it => it.tipo === 'filme' ? (it.visto ? 1 : 0) : Object.keys(it.eps || {}).length;
function proximo(it) {
  for (let t = 1; t <= it.temporadas.length; t++)
    for (let e = 1; e <= it.temporadas[t - 1]; e++)
      if (!it.eps[chaveEp(t, e)]) return { t, e };
  return null;
}
function rotuloEp(it, t, e) {
  const n = it.nomes && it.nomes[chaveEp(t, e)];
  return `T${t} E${e}` + (n ? ' · ' + n : '');
}
function capaHtml(it, classe = 'capa') {
  if (it.capa) return `<img class="${classe}" src="${esc(it.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  const ini = (it.titulo || '?').trim().slice(0, 1).toUpperCase();
  return `<div class="${classe} vazia">${esc(ini)}</div>`;
}

// ---------- catálogo ----------
async function json(url, opt) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function ehAnime(show) {
  return (show.genres || []).includes('Anime') || (show.type === 'Animation' && show.language === 'Japanese');
}
async function buscarSeries(q) {
  const tv = json('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q)).then(rs => rs.slice(0, 10).map(({ show: s }) => ({
    fonte: 'tvmaze', fid: s.id, titulo: s.name, tipo: ehAnime(s) ? 'anime' : 'serie',
    ano: (s.premiered || '').slice(0, 4), capa: s.image && (s.image.medium || s.image.original),
    sinopse: semHtml(s.summary), extra: [s.network && s.network.name, s.webChannel && s.webChannel.name, s.status === 'Ended' ? 'Finalizada' : s.status === 'Running' ? 'Em exibição' : ''].filter(Boolean).join(' · '),
  }))).catch(() => []);
  const al = json('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: 'query($q:String){Page(perPage:6){media(search:$q,type:ANIME,sort:SEARCH_MATCH){id title{romaji english} synonyms episodes format seasonYear coverImage{medium large} description(asHtml:false)}}}', variables: { q } }),
  }).then(r => r.data.Page.media.map(m => ({
    fonte: 'anilist', fid: m.id, titulo: m.title.english || m.title.romaji, apelidos: [m.title.romaji, m.title.english, ...(m.synonyms || [])].filter(Boolean),
    tipo: m.format === 'MOVIE' ? 'filme' : 'anime', ano: m.seasonYear || '', capa: m.coverImage && (m.coverImage.large || m.coverImage.medium),
    sinopse: semHtml(m.description), eps: m.episodes, extra: 'Anime' + (m.format === 'MOVIE' ? ' · filme' : m.episodes ? ` · ${m.episodes} episódios` : ''),
  }))).catch(() => []);
  const [a, b] = await Promise.all([tv, al]);
  // TVmaze primeiro (tem temporadas e nomes dos episódios); AniList completa animes que faltarem
  const vistosTit = new Set(a.map(x => normalizar(x.titulo)));
  for (const m of b) { // leva os nomes japoneses/alternativos da AniList para o resultado do TVmaze
    const nomes = [m.titulo, ...(m.apelidos || [])].map(normalizar);
    const alvo = a.find(x => nomes.includes(normalizar(x.titulo)));
    if (alvo) alvo.apelidos = [...new Set([...(alvo.apelidos || []), ...(m.apelidos || []), m.titulo])].filter(n => n !== alvo.titulo);
  }
  return [...a, ...b.filter(x => !vistosTit.has(normalizar(x.titulo)) && !(x.apelidos || []).some(n => vistosTit.has(normalizar(n))))];
}
async function buscarFilmes(q) {
  const url = 'https://pt.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=10&prop=pageimages|description|extracts&exintro=1&explaintext=1&exsentences=2&piprop=thumbnail&pithumbsize=240&gsrsearch='
    + encodeURIComponent(q + ' filme');
  const r = await json(url);
  const pags = Object.values((r.query && r.query.pages) || {}).sort((a, b) => a.index - b.index);
  return pags.filter(p => /filme|longa|film/i.test(p.description || '') || /filme/i.test(p.title)).concat(pags.filter(p => !/filme|longa|film/i.test(p.description || '') && !/filme/i.test(p.title)))
    .slice(0, 10).map(p => ({
      fonte: 'wikipedia', fid: p.pageid, titulo: p.title.replace(/\s*\((filme|filme de \d{4}|\d{4})\)\s*$/i, ''), tipo: 'filme',
      ano: ((p.title + ' ' + (p.description || '')).match(/\b(19|20)\d{2}\b/) || [''])[0],
      capa: p.thumbnail && p.thumbnail.source, sinopse: p.extract || '', extra: p.description || '',
    }));
}
async function detalhesTvmaze(id) {
  const eps = await json(`https://api.tvmaze.com/shows/${id}/episodes`);
  const temporadas = [], nomes = {};
  for (const ep of eps) {
    if (ep.number == null || ep.type === 'insignificant_special') continue;
    const t = ep.season;
    temporadas[t - 1] = Math.max(temporadas[t - 1] || 0, ep.number);
    if (ep.name && !/^Episode \d+$/i.test(ep.name)) nomes[chaveEp(t, ep.number)] = ep.name;
  }
  return { temporadas: Array.from(temporadas, n => n || 1), nomes };
}

// ---------- leitura do texto que a box manda ----------
/* Aceita JSON {"titulo","temporada","episodio"} ou texto como
   "One Piece T2 E15", "Naruto S01E05", "Dark - Temporada 2 Episódio 3", "Bleach Ep. 12". */
function interpretar(msg) {
  let titulo = String(msg || '').trim(), temp = null, ep = null;
  try {
    const j = JSON.parse(titulo);
    if (j && typeof j === 'object') return { titulo: String(j.titulo || j.title || ''), temp: j.temporada != null ? +j.temporada : null, ep: j.episodio != null ? +j.episodio : null };
  } catch (e) { /* texto livre */ }
  const pad = [
    /\bs(\d{1,2})\s*[-–:.]?\s*e(\d{1,4})\b/i,
    /\btemp\.?\s*(\d{1,2})\s*[-–:.]?\s*(?:ep\.?\s*)?(\d{1,4})\b/i, // Brasil TV: "Black Clover Temp.5 8"
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
  const alvo = ' ' + normalizar(textoOriginal) + ' ', limpo = normalizar(tituloLimpo);
  let melhor = null, tam = 0;
  for (const it of E.itens) for (const nome of [it.titulo, ...(it.apelidos || [])]) {
    const n = normalizar(nome);
    if (n && (n === limpo || alvo.includes(' ' + n + ' ')) && n.length > tam) { melhor = it; tam = n.length; }
  }
  return melhor;
}
function localizarEp(it, temp, ep) {
  if (temp != null) return { t: temp, e: ep };
  let resto = ep; // numeração absoluta (comum em anime)
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
function aplicarAviso(texto, ts, itemForcado) {
  const r = interpretar(texto);
  const it = itemForcado || encontrarItem(texto, r.titulo);
  if (!it) return null;
  it.atualizado = ts;
  if (it.tipo === 'filme') { it.visto = it.visto || ts; return it.titulo; }
  if (r.ep == null) return it.titulo + ' (sem número de episódio)';
  const { t, e } = localizarEp(it, r.temp, r.ep);
  garantirEp(it, t, e);
  if (!it.eps[chaveEp(t, e)]) it.eps[chaveEp(t, e)] = ts;
  it.recente = chaveEp(t, e);
  return `${it.titulo} T${t} E${e}`;
}

// ---------- lista ----------
let filtro = 'todos', busca = '';
function render() { renderLista(); renderRecebidos(); renderAjustes(); if (detId) renderDetalhe(); }
function renderLista() {
  const el = $('#lista');
  if (!E.itens.length) {
    el.innerHTML = `<div class="vazio"><p>Sua lista está vazia.</p><p class="dica">Adicione o que você está assistindo. A capa, as temporadas e os episódios vêm sozinhos.</p>
      <button class="primario" data-abrir-add>+ Adicionar o primeiro</button></div>`;
    return;
  }
  const q = normalizar(busca);
  const itens = E.itens
    .filter(it => filtro === 'todos' || it.tipo === filtro)
    .filter(it => !q || normalizar([it.titulo, ...(it.apelidos || [])].join(' ')).includes(q))
    .sort((a, b) => (b.atualizado || b.criado) - (a.atualizado || a.criado));
  if (!itens.length) { el.innerHTML = '<p class="vazio">Nada encontrado.</p>'; return; }
  const grupos = { ass: [], fila: [], fim: [] };
  for (const it of itens) {
    const v = vistos(it), tot = totalEps(it);
    (v === 0 ? grupos.fila : v >= tot ? grupos.fim : grupos.ass).push(it);
  }
  const secao = (tit, lst) => lst.length ? `<div class="secao"><h2>${tit}</h2><div class="grade">${lst.map(card).join('')}</div></div>` : '';
  el.innerHTML = secao('Continuar assistindo', grupos.ass) + secao('Quero ver', grupos.fila) + secao('Concluídos', grupos.fim);
}
function card(it) {
  const tot = totalEps(it), v = vistos(it), pct = tot ? Math.round(v / tot * 100) : 0;
  const p = it.tipo !== 'filme' && proximo(it);
  const linha = it.tipo === 'filme' ? (it.visto ? 'Assistido' : 'Não assistido')
    : p ? `Próximo: T${p.t} E${p.e}` : 'Em dia';
  return `<button class="card" data-det="${it.id}">
    ${capaHtml(it)}
    <div class="barra"><div style="width:${pct}%"></div></div>
    <div class="card-info"><span class="tag">${TIPOS[it.tipo]}${it.ano ? ' · ' + esc(it.ano) : ''}</span>
      <strong>${esc(it.titulo)}</strong>
      <small class="prox">${esc(linha)}</small>
      ${it.tipo !== 'filme' ? `<small>${v} de ${tot} episódios</small>` : ''}</div>
  </button>`;
}
$('#lista').addEventListener('click', ev => {
  if (ev.target.closest('[data-abrir-add]')) return abrirAdd();
  const c = ev.target.closest('[data-det]'); if (c) abrirDetalhe(c.dataset.det);
});
$('#busca').addEventListener('input', ev => { busca = ev.target.value; renderLista(); });
$('#filtroTipo').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  filtro = b.dataset.f;
  document.querySelectorAll('#filtroTipo button').forEach(x => x.classList.toggle('ativa', x === b));
  renderLista();
});

// ---------- painéis ----------
function abrirPainel(id) { $(id).hidden = false; document.body.classList.add('travado'); }
function fecharPaineis() {
  ['#painelAdd', '#painelDet'].forEach(p => ($(p).hidden = true));
  document.body.classList.remove('travado'); detId = null;
}
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') fecharPaineis(); });
document.querySelectorAll('.painel').forEach(p => p.addEventListener('click', ev => {
  if (ev.target === p || ev.target.closest('[data-fechar]')) fecharPaineis();
}));

// ---------- adicionar ----------
let tipoBusca = 'serie', resultados = [], seqBusca = 0, timerBusca;
function abrirAdd() {
  abrirPainel('#painelAdd');
  $('#buscaCatalogo').value = ''; $('#resultados').innerHTML = '<p class="dica">Digite pelo menos 2 letras.</p>';
  setTimeout(() => $('#buscaCatalogo').focus(), 30);
}
$('#btnAdicionar').addEventListener('click', abrirAdd);
$('#buscaTipo').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  tipoBusca = b.dataset.t;
  document.querySelectorAll('#buscaTipo button').forEach(x => x.classList.toggle('ativa', x === b));
  $('#buscaCatalogo').placeholder = tipoBusca === 'filme' ? 'Nome do filme (ex.: Duna, Cidade de Deus)' : 'Nome da série ou anime (ex.: Frieren, Dark)';
  pesquisar(); $('#buscaCatalogo').focus();
});
$('#buscaCatalogo').addEventListener('input', () => { clearTimeout(timerBusca); timerBusca = setTimeout(pesquisar, 350); });
async function pesquisar() {
  const q = $('#buscaCatalogo').value.trim(), el = $('#resultados'), seq = ++seqBusca;
  if (q.length < 2) { el.innerHTML = '<p class="dica">Digite pelo menos 2 letras.</p>'; return; }
  el.innerHTML = '<p class="carregando">Buscando…</p>';
  try {
    const r = tipoBusca === 'filme' ? await buscarFilmes(q) : await buscarSeries(q);
    if (seq !== seqBusca) return;
    resultados = r;
    if (!r.length) { el.innerHTML = '<p class="dica">Nada encontrado. Tente outro nome, em inglês, ou adicione sem buscar logo abaixo.</p>'; return; }
    const jaTem = new Set(E.itens.map(i => i.fonte + ':' + i.fid));
    el.innerHTML = r.map((x, i) => `<button class="res" data-i="${i}">
      ${x.capa ? `<img src="${esc(x.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="capa vazia">${esc(x.titulo.slice(0, 1))}</div>`}
      <div><strong>${esc(x.titulo)}</strong><small>${[TIPOS[x.tipo], x.ano, x.extra].filter(Boolean).map(esc).join(' · ')}</small>
      ${jaTem.has(x.fonte + ':' + x.fid) ? '<small> · já está na lista</small>' : ''}</div></button>`).join('');
  } catch (e) {
    if (seq === seqBusca) el.innerHTML = '<p class="dica">Não consegui buscar agora (sem internet?). Use "adicionar sem buscar".</p>';
  }
}
$('#resultados').addEventListener('click', async ev => {
  const b = ev.target.closest('.res'); if (!b) return;
  const x = resultados[+b.dataset.i]; if (!x) return;
  const existente = E.itens.find(i => i.fonte === x.fonte && i.fid === x.fid);
  if (existente) { fecharPaineis(); return abrirDetalhe(existente.id); }
  b.disabled = true; b.querySelector('small').textContent = 'Carregando episódios…';
  const it = {
    id: novoId(), tipo: x.tipo, titulo: x.titulo, apelidos: (x.apelidos || []).filter(n => n !== x.titulo),
    capa: x.capa || null, ano: x.ano || '', sinopse: x.sinopse || '', fonte: x.fonte, fid: x.fid,
    temporadas: [], nomes: {}, eps: {}, visto: null, criado: Date.now(),
  };
  if (x.tipo !== 'filme') {
    try {
      if (x.fonte === 'tvmaze') Object.assign(it, await detalhesTvmaze(x.fid));
      else it.temporadas = [x.eps || 12];
    } catch (e) { it.temporadas = [x.eps || 12]; }
    if (!it.temporadas.length) it.temporadas = [x.eps || 12];
  }
  E.itens.push(it); salvar(); fecharPaineis(); render(); abrirDetalhe(it.id);
  avisar(`"${it.titulo}" adicionado. Toque nos episódios que você já viu.`);
});
$('#novoTipo').addEventListener('change', () => ($('#linhaEps').hidden = $('#novoTipo').value === 'filme'));
$('#formNovo').addEventListener('submit', ev => {
  ev.preventDefault();
  const titulo = $('#novoTitulo').value.trim(); if (!titulo) return;
  const tipo = $('#novoTipo').value;
  const nt = Math.max(1, Math.min(99, +$('#novoTemps').value || 1)), ne = Math.max(1, Math.min(2000, +$('#novoEps').value || 1));
  const it = { id: novoId(), tipo, titulo, apelidos: [], capa: null, ano: '', sinopse: '', fonte: 'manual', fid: null,
    temporadas: tipo === 'filme' ? [] : Array(nt).fill(ne), nomes: {}, eps: {}, visto: null, criado: Date.now() };
  E.itens.push(it); salvar(); ev.target.reset(); $('#linhaEps').hidden = false;
  fecharPaineis(); render(); abrirDetalhe(it.id);
});

// ---------- detalhe ----------
let detId = null, detTemp = 1;
function abrirDetalhe(id) {
  const it = E.itens.find(i => i.id === id); if (!it) return;
  detId = id;
  const p = it.tipo !== 'filme' && proximo(it);
  detTemp = p ? p.t : 1;
  renderDetalhe(); abrirPainel('#painelDet');
}
function renderDetalhe() {
  const it = E.itens.find(i => i.id === detId); if (!it) return fecharPaineis();
  const v = vistos(it), tot = totalEps(it), p = it.tipo !== 'filme' && proximo(it);
  let corpo = '';
  if (it.tipo === 'filme') {
    corpo = `<div class="filme-ok"><button class="${it.visto ? '' : 'primario'}" data-a="filme">${it.visto ? '✓ Assistido em ' + quando(it.visto) + ' (desmarcar)' : 'Marcar como assistido'}</button></div>`;
  } else {
    if (detTemp > it.temporadas.length) detTemp = it.temporadas.length;
    const n = it.temporadas[detTemp - 1];
    const vt = Array.from({ length: n }, (_, j) => it.eps[chaveEp(detTemp, j + 1)]).filter(Boolean).length;
    let lis = '';
    for (let e = 1; e <= n; e++) {
      const k = chaveEp(detTemp, e), ok = it.eps[k], nome = (it.nomes && it.nomes[k]) || 'Episódio ' + e;
      lis += `<li class="ep${ok ? ' ok' : ''}${it.recente === k ? ' recente' : ''}" data-a="ep" data-e="${e}">
        <span class="num">${e}</span><span class="nome">${esc(nome)}</span>
        ${ok ? `<span class="quando">${quando(ok)}</span>` : `<button class="ate discreto" data-a="ate" data-e="${e}" title="Marcar todos até este">até aqui</button>`}
        <span class="marca">✓</span></li>`;
    }
    corpo = `
      <div class="temps">${it.temporadas.map((nn, i) => `<button data-a="temp" data-t="${i + 1}" class="${i + 1 === detTemp ? 'ativa' : ''}">Temporada ${i + 1}</button>`).join('')}
        <button data-a="tempMais" class="discreto" title="Adicionar temporada">+</button></div>
      <div class="det-acao" style="padding-top:10px">
        <button data-a="tempTudo">${vt === n ? 'Desmarcar temporada' : 'Marcar temporada toda'}</button>
        <button data-a="epMais" class="discreto">+ episódio</button>
      </div>
      <ul class="eps">${lis}</ul>`;
  }
  $('#detalhe').innerHTML = `
    <div class="det-topo">
      ${capaHtml(it)}
      <div class="det-info">
        <span class="tag">${TIPOS[it.tipo]}${it.ano ? ' · ' + esc(it.ano) : ''}</span>
        <h2>${esc(it.titulo)}</h2>
        <div class="sub">${it.tipo === 'filme' ? (it.visto ? 'Assistido' : 'Não assistido') : `${v} de ${tot} episódios` + (p ? ` · próximo: ${esc(rotuloEp(it, p.t, p.e))}` : ' · em dia')}</div>
        ${it.sinopse ? `<div class="sinopse">${esc(it.sinopse)}</div>` : ''}
      </div>
      <button class="fechar" data-fechar aria-label="Fechar">✕</button>
    </div>
    ${p ? `<div class="det-acao"><button class="primario" data-a="proximo">✓ Marcar ${esc(`T${p.t} E${p.e}`)} como visto</button></div>` : ''}
    ${corpo}
    <details class="det-rodape">
      <summary>Editar</summary>
      <label class="bloco">Título <input data-campo="titulo" value="${esc(it.titulo)}"></label>
      <label class="bloco">Nomes que aparecem na Brasil TV (separados por vírgula)
        <input data-campo="apelidos" value="${esc((it.apelidos || []).join(', '))}" placeholder="Ex.: Sousou no Frieren"></label>
      <div class="linha"><select data-campo="tipo">${Object.entries(TIPOS).map(([k, n]) => `<option value="${k}" ${k === it.tipo ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button data-a="remover" class="perigo">Remover da lista</button></div>
    </details>`;
}
$('#detalhe').addEventListener('click', ev => {
  const alvo = ev.target.closest('[data-a]'); if (!alvo) return;
  ev.stopPropagation();
  const it = E.itens.find(i => i.id === detId); if (!it) return;
  const a = alvo.dataset.a, e = +alvo.dataset.e, t = detTemp, agora = Date.now();
  if (a === 'filme') it.visto = it.visto ? null : agora;
  else if (a === 'ep') { const k = chaveEp(t, e); if (it.eps[k]) delete it.eps[k]; else { it.eps[k] = agora; it.recente = k; } }
  else if (a === 'ate') {
    for (let tt = 1; tt <= t; tt++) for (let ee = 1; ee <= (tt < t ? it.temporadas[tt - 1] : e); ee++) { const k = chaveEp(tt, ee); if (!it.eps[k]) it.eps[k] = agora; }
    it.recente = chaveEp(t, e);
  } else if (a === 'proximo') { const p = proximo(it); if (p) { it.eps[chaveEp(p.t, p.e)] = agora; it.recente = chaveEp(p.t, p.e); detTemp = p.t; } }
  else if (a === 'temp') { detTemp = +alvo.dataset.t; return renderDetalhe(); }
  else if (a === 'tempTudo') {
    const n = it.temporadas[t - 1], todos = Array.from({ length: n }, (_, j) => it.eps[chaveEp(t, j + 1)]).every(Boolean);
    for (let j = 1; j <= n; j++) { const k = chaveEp(t, j); if (todos) delete it.eps[k]; else if (!it.eps[k]) it.eps[k] = agora; }
  } else if (a === 'epMais') it.temporadas[t - 1]++;
  else if (a === 'tempMais') { it.temporadas.push(it.temporadas[it.temporadas.length - 1] || 12); detTemp = it.temporadas.length; }
  else if (a === 'remover') {
    if (!confirm(`Remover "${it.titulo}" e o histórico dele?`)) return;
    E.itens = E.itens.filter(x => x !== it); salvar(); fecharPaineis(); return render();
  } else return;
  it.atualizado = agora; salvar(); render();
});
$('#detalhe').addEventListener('change', ev => {
  const c = ev.target.dataset.campo; if (!c) return;
  const it = E.itens.find(i => i.id === detId); if (!it) return;
  const v = ev.target.value.trim();
  if (c === 'titulo' && v) it.titulo = v;
  if (c === 'apelidos') it.apelidos = v.split(',').map(s => s.trim()).filter(Boolean);
  if (c === 'tipo') { it.tipo = v; if (v !== 'filme' && !it.temporadas.length) it.temporadas = [12]; }
  salvar(); render(); avisar('Salvo.');
});

// ---------- recebidos ----------
function renderRecebidos() {
  const pend = E.recebidos.filter(r => !r.resolvido);
  const b = $('#contRecebidos'); b.hidden = !pend.length; b.textContent = pend.length;
  const el = $('#recebidos');
  if (!E.recebidos.length) { el.innerHTML = '<p class="vazio">Nada recebido ainda.</p>'; return; }
  const opcoes = E.itens.map(it => `<option value="${it.id}">${esc(it.titulo)}</option>`).join('');
  el.innerHTML = E.recebidos.slice().reverse().slice(0, 100).map(r => `
    <div class="receb" data-rid="${esc(r.id)}">
      <div class="txt">${esc(r.texto)}<small>${quando(r.ts)} · ${r.resolvido ? '✓ ' + esc(r.resolvido) : 'não reconhecido'}</small></div>
      ${r.resolvido ? '' : `<select data-acao="ligar"><option value="">Ligar a…</option>${opcoes}</select><button data-acao="ignorar">Ignorar</button>`}
    </div>`).join('');
}
$('#recebidos').addEventListener('change', ev => {
  const sel = ev.target.closest('select[data-acao="ligar"]'); if (!sel || !sel.value) return;
  const r = E.recebidos.find(x => x.id === sel.closest('.receb').dataset.rid);
  const it = E.itens.find(x => x.id === sel.value); if (!r || !it) return;
  const p = interpretar(r.texto);
  if (p.titulo && normalizar(p.titulo) !== normalizar(it.titulo) && !(it.apelidos || []).some(n => normalizar(n) === normalizar(p.titulo)))
    (it.apelidos = it.apelidos || []).push(p.titulo); // aprende o nome que a TV usa
  r.resolvido = aplicarAviso(r.texto, r.ts, it) || it.titulo;
  // reaplica outros avisos pendentes que agora batem
  for (const o of E.recebidos) if (!o.resolvido) o.resolvido = aplicarAviso(o.texto, o.ts);
  salvar(); render(); avisar('Marcado: ' + r.resolvido);
});
$('#recebidos').addEventListener('click', ev => {
  if (!ev.target.matches('[data-acao="ignorar"]')) return;
  const r = E.recebidos.find(x => x.id === ev.target.closest('.receb').dataset.rid);
  if (r) { r.resolvido = 'ignorado'; salvar(); renderRecebidos(); }
});

// ---------- ajustes ----------
const urlCanal = () => E.cfg.servidor.replace(/\/+$/, '') + '/' + encodeURIComponent(E.cfg.topico);
function renderAjustes() {
  if (document.activeElement !== $('#cfgTopico')) $('#cfgTopico').value = E.cfg.topico;
  if (document.activeElement !== $('#cfgServidor')) $('#cfgServidor').value = E.cfg.servidor;
  $('#cfgAtivo').checked = E.cfg.ativo;
  $('#cfgUrl').textContent = urlCanal();
}
$('.abas').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-aba]'); if (!b) return;
  document.querySelectorAll('.abas button').forEach(x => x.classList.toggle('ativa', x === b));
  ['lista', 'recebidos', 'ajustes'].forEach(a => ($('#aba-' + a).hidden = a !== b.dataset.aba));
});
$('#cfgTopico').addEventListener('change', ev => { const v = ev.target.value.trim(); if (v) { E.cfg.topico = v; E.cfg.ultimoId = null; salvar(); renderAjustes(); buscarAvisos(); } });
$('#cfgServidor').addEventListener('change', ev => {
  const v = ev.target.value.trim();
  if (/^https:\/\//.test(v)) { E.cfg.servidor = v; E.cfg.ultimoId = null; salvar(); renderAjustes(); buscarAvisos(); } else avisar('O servidor precisa começar com https://');
});
$('#cfgAtivo').addEventListener('change', ev => { E.cfg.ativo = ev.target.checked; salvar(); ciclo(); });
$('#btnTeste').addEventListener('click', async () => {
  const txt = $('#testeTexto').value.trim(); if (!txt) return;
  $('#testeResultado').textContent = 'Enviando…';
  try {
    const r = await fetch(urlCanal(), { method: 'POST', body: txt });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await buscarAvisos();
    $('#testeResultado').textContent = 'Enviado e recebido.';
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
    migrar(); salvar(); render(); avisar('Lista importada.');
  } catch (e) { avisar('Arquivo inválido: ' + e.message); }
  ev.target.value = '';
});

// ---------- canal da box ----------
let buscando = false;
async function buscarAvisos() {
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
      const ts = (m.time || Date.now() / 1000) * 1000, texto = String(m.message || '').slice(0, 300);
      const res = aplicarAviso(texto, ts);
      E.recebidos.push({ id: m.id, texto, ts, resolvido: res });
      if (res) marcados.push(res);
    }
    if (E.recebidos.length > 300) E.recebidos = E.recebidos.slice(-300);
    salvar(); if (linhas.length) render();
    if (marcados.length) avisar('Marcado pela box: ' + marcados.join(', '));
    status('box conectada', 'on');
  } catch (e) { status('box sem conexão', 'erro'); }
  finally { buscando = false; }
}
function status(txt, classe) { const s = $('#status'); s.textContent = '● ' + txt; s.className = 'status ' + (classe || ''); }
let timer;
function ciclo() {
  clearInterval(timer);
  if (!E.cfg.ativo) { status('box desligada'); return; }
  buscarAvisos(); timer = setInterval(buscarAvisos, INTERVALO_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) buscarAvisos(); });

// dados da versão anterior
function migrar() {
  // a 1ª versão gerava um canal aleatório por aparelho; agora todos usam o canal da box
  if (!E.cfg.canalV2) { if (/^assistidos-[a-z0-9]{9}$/.test(E.cfg.topico) && E.cfg.topico !== TOPICO_PADRAO) { E.cfg.topico = TOPICO_PADRAO; E.cfg.ultimoId = null; } E.cfg.canalV2 = true; }
  for (const it of E.itens) { it.eps = it.eps || {}; it.nomes = it.nomes || {}; it.apelidos = it.apelidos || []; it.temporadas = it.temporadas || []; }
}
migrar(); salvar(); render(); ciclo();
