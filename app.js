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
/* Próximo = o episódio depois do mais adiantado que você viu (quem começa pela TV no meio não fica preso no E1). */
function proximo(it) {
  let ult = null;
  for (const k of Object.keys(it.eps || {})) { const [t, e] = k.split('x').map(Number); if (!ult || t > ult.t || (t === ult.t && e > ult.e)) ult = { t, e }; }
  if (!ult) return it.temporadas.length ? { t: 1, e: 1 } : null;
  for (let t = ult.t; t <= it.temporadas.length; t++)
    for (let e = t === ult.t ? ult.e + 1 : 1; e <= it.temporadas[t - 1]; e++)
      if (!it.eps[chaveEp(t, e)]) return { t, e };
  return null;
}
function rotuloEp(it, t, e) {
  const n = it.nomes && it.nomes[chaveEp(t, e)];
  return `T${t} E${e}` + (n ? ' · ' + n : '');
}
function _capaAntiga(it, classe = 'capa') {
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
  const tv = json('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q)).then(rs => rs.slice(0, 10).map(({ show: s, score }) => ({
    fonte: 'tvmaze', fid: s.id, titulo: s.name, score, tipo: ehAnime(s) ? 'anime' : 'serie',
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

// ---------- cadastro automático do que a box mandou ----------
/* Título novo vindo da box: procura no catálogo e cadastra sozinho.
   Se o catálogo não tiver, cadastra só com o nome da TV. O nome da TV vira apelido. */
async function autoAdicionar(texto, ts) {
  const r = interpretar(texto);
  const nomeTv = r.titulo && r.titulo.split(/\s+[-–|]\s+/)[0].trim();
  if (!nomeTv || normalizar(nomeTv).length < 2) return null;
  let escolhido = null;
  try {
    const res = await buscarSeries(nomeTv);
    const q = normalizar(nomeTv);
    const nomes = x => [x.titulo, ...(x.apelidos || [])].map(normalizar);
    escolhido = res.find(x => x.tipo !== 'filme' && nomes(x).includes(q))
      || res.find(x => x.tipo !== 'filme' && nomes(x).some(n => n.startsWith(q + ' ') || q.startsWith(n + ' ')))
      || res.find(x => x.fonte === 'tvmaze' && x.score >= 0.7);
  } catch (e) { /* sem catálogo agora: cadastra só com o nome */ }
  const tipoPadrao = r.ep != null ? 'serie' : 'filme';
  const it = {
    id: novoId(), tipo: escolhido ? escolhido.tipo : tipoPadrao, titulo: escolhido ? escolhido.titulo : nomeTv,
    apelidos: [...new Set([nomeTv, ...((escolhido && escolhido.apelidos) || [])])].filter(n => normalizar(n) !== normalizar(escolhido ? escolhido.titulo : nomeTv)),
    capa: escolhido && escolhido.capa || null, ano: escolhido && escolhido.ano || '', sinopse: escolhido && escolhido.sinopse || '',
    fonte: escolhido ? escolhido.fonte : 'box', fid: escolhido ? escolhido.fid : null,
    temporadas: [], nomes: {}, eps: {}, visto: null, criado: ts, automatico: true,
  };
  if (it.tipo !== 'filme') {
    try { if (escolhido && escolhido.fonte === 'tvmaze') Object.assign(it, await detalhesTvmaze(escolhido.fid)); } catch (e) { /* segue sem episódios */ }
    if (!it.temporadas.length) it.temporadas = [escolhido && escolhido.eps || Math.max(12, r.ep || 1)];
    // a Brasil TV pode dividir temporadas diferente do catálogo: sem número no catálogo, a temporada nasce do que a TV mostra
    if (r.temp != null && r.temp > it.temporadas.length) { it.nomes = {}; it.temporadas = Array(r.temp).fill(12); }
  }
  // já existe (outro aviso cadastrou antes)? só aprende o nome
  const igual = E.itens.find(i => (it.fid && i.fonte === it.fonte && i.fid === it.fid));
  if (igual) { if (!igual.apelidos.some(n => normalizar(n) === normalizar(nomeTv))) igual.apelidos.push(nomeTv); return aplicarAviso(texto, ts, igual); }
  E.itens.push(it);
  const res = aplicarAviso(texto, ts, it);
  return res && res + ' (adicionado sozinho)';
}

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
      const res = aplicarAviso(texto, ts) || await autoAdicionar(texto, ts);
      E.recebidos.push({ id: m.id, texto, ts, resolvido: res });
      if (res) marcados.push(res);
    }
    for (const o of E.recebidos) if (!o.resolvido && Date.now() - o.ts < 864e5) { // pendentes de antes
      o.resolvido = aplicarAviso(o.texto, o.ts) || await autoAdicionar(o.texto, o.ts);
      if (o.resolvido) marcados.push(o.resolvido);
    }
    if (E.recebidos.length > 300) E.recebidos = E.recebidos.slice(-300);
    salvar(); if (linhas.length) render();
    if (marcados.length) avisar('Da TV: ' + marcados.join(', '));
    status('box conectada', 'on');
  } catch (e) { status('box sem conexão', 'erro'); }
  finally { buscando = false; }
}
function status(txt, classe) {
  const mudou = statusBox.classe !== (classe || '');
  statusBox = { txt: txt.replace(/^box /, 'TV '), classe: classe || '' };
  document.querySelectorAll('.ponto').forEach(p => (p.className = 'ponto ' + statusBox.classe));
  if (mudou && tela === 'ajustes') render();
}
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

// =====================================================================
// interface
// =====================================================================
const ICONE = {
  inicio: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  serie: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="m8 2 4 4 4-4"/></svg>',
  anime: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>',
  filme: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  buscar: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
  ajustes: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  voltar: '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
  mais: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  tv: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/></svg>',
};
const NAV = [['inicio', 'Início'], ['serie', 'Séries'], ['anime', 'Animes'], ['filme', 'Filmes'], ['buscar', 'Buscar']];
const PLURAL = { serie: 'Séries', anime: 'Animes', filme: 'Filmes' };

let tela = 'inicio', subaba = { serie: 'assistindo', anime: 'assistindo', filme: 'assistir' };
let detId = null, detTemp = 1, statusBox = { txt: 'conectando…', classe: '' };
const urlCanal = () => E.cfg.servidor.replace(/\/+$/, '') + '/' + encodeURIComponent(E.cfg.topico);

function estado(it) {
  if (it.tipo === 'filme') return it.visto ? 'concluido' : 'assistir';
  return vistos(it) === 0 ? 'assistir' : proximo(it) ? 'assistindo' : 'concluido';
}
const pad2 = n => String(n).padStart(2, '0');
function capa(it, classe = 'capa') {
  if (it.capa) return `<img class="${classe}" src="${esc(it.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  return `<div class="${classe} sem-capa"><span>${esc((it.titulo || '?').trim().slice(0, 2))}</span></div>`;
}
const porRecente = (a, b) => (b.atualizado || b.criado) - (a.atualizado || a.criado);

function render() {
  document.querySelectorAll('[data-tela]').forEach(b => b.classList.toggle('ativa', b.dataset.tela === tela));
  const v = $('#view');
  v.innerHTML = tela === 'inicio' ? telaInicio() : tela === 'buscar' ? telaBuscar() : tela === 'ajustes' ? telaAjustes() : telaSecao(tela);
  if (tela === 'buscar') posBuscar();
  if (detId) renderDetalhe();
}
function irPara(t) {
  tela = t; window.scrollTo(0, 0); render();
  if (t === 'buscar') setTimeout(() => { const i = $('#qCat'); if (i) i.focus(); }, 30);
}
document.addEventListener('click', ev => {
  const n = ev.target.closest('[data-tela]'); if (n) { ev.preventDefault(); return irPara(n.dataset.tela); }
});

function cabecalho(titulo, extra = '') {
  return `<header class="cab">
    <h1>${titulo}</h1>
    <div class="cab-acoes">${extra}
      <button class="icone-btn" data-tela="ajustes" aria-label="Ajustes">${ICONE.ajustes}<i class="ponto ${statusBox.classe}"></i></button>
    </div></header>`;
}

// ---------- início ----------
function telaInicio() {
  const busca = `<button class="pilula-busca" data-tela="buscar">${ICONE.buscar}<span>Buscar séries, animes e filmes</span></button>`;
  if (!E.itens.length) {
    return cabecalho('<span class="marca">Assistidos</span>') + busca + `
      <section class="vazio-grande">
        <div class="vazio-icone">${ICONE.tv}</div>
        <h2>Comece a sua lista</h2>
        <p>Abra um episódio na Brasil TV e ele aparece aqui sozinho. Ou busque um título para adicionar.</p>
        <button class="btn primario" data-tela="buscar">Buscar um título</button>
      </section>`;
  }
  const ass = E.itens.filter(i => estado(i) === 'assistindo').sort(porRecente);
  const fila = E.itens.filter(i => estado(i) === 'assistir').sort(porRecente);
  const fim = E.itens.filter(i => estado(i) === 'concluido').sort(porRecente);
  const totalVistos = E.itens.reduce((a, i) => a + vistos(i), 0);
  return cabecalho('<span class="marca">Assistidos</span>') + busca + `
    <div class="resumo">
      <div><b>${ass.length}</b><span>assistindo</span></div>
      <div><b>${totalVistos}</b><span>episódios vistos</span></div>
      <div><b>${fim.length}</b><span>concluídos</span></div>
    </div>
    ${ass.length ? `<section class="faixa"><h2>Continuar assistindo</h2><div class="trilho">${ass.map(cartaoContinuar).join('')}</div></section>` : ''}
    ${fila.length ? `<section class="faixa"><h2>Quero ver</h2><div class="trilho">${fila.map(cartaoPoster).join('')}</div></section>` : ''}
    ${fim.length ? `<section class="faixa"><h2>Concluídos</h2><div class="trilho">${fim.map(cartaoPoster).join('')}</div></section>` : ''}`;
}
function cartaoContinuar(it) {
  const p = it.tipo !== 'filme' && proximo(it), tot = totalEps(it), v = vistos(it);
  const nome = p && it.nomes && it.nomes[chaveEp(p.t, p.e)];
  return `<article class="continuar" data-det="${it.id}">
    ${capa(it)}
    <div class="continuar-info">
      <span class="chip">${esc(it.titulo)}</span>
      ${p ? `<b class="epnum">T${pad2(p.t)} | E${pad2(p.e)}</b><small>${esc(nome || 'Próximo episódio')}</small>` : '<b class="epnum">Em dia</b>'}
      <div class="progresso"><i style="width:${Math.round(v / tot * 100)}%"></i></div>
      <small class="fraco">${v} de ${tot} · faltam ${tot - v}</small>
    </div>
    ${p ? `<button class="marcar" data-marcar="${it.id}" aria-label="Marcar T${p.t} E${p.e} como visto">${ICONE.check}</button>` : ''}
  </article>`;
}
function cartaoPoster(it) {
  const tot = totalEps(it), v = vistos(it);
  return `<article class="poster" data-det="${it.id}">
    <div class="poster-img">${capa(it)}${v && v < tot ? `<div class="progresso fino"><i style="width:${Math.round(v / tot * 100)}%"></i></div>` : ''}
      ${estado(it) === 'concluido' ? `<span class="selo">${ICONE.check}</span>` : ''}</div>
    <b>${esc(it.titulo)}</b><small>${TIPOS[it.tipo]}${it.ano ? ' · ' + esc(it.ano) : ''}</small>
  </article>`;
}

// ---------- seções ----------
function telaSecao(tipo) {
  const itens = E.itens.filter(i => i.tipo === tipo);
  const grupos = { assistir: [], assistindo: [], concluido: [] };
  itens.sort(porRecente).forEach(i => grupos[estado(i)].push(i));
  const abas = tipo === 'filme' ? [['assistir', 'Quero ver'], ['concluido', 'Assistidos']] : [['assistir', 'Quero ver'], ['assistindo', 'Assistindo'], ['concluido', 'Concluídos']];
  if (!abas.some(a => a[0] === subaba[tipo])) subaba[tipo] = abas[0][0];
  const lista = grupos[subaba[tipo]];
  return cabecalho(PLURAL[tipo], `<button class="icone-btn" data-tela="buscar" aria-label="Adicionar">${ICONE.mais}</button>`) + `
    <div class="segmentos">${abas.map(([k, n]) => `<button data-sub="${k}" class="${subaba[tipo] === k ? 'ativa' : ''}">${n}<span>${grupos[k].length}</span></button>`).join('')}</div>
    ${lista.length ? `<div class="linhas">${lista.map(linhaItem).join('')}</div>`
      : `<div class="vazio">${itens.length ? 'Nada aqui.' : `Nenhum ${TIPOS[tipo].toLowerCase()} na lista ainda.`}<br><button class="btn" data-tela="buscar">Buscar ${TIPOS[tipo].toLowerCase()}</button></div>`}`;
}
function linhaItem(it) {
  const tot = totalEps(it), v = vistos(it);
  if (it.tipo === 'filme') {
    return `<article class="linha-item" data-det="${it.id}">${capa(it)}
      <div class="li-info"><span class="chip">${esc(it.titulo)}</span><b class="epnum">${esc(it.ano || 'Filme')}</b>
        <small>${it.visto ? 'Assistido em ' + quando(it.visto) : 'Ainda não assistido'}</small></div>
      <button class="marcar ${it.visto ? 'feito' : ''}" data-marcar="${it.id}" aria-label="Assistido">${ICONE.check}</button></article>`;
  }
  const p = proximo(it), nome = p && it.nomes && it.nomes[chaveEp(p.t, p.e)];
  return `<article class="linha-item" data-det="${it.id}">${capa(it)}
    <div class="li-info"><span class="chip">${esc(it.titulo)}</span>
      ${p ? `<b class="epnum">T${pad2(p.t)} | E${pad2(p.e)} <em>+${tot - v - 1 > 0 ? tot - v - 1 : 0}</em></b><small>${esc(nome || 'Episódio ' + p.e)}</small>` : `<b class="epnum">Concluído</b><small>${tot} episódios</small>`}
      <div class="progresso"><i style="width:${Math.round(v / tot * 100)}%"></i></div></div>
    ${p ? `<button class="marcar" data-marcar="${it.id}" aria-label="Marcar próximo">${ICONE.check}</button>` : `<span class="marcar feito">${ICONE.check}</span>`}
  </article>`;
}

// ---------- buscar ----------
let tipoBusca = 'serie', textoBusca = '', resultados = [], seqBusca = 0, timerBusca, estadoBusca = '';
function telaBuscar() {
  const meus = textoBusca.length >= 2 ? E.itens.filter(i => normalizar([i.titulo, ...i.apelidos].join(' ')).includes(normalizar(textoBusca))) : [];
  return cabecalho('Buscar') + `
    <label class="pilula-busca campo">${ICONE.buscar}<input id="qCat" type="search" placeholder="${tipoBusca === 'filme' ? 'Nome do filme' : 'Nome da série ou anime'}" value="${esc(textoBusca)}" autocomplete="off"></label>
    <div class="chips"><button data-tb="serie" class="${tipoBusca === 'serie' ? 'ativa' : ''}">Séries e animes</button><button data-tb="filme" class="${tipoBusca === 'filme' ? 'ativa' : ''}">Filmes</button></div>
    ${meus.length ? `<section class="faixa"><h2>Na sua lista</h2><div class="trilho">${meus.map(cartaoPoster).join('')}</div></section>` : ''}
    <section class="faixa"><div id="resultados" class="grade"></div></section>
    <details class="manual"><summary>Não achou? Adicionar sem buscar</summary>
      <form id="formNovo">
        <input id="novoTitulo" required placeholder="Título" autocomplete="off">
        <div class="linha"><select id="novoTipo"><option value="serie">Série</option><option value="anime">Anime</option><option value="filme">Filme</option></select>
        <label>Temporadas <input id="novoTemps" type="number" min="1" value="1"></label>
        <label>Episódios <input id="novoEps" type="number" min="1" value="12"></label></div>
        <button type="submit" class="btn primario">Adicionar</button>
      </form></details>`;
}
function posBuscar() { desenharResultados(); }
function desenharResultados() {
  const el = $('#resultados'); if (!el) return;
  if (textoBusca.trim().length < 2) { el.innerHTML = '<p class="dica">Digite o nome para buscar no catálogo. A capa, as temporadas e os episódios vêm juntos.</p>'; return; }
  if (estadoBusca === 'carregando') { el.innerHTML = Array(6).fill('<div class="poster esqueleto"><div class="poster-img"></div><b></b></div>').join(''); return; }
  if (estadoBusca === 'erro') { el.innerHTML = '<p class="dica">Não consegui buscar agora. Confira a internet ou use "adicionar sem buscar".</p>'; return; }
  if (!resultados.length) { el.innerHTML = '<p class="dica">Nada encontrado. Tente o nome em inglês ou original.</p>'; return; }
  const jaTem = new Map(E.itens.map(i => [i.fonte + ':' + i.fid, i.id]));
  el.innerHTML = resultados.map((x, i) => `<article class="poster resultado" data-res="${i}">
    <div class="poster-img">${x.capa ? `<img class="capa" src="${esc(x.capa)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="capa sem-capa"><span>${esc(x.titulo.slice(0, 2))}</span></div>`}
      <span class="selo ${jaTem.has(x.fonte + ':' + x.fid) ? '' : 'add'}">${jaTem.has(x.fonte + ':' + x.fid) ? ICONE.check : ICONE.mais}</span></div>
    <b>${esc(x.titulo)}</b><small>${[TIPOS[x.tipo], x.ano].filter(Boolean).map(esc).join(' · ')}</small></article>`).join('');
}
async function pesquisar() {
  const q = textoBusca.trim(), seq = ++seqBusca;
  if (q.length < 2) { resultados = []; estadoBusca = ''; return desenharResultados(); }
  estadoBusca = 'carregando'; desenharResultados();
  try {
    const r = tipoBusca === 'filme' ? await buscarFilmes(q) : await buscarSeries(q);
    if (seq !== seqBusca) return;
    resultados = r; estadoBusca = 'ok';
  } catch (e) { if (seq !== seqBusca) return; estadoBusca = 'erro'; }
  desenharResultados();
}
document.addEventListener('input', ev => {
  if (ev.target.id === 'qCat') { textoBusca = ev.target.value; clearTimeout(timerBusca); timerBusca = setTimeout(pesquisar, 350); }
});
async function adicionarResultado(x, cartao) {
  const existente = E.itens.find(i => i.fonte === x.fonte && i.fid === x.fid);
  if (existente) return abrirDetalhe(existente.id);
  if (cartao) cartao.classList.add('carregando');
  const it = {
    id: novoId(), tipo: x.tipo, titulo: x.titulo, apelidos: (x.apelidos || []).filter(n => n !== x.titulo),
    capa: x.capa || null, ano: x.ano || '', sinopse: x.sinopse || '', fonte: x.fonte, fid: x.fid,
    temporadas: [], nomes: {}, eps: {}, visto: null, criado: Date.now(),
  };
  if (x.tipo !== 'filme') {
    try { if (x.fonte === 'tvmaze') Object.assign(it, await detalhesTvmaze(x.fid)); } catch (e) { /* segue */ }
    if (!it.temporadas.length) it.temporadas = [x.eps || 12];
  }
  E.itens.push(it); salvar(); render(); abrirDetalhe(it.id);
  avisar(`${it.titulo} entrou na lista`);
}

// ---------- detalhe ----------
function abrirDetalhe(id) {
  const it = E.itens.find(i => i.id === id); if (!it) return;
  detId = id; const p = it.tipo !== 'filme' && proximo(it); detTemp = p ? p.t : 1;
  $('#sheet').hidden = false; document.body.classList.add('travado'); renderDetalhe();
  $('#sheet').scrollTop = 0;
}
function fecharDetalhe() { detId = null; $('#sheet').hidden = true; document.body.classList.remove('travado'); }
function renderDetalhe() {
  const it = E.itens.find(i => i.id === detId); if (!it) return fecharDetalhe();
  const v = vistos(it), tot = totalEps(it), p = it.tipo !== 'filme' && proximo(it);
  const fundo = it.capa ? `style="--fundo-img:url('${esc(it.capa)}')"` : '';
  let corpo;
  if (it.tipo === 'filme') {
    corpo = `<div class="acao-principal"><button class="btn ${it.visto ? '' : 'primario'} largo" data-a="filme">${it.visto ? ICONE.check + ' Assistido em ' + quando(it.visto) : 'Marcar como assistido'}</button></div>`;
  } else {
    if (detTemp > it.temporadas.length) detTemp = it.temporadas.length;
    const n = it.temporadas[detTemp - 1];
    const vt = Array.from({ length: n }, (_, j) => it.eps[chaveEp(detTemp, j + 1)]).filter(Boolean).length;
    let lis = '';
    for (let e = 1; e <= n; e++) {
      const k = chaveEp(detTemp, e), ok = it.eps[k], nome = (it.nomes && it.nomes[k]) || 'Episódio ' + e;
      lis += `<li class="ep${ok ? ' ok' : ''}${it.recente === k ? ' recente' : ''}" data-a="ep" data-e="${e}">
        <span class="ep-num">${pad2(e)}</span>
        <span class="ep-txt"><b>${esc(nome)}</b>${ok ? `<small>visto em ${quando(ok)}</small>` : ''}</span>
        ${ok ? '' : `<button class="ate" data-a="ate" data-e="${e}">até aqui</button>`}
        <span class="marcar mini ${ok ? 'feito' : ''}">${ICONE.check}</span></li>`;
    }
    corpo = `
      ${p ? `<div class="acao-principal"><button class="btn primario largo" data-a="proximo">${ICONE.check} Marcar T${pad2(p.t)} | E${pad2(p.e)}${it.nomes && it.nomes[chaveEp(p.t, p.e)] ? ' · ' + esc(it.nomes[chaveEp(p.t, p.e)]) : ''}</button></div>` : ''}
      <div class="temps">${it.temporadas.map((nn, i) => {
        const vv = Array.from({ length: nn }, (_, j) => it.eps[chaveEp(i + 1, j + 1)]).filter(Boolean).length;
        return `<button data-a="temp" data-t="${i + 1}" class="${i + 1 === detTemp ? 'ativa' : ''} ${vv === nn ? 'completa' : ''}">Temporada ${i + 1}<small>${vv}/${nn}</small></button>`;
      }).join('')}<button data-a="tempMais" class="discreto" aria-label="Adicionar temporada">${ICONE.mais}</button></div>
      <div class="temp-acoes"><span>${vt} de ${n} vistos</span>
        <span><button class="link" data-a="epMais">+ episódio</button><button class="link" data-a="tempTudo">${vt === n ? 'Desmarcar todos' : 'Marcar todos'}</button></span></div>
      <ul class="eps">${lis}</ul>`;
  }
  $('#sheet').innerHTML = `
    <div class="det" ${fundo}>
      <div class="det-fundo"></div>
      <div class="det-barra"><button class="icone-btn" data-a="fechar" aria-label="Voltar">${ICONE.voltar}</button></div>
      <div class="det-topo">
        ${capa(it)}
        <div class="det-tit">
          <h2>${esc(it.titulo)}</h2>
          <p>${[TIPOS[it.tipo], it.ano, it.tipo !== 'filme' ? it.temporadas.length + (it.temporadas.length > 1 ? ' temporadas' : ' temporada') : ''].filter(Boolean).map(esc).join(' · ')}</p>
          ${it.automatico ? '<span class="chip suave">adicionado pela TV</span>' : ''}
        </div>
      </div>
      ${it.tipo !== 'filme' ? `<div class="stats">
        <div><b>${tot}</b><span>episódios</span></div><div><b>${v}</b><span>vistos</span></div><div><b>${tot - v}</b><span>faltam</span></div>
        <div><b>${Math.round(v / tot * 100)}%</b><span>progresso</span></div></div>` : ''}
      ${it.sinopse ? `<p class="sinopse" data-a="sinopse">${esc(it.sinopse)}</p>` : ''}
      ${corpo}
      <details class="editar"><summary>Editar</summary>
        <label>Título <input data-campo="titulo" value="${esc(it.titulo)}"></label>
        <label>Nomes que aparecem na Brasil TV <input data-campo="apelidos" value="${esc((it.apelidos || []).join(', '))}" placeholder="Separados por vírgula"></label>
        <label>Tipo <select data-campo="tipo">${Object.entries(TIPOS).map(([k, n]) => `<option value="${k}" ${k === it.tipo ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="btn perigo" data-a="remover">Remover da lista</button>
      </details>
    </div>`;
}
function marcarProximo(it) {
  const agora = Date.now();
  if (it.tipo === 'filme') it.visto = it.visto ? null : agora;
  else { const p = proximo(it); if (!p) return; it.eps[chaveEp(p.t, p.e)] = agora; it.recente = chaveEp(p.t, p.e); avisar(`${it.titulo}: T${p.t} E${p.e} visto`); }
  it.atualizado = agora; salvar(); render();
}
document.addEventListener('click', ev => {
  const m = ev.target.closest('[data-marcar]');
  if (m) { ev.stopPropagation(); const it = E.itens.find(i => i.id === m.dataset.marcar); if (it) marcarProximo(it); return; }
  const r = ev.target.closest('[data-res]');
  if (r) return adicionarResultado(resultados[+r.dataset.res], r);
  const d = ev.target.closest('[data-det]'); if (d) return abrirDetalhe(d.dataset.det);
  const s = ev.target.closest('[data-sub]'); if (s) { subaba[tela] = s.dataset.sub; return render(); }
  const tb = ev.target.closest('[data-tb]'); if (tb) { tipoBusca = tb.dataset.tb; render(); pesquisar(); return; }
});
$('#sheet').addEventListener('click', ev => {
  if (ev.target === $('#sheet')) return fecharDetalhe();
  const alvo = ev.target.closest('[data-a]'); if (!alvo) return;
  ev.stopPropagation();
  const it = E.itens.find(i => i.id === detId); if (!it) return;
  const a = alvo.dataset.a, e = +alvo.dataset.e, t = detTemp, agora = Date.now();
  if (a === 'fechar') return fecharDetalhe();
  if (a === 'sinopse') return alvo.classList.toggle('aberta');
  if (a === 'filme') it.visto = it.visto ? null : agora;
  else if (a === 'ep') { const k = chaveEp(t, e); if (it.eps[k]) delete it.eps[k]; else { it.eps[k] = agora; it.recente = k; } }
  else if (a === 'ate') {
    for (let tt = 1; tt <= t; tt++) for (let ee = 1; ee <= (tt < t ? it.temporadas[tt - 1] : e); ee++) { const k = chaveEp(tt, ee); if (!it.eps[k]) it.eps[k] = agora; }
    it.recente = chaveEp(t, e);
  } else if (a === 'proximo') { const p = proximo(it); if (p) { it.eps[chaveEp(p.t, p.e)] = agora; it.recente = chaveEp(p.t, p.e); detTemp = proximo(it) ? proximo(it).t : p.t; } }
  else if (a === 'temp') { detTemp = +alvo.dataset.t; return renderDetalhe(); }
  else if (a === 'tempTudo') {
    const n = it.temporadas[t - 1], todos = Array.from({ length: n }, (_, j) => it.eps[chaveEp(t, j + 1)]).every(Boolean);
    for (let j = 1; j <= n; j++) { const k = chaveEp(t, j); if (todos) delete it.eps[k]; else if (!it.eps[k]) it.eps[k] = agora; }
  } else if (a === 'epMais') it.temporadas[t - 1]++;
  else if (a === 'tempMais') { it.temporadas.push(it.temporadas[it.temporadas.length - 1] || 12); detTemp = it.temporadas.length; }
  else if (a === 'remover') {
    if (!confirm(`Remover "${it.titulo}" da lista?`)) return;
    E.itens = E.itens.filter(x => x !== it); salvar(); fecharDetalhe(); return render();
  } else return;
  it.atualizado = agora; salvar(); render();
});
$('#sheet').addEventListener('change', ev => {
  const c = ev.target.dataset.campo; if (!c) return;
  const it = E.itens.find(i => i.id === detId); if (!it) return;
  const v = ev.target.value.trim();
  if (c === 'titulo' && v) it.titulo = v;
  if (c === 'apelidos') it.apelidos = v.split(',').map(s => s.trim()).filter(Boolean);
  if (c === 'tipo') { it.tipo = v; if (v !== 'filme' && !it.temporadas.length) it.temporadas = [12]; }
  salvar(); render(); avisar('Salvo');
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && detId) fecharDetalhe(); });
document.addEventListener('submit', ev => {
  if (ev.target.id !== 'formNovo') return;
  ev.preventDefault();
  const titulo = $('#novoTitulo').value.trim(); if (!titulo) return;
  const tipo = $('#novoTipo').value;
  const nt = Math.max(1, Math.min(99, +$('#novoTemps').value || 1)), ne = Math.max(1, Math.min(2000, +$('#novoEps').value || 1));
  const it = { id: novoId(), tipo, titulo, apelidos: [], capa: null, ano: '', sinopse: '', fonte: 'manual', fid: null,
    temporadas: tipo === 'filme' ? [] : Array(nt).fill(ne), nomes: {}, eps: {}, visto: null, criado: Date.now() };
  E.itens.push(it); salvar(); render(); abrirDetalhe(it.id);
});

// ---------- ajustes (a parte da box fica aqui, recolhida) ----------
function telaAjustes() {
  const ult = E.recebidos.slice(-1)[0];
  return cabecalho('Ajustes') + `
    <section class="painel-aj">
      <div class="aj-linha"><div><b>Marcar sozinho pela TV</b><small>${statusBox.txt}${ult ? ' · último aviso ' + quando(ult.ts) : ''}</small></div>
        <label class="chave"><input type="checkbox" id="cfgAtivo" ${E.cfg.ativo ? 'checked' : ''}><i></i></label></div>
    </section>
    <section class="painel-aj">
      <div class="aj-linha"><div><b>Cópia de segurança</b><small>A lista fica salva neste aparelho. Exporte para guardar ou levar para outro.</small></div></div>
      <div class="linha"><button class="btn" id="btnExportar">Exportar</button><label class="btn">Importar<input id="arqImportar" type="file" accept="application/json" hidden></label></div>
    </section>
    <details class="painel-aj avancado"><summary>Avançado</summary>
      <label>Canal da box <input id="cfgTopico" value="${esc(E.cfg.topico)}" spellcheck="false" autocomplete="off"></label>
      <label>Servidor <input id="cfgServidor" value="${esc(E.cfg.servidor)}" spellcheck="false" autocomplete="off"></label>
      <h3>Últimos avisos da TV</h3>
      <div class="recebidos">${E.recebidos.length ? E.recebidos.slice().reverse().slice(0, 30).map(r => `<div class="rec"><span>${esc(r.texto)}</span><small>${quando(r.ts)} · ${r.resolvido ? esc(r.resolvido) : 'não reconhecido'}</small></div>`).join('') : '<p class="dica">Nenhum aviso ainda.</p>'}</div>
      <h3>Testar</h3>
      <div class="linha"><input id="testeTexto" placeholder="Ex.: Frieren T1 E5"><button class="btn" id="btnTeste">Enviar</button></div>
      <p class="dica" id="testeResultado"></p>
    </details>
    <p class="rodape">Assistidos · catálogo de TVmaze, AniList e Wikipédia</p>`;
}
document.addEventListener('change', async ev => {
  const id = ev.target.id;
  if (id === 'cfgAtivo') { E.cfg.ativo = ev.target.checked; salvar(); ciclo(); render(); }
  if (id === 'cfgTopico') { const v = ev.target.value.trim(); if (v) { E.cfg.topico = v; E.cfg.ultimoId = null; salvar(); buscarAvisos(); } }
  if (id === 'cfgServidor') { const v = ev.target.value.trim(); if (/^https:\/\//.test(v)) { E.cfg.servidor = v; E.cfg.ultimoId = null; salvar(); buscarAvisos(); } else avisar('O servidor precisa começar com https://'); }
  if (id === 'arqImportar') {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.itens)) throw new Error('arquivo sem lista');
      if (!confirm(`Substituir a lista atual por ${d.itens.length} títulos do arquivo?`)) return;
      const base = estadoInicial();
      E = { ...base, ...d, cfg: { ...base.cfg, ...(d.cfg || {}) }, recebidos: d.recebidos || [] };
      migrar(); salvar(); render(); avisar('Lista importada');
    } catch (e) { avisar('Arquivo inválido: ' + e.message); }
  }
});
document.addEventListener('click', async ev => {
  if (ev.target.id === 'btnExportar') {
    const blob = new Blob([JSON.stringify(E, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'assistidos-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  if (ev.target.id === 'btnTeste') {
    const txt = $('#testeTexto').value.trim(); if (!txt) return;
    $('#testeResultado').textContent = 'Enviando…';
    try {
      const r = await fetch(urlCanal(), { method: 'POST', body: txt });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await buscarAvisos(); avisar('Teste enviado');
    } catch (e) { const el = $('#testeResultado'); if (el) el.textContent = 'Falhou: ' + e.message; }
  }
});

// ---------- navegação ----------
function montarNav() {
  const item = ([k, n]) => `<button class="nav-item" data-tela="${k}"><span class="ni">${ICONE[k]}</span><span>${n}</span></button>`;
  $('#navLateral').innerHTML = NAV.map(item).join('') + item(['ajustes', 'Ajustes']);
  $('#navBaixo').innerHTML = NAV.map(item).join('');
}

migrar(); salvar(); montarNav(); render(); ciclo();
