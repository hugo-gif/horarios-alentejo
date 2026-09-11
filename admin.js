'use strict';

/* =============================================================
   Painel de Administração — Horários do Alentejo
   -------------------------------------------------------------
   Página autónoma (admin.html) para gerir as viagens:
     • Ocultar / reativar viagens oficiais (ra_viagens_ocultas)
     • Adicionar viagens manuais (ra_viagens_adicionadas)
     • Exportar horarios.json consolidado
     • Restaurar dados de fábrica

   Lê horarios.json (dados base) + overrides do localStorage.
   ============================================================= */

const DATA_URL = 'horarios.json';

const OCULTAS_KEY = 'ra_viagens_ocultas';
const MANUAIS_KEY = 'ra_viagens_adicionadas';

const state = {
  data: null,   // conteúdo de horarios.json
  stops: [],    // nomes únicos e válidos para o <datalist>
  trips: [],    // viagens oficiais achatadas
};

let viagensOcultas = new Map(); // chave -> { chave, origem, destino, partida, chegada, linha, operador }
let viagensManuais = [];        // { id, linha, operador, sentido, tipoServico, paragens: [{nome, hora}] }

/* ---------------- Utilidades ---------------- */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Normaliza para comparação: minúsculas, sem acentos, espaços colapsados */
function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Higienização das paragens: rejeita HH:MM, números e termos com < 3 letras */
function isValidStopName(name) {
  if (name == null) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (/^\d{1,2}:\d{2}$/.test(s)) return false;
  if (/^[\d\s.,;:/\-–—]+$/.test(s)) return false;
  const letters = (s.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  return letters >= 3;
}

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function tipoLabel(tipo) {
  const map = {
    dias_uteis: 'Dias úteis',
    todos_os_dias: 'Todos os dias',
    sabado: 'Sábado',
    domingo: 'Domingo',
    segunda_a_sexta: 'Segunda a sexta',
    segunda_a_quarta: 'Segunda a quarta',
    quarta_feira_sexta_feira: 'Quarta a sexta',
    quarta_feira: 'Quarta-feira',
    quinta_feira: 'Quinta-feira',
    segunda_feira_terca_feira_quarta_feira_sexta_feira: 'Seg./ter./qua./sex.',
    segunda_feira_quarta_feira: 'Segunda e quarta',
  };
  return map[tipo] || '';
}

/* Chave única de uma viagem (partilhada com a app pública). */
function chaveViagem(t) {
  const linha = Array.isArray(t.linhas) ? t.linhas.join(',') : (t.linha || '');
  const operador = Array.isArray(t.operadores) ? t.operadores.join(',') : (t.operador || '');
  return [norm(t.origem), norm(t.destino), t.partida, t.chegada, linha, operador].join('|');
}

/* ---------------- Ícones ---------------- */

function olhoCortadoSVG() {
  return `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <path d="M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>`;
}

function olhoSVG() {
  return `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>`;
}

function lixoSVG() {
  return `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" />
  </svg>`;
}

/* ---------------- Estado / avisos ---------------- */

function setStatus(message, isError = false) {
  const el = document.getElementById('admin-status');
  if (!el) return;
  el.textContent = message;
  el.className = isError
    ? 'rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 shadow-sm ring-1 ring-rose-200'
    : 'rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-500 shadow-sm ring-1 ring-slate-200/70';
}

/* ---------------- Carregamento dos dados base ---------------- */

async function loadData() {
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Não foi possível carregar ' + DATA_URL + ' (HTTP ' + res.status + ')');
  }
  const json = await res.json();
  if (!json || !Array.isArray(json.servicos)) {
    throw new Error('Estrutura de horarios.json inesperada.');
  }
  state.data = json;
}

/* Constrói a lista única de paragens válidas (higienizada). */
function buildStops() {
  const map = new Map();
  for (const servico of state.data.servicos) {
    for (const sentido of servico.sentidos || []) {
      for (const paragem of sentido.paragens || []) {
        if (!isValidStopName(paragem.nome)) continue;
        const key = norm(paragem.nome);
        if (key && !map.has(key)) map.set(key, paragem.nome);
      }
    }
  }
  state.stops = [...map.values()].sort((a, b) => a.localeCompare(b, 'pt'));
}

function populateDatalist() {
  const list = document.getElementById('stops-list');
  if (!list) return;
  list.innerHTML = '';
  for (const value of state.stops) {
    const opt = document.createElement('option');
    opt.value = value;
    list.appendChild(opt);
  }
}

/* ---------------- Emparelhamento partida/chegada ---------------- */

function emparelharHorarios(partidas, chegadas) {
  const P = (partidas || []).filter((h) => toMinutes(h) != null);
  const C = (chegadas || []).filter((h) => toMinutes(h) != null);

  if (P.length === C.length) {
    const pares = [];
    for (let i = 0; i < P.length; i++) {
      if (toMinutes(C[i]) >= toMinutes(P[i])) pares.push({ partida: P[i], chegada: C[i] });
    }
    return pares;
  }

  const ch = C.map((h) => ({ hora: h, min: toMinutes(h) })).sort((a, b) => a.min - b.min);
  const usados = new Set();
  const pares = [];
  for (const p of P) {
    const pMin = toMinutes(p);
    let escolhido = -1;
    for (let i = 0; i < ch.length; i++) {
      if (usados.has(i)) continue;
      if (ch[i].min >= pMin) { escolhido = i; break; }
    }
    if (escolhido === -1) continue;
    usados.add(escolhido);
    pares.push({ partida: p, chegada: ch[escolhido].hora });
  }
  return pares;
}

/* ---------------- Construção das viagens oficiais ---------------- */

function buildTrips() {
  const trips = [];
  for (const servico of state.data.servicos) {
    for (const sentido of servico.sentidos || []) {
      const paragens = sentido.paragens || [];
      for (let oi = 0; oi < paragens.length; oi++) {
        const pOrigem = paragens[oi];
        if (!isValidStopName(pOrigem.nome)) continue;
        for (let di = oi + 1; di < paragens.length; di++) {
          const pDestino = paragens[di];
          if (!isValidStopName(pDestino.nome)) continue;
          const pares = emparelharHorarios(pOrigem.horarios, pDestino.horarios);
          for (const par of pares) {
            trips.push({
              operador: servico.operador || '—',
              linha: servico.linha || '—',
              sentido: sentido.nome || '',
              tipoServico: sentido.tipo_servico || null,
              origem: pOrigem.nome,
              destino: pDestino.nome,
              origemNorm: norm(pOrigem.nome),
              destinoNorm: norm(pDestino.nome),
              partida: par.partida,
              chegada: par.chegada,
              partidaMin: toMinutes(par.partida),
            });
          }
        }
      }
    }
  }
  state.trips = trips;
}

/* ---------------- Camada: viagens ocultas ---------------- */

function carregarOcultas() {
  viagensOcultas = new Map();
  try {
    const raw = localStorage.getItem(OCULTAS_KEY);
    if (!raw) return;
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista)) return;
    for (const item of lista) {
      if (typeof item === 'string') {
        const p = item.split('|');
        viagensOcultas.set(item, { chave: item, origem: p[0] || '—', destino: p[1] || '—', partida: p[2] || '—', chegada: p[3] || '—', linha: p[4] || '', operador: p[5] || '' });
      } else if (item && typeof item.chave === 'string') {
        viagensOcultas.set(item.chave, item);
      }
    }
  } catch (err) {
    console.warn('Viagens ocultas ilegíveis:', err);
  }
}

function gravarOcultas() {
  try {
    localStorage.setItem(OCULTAS_KEY, JSON.stringify([...viagensOcultas.values()]));
  } catch (err) {
    console.warn('Não foi possível gravar viagens ocultas:', err);
  }
}

function ocultarViagem(trip) {
  const chave = chaveViagem(trip);
  viagensOcultas.set(chave, {
    chave,
    origem: trip.origem || '—',
    destino: trip.destino || '—',
    partida: trip.partida || '—',
    chegada: trip.chegada || '—',
    linha: trip.linha || '',
    operador: trip.operador || '',
  });
  gravarOcultas();
}

function reativarViagem(chave) {
  viagensOcultas.delete(chave);
  gravarOcultas();
}

/* ---------------- Camada: viagens manuais ---------------- */

function carregarManuais() {
  viagensManuais = [];
  try {
    const raw = localStorage.getItem(MANUAIS_KEY);
    if (!raw) return;
    const lista = JSON.parse(raw);
    if (Array.isArray(lista)) viagensManuais = lista.filter((v) => v && Array.isArray(v.paragens));
  } catch (err) {
    console.warn('Viagens manuais ilegíveis:', err);
  }
}

function gravarManuais() {
  try {
    localStorage.setItem(MANUAIS_KEY, JSON.stringify(viagensManuais));
  } catch (err) {
    console.warn('Não foi possível gravar viagens manuais:', err);
  }
}

function novoIdManual() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/* ---------------- Renderização: lista de viagens existentes ---------------- */

function viagemLinha(trip) {
  const chave = chaveViagem(trip);
  const oculta = viagensOcultas.has(chave);
  const tipo = tipoLabel(trip.tipoServico);

  const acao = oculta
    ? `<button type="button" class="viagem-reativar flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-700 transition hover:bg-brand-100" data-reativar="${esc(chave)}">${olhoSVG()} Reativar</button>`
    : `<button type="button" class="viagem-ocultar flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200" data-ocultar="${esc(chave)}">${olhoCortadoSVG()} Ocultar</button>`;

  return `
    <li class="flex items-center gap-3 px-4 py-3 ${oculta ? 'opacity-60' : ''}">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          ${oculta ? '<span class="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Ocultada</span>' : ''}
          <span class="truncate text-sm font-bold text-slate-900">${esc(trip.origem)} <span class="text-brand-600">→</span> ${esc(trip.destino)}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span class="font-semibold tabular-nums text-slate-700">${esc(trip.partida)}–${esc(trip.chegada)}</span>
          ${trip.linha ? `<span>· ${esc(trip.linha)}</span>` : ''}
          ${trip.operador ? `<span>· ${esc(trip.operador)}</span>` : ''}
          ${tipo ? `<span>· ${esc(tipo)}</span>` : ''}
        </div>
      </div>
      <div class="shrink-0">${acao}</div>
    </li>`;
}

function renderViagens() {
  const box = document.getElementById('gestao-lista');
  if (!box) return;

  const filtro = norm(document.getElementById('gestao-filtro')?.value || '');

  let trips = state.trips;
  if (filtro) {
    trips = trips.filter((t) =>
      norm(`${t.origem} ${t.destino} ${t.linha} ${t.operador}`).includes(filtro)
    );
  }

  if (!trips.length) {
    box.innerHTML = `
      <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center">
        <p class="text-sm font-semibold text-slate-600">${filtro ? 'Sem resultados para a pesquisa' : 'Nenhuma viagem carregada'}</p>
        <p class="mt-1 text-xs text-slate-400">${filtro ? 'Tente outro termo.' : 'Verifique se horarios.json está acessível.'}</p>
      </div>`;
    return;
  }

  // Limita a renderização para manter a página fluida.
  const MAX = 400;
  const visiveis = trips.slice(0, MAX);
  const nota = trips.length > MAX
    ? `<p class="px-4 py-2 text-[11px] text-slate-400">A mostrar ${MAX} de ${trips.length} viagens. Refine a pesquisa.</p>`
    : '';

  box.innerHTML = `<ul class="divide-y divide-slate-100">${visiveis.map(viagemLinha).join('')}</ul>${nota}`;
  ligarViagens();
}

function ligarViagens() {
  const box = document.getElementById('gestao-lista');
  if (!box) return;

  box.querySelectorAll('[data-ocultar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chave = btn.getAttribute('data-ocultar');
      const trip = state.trips.find((t) => chaveViagem(t) === chave);
      if (!trip) return;
      ocultarViagem(trip);
      renderViagens();
      renderAlteracoes();
      atualizarResumo();
    });
  });

  box.querySelectorAll('[data-reativar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      reativarViagem(btn.getAttribute('data-reativar'));
      renderViagens();
      renderAlteracoes();
      atualizarResumo();
    });
  });
}

/* ---------------- Renderização: alterações registadas ---------------- */

function alteracaoLinha(item) {
  const isManual = item.tipo === 'manual';
  const etiqueta = isManual
    ? '<span class="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">Manual</span>'
    : '<span class="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Ocultada</span>';

  const acao = isManual
    ? `<button type="button" class="alteracao-eliminar flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" data-manual-id="${esc(item.id)}" aria-label="Eliminar viagem manual" title="Eliminar">${lixoSVG()}</button>`
    : `<button type="button" class="alteracao-reativar flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-brand-50 hover:text-brand-600" data-reativar="${esc(item.chave)}" aria-label="Reativar viagem" title="Reativar">${olhoSVG()}</button>`;

  return `
    <li class="flex items-center gap-3 px-4 py-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          ${etiqueta}
          <span class="truncate text-sm font-bold text-slate-900">${esc(item.origem)} <span class="text-brand-600">→</span> ${esc(item.destino)}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span class="font-semibold tabular-nums text-slate-700">${esc(item.partida)}–${esc(item.chegada)}</span>
          ${item.linha ? `<span>· ${esc(item.linha)}</span>` : ''}
          ${item.operador ? `<span>· ${esc(item.operador)}</span>` : ''}
          ${item.tipoLabel ? `<span>· ${esc(item.tipoLabel)}</span>` : ''}
        </div>
      </div>
      <div class="shrink-0">${acao}</div>
    </li>`;
}

function renderAlteracoes() {
  const box = document.getElementById('alteracoes-lista');
  if (!box) return;

  const ocultadas = [...viagensOcultas.values()].map((o) => ({ tipo: 'oculta', ...o }));

  const manuais = viagensManuais.map((v) => {
    const ps = (v.paragens || []).filter((p) => isValidStopName(p.nome));
    const primeira = ps[0] || { nome: '—', hora: '—' };
    const ultima = ps[ps.length - 1] || { nome: '—', hora: '—' };
    return {
      tipo: 'manual',
      id: v.id,
      origem: primeira.nome,
      destino: ultima.nome,
      partida: primeira.hora || '—',
      chegada: ultima.hora || '—',
      linha: v.linha || '',
      operador: v.operador || '',
      tipoLabel: tipoLabel(v.tipoServico),
    };
  });

  const itens = [...manuais, ...ocultadas];

  if (!itens.length) {
    box.innerHTML = '<p class="px-1 py-6 text-center text-sm font-semibold text-slate-400">Sem alterações.</p>';
    return;
  }

  box.innerHTML = `<ul class="divide-y divide-slate-100">${itens.map(alteracaoLinha).join('')}</ul>`;
  ligarAlteracoes();
}

function ligarAlteracoes() {
  const box = document.getElementById('alteracoes-lista');
  if (!box) return;

  box.querySelectorAll('[data-reativar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      reativarViagem(btn.getAttribute('data-reativar'));
      renderViagens();
      renderAlteracoes();
      atualizarResumo();
    });
  });

  box.querySelectorAll('[data-manual-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-manual-id');
      viagensManuais = viagensManuais.filter((v) => v.id !== id);
      gravarManuais();
      renderAlteracoes();
      atualizarResumo();
    });
  });
}

function atualizarResumo() {
  const el = document.getElementById('admin-resumo');
  if (!el) return;
  const nOcultas = viagensOcultas.size;
  const nManuais = viagensManuais.length;
  const total = nOcultas + nManuais;
  el.textContent = `${total} alteraç${total === 1 ? 'ão' : 'ões'} · ${nOcultas} ocultada${nOcultas === 1 ? '' : 's'} · ${nManuais} ${nManuais === 1 ? 'manual' : 'manuais'}`;
}

/* ---------------- Formulário: viagem manual ---------------- */

function adicionarLinhaParagem(nome = '', hora = '') {
  const cont = document.getElementById('m-paragens');
  if (!cont) return;
  const row = document.createElement('div');
  row.className = 'paragem-row flex items-center gap-2';
  row.innerHTML = `
    <input type="text" list="stops-list" placeholder="Paragem" value="${esc(nome)}"
           class="paragem-nome min-w-0 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-600 focus:bg-white focus:ring-4 focus:ring-brand-600/15" />
    <input type="time" value="${esc(hora)}"
           class="paragem-hora w-28 shrink-0 rounded-xl border border-slate-300 bg-slate-50 px-2 py-2 text-sm font-medium tabular-nums text-slate-900 outline-none transition focus:border-brand-600 focus:bg-white focus:ring-4 focus:ring-brand-600/15" />
    <button type="button" class="paragem-remover flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" aria-label="Remover paragem">
      ${lixoSVG()}
    </button>`;
  row.querySelector('.paragem-remover').addEventListener('click', () => row.remove());
  cont.appendChild(row);
}

function submeterManual() {
  const erro = document.getElementById('m-erro');
  const mostrarErro = (msg) => {
    if (!erro) return;
    erro.textContent = msg;
    erro.classList.remove('hidden');
  };
  if (erro) erro.classList.add('hidden');

  const linha = document.getElementById('m-linha').value.trim();
  const operador = document.getElementById('m-operador').value.trim();
  const sentido = document.getElementById('m-sentido').value.trim();
  const tipoServico = document.getElementById('m-dias').value;

  const paragens = [...document.querySelectorAll('#m-paragens .paragem-row')]
    .map((row) => ({
      nome: row.querySelector('.paragem-nome').value.trim(),
      hora: row.querySelector('.paragem-hora').value.trim(),
    }))
    .filter((p) => p.nome || p.hora);

  if (paragens.length < 2) return mostrarErro('Adicione pelo menos duas paragens.');
  for (const p of paragens) {
    if (!isValidStopName(p.nome)) return mostrarErro(`Paragem inválida: "${p.nome || '(vazia)'}".`);
    if (toMinutes(p.hora) == null) return mostrarErro(`Hora inválida em "${p.nome}". Use o formato HH:MM.`);
  }
  for (let i = 1; i < paragens.length; i++) {
    if (toMinutes(paragens[i].hora) < toMinutes(paragens[i - 1].hora)) {
      return mostrarErro(`As horas devem ser crescentes (${paragens[i - 1].nome} → ${paragens[i].nome}).`);
    }
  }

  viagensManuais.push({
    id: novoIdManual(),
    linha: linha || '—',
    operador: operador || '—',
    sentido,
    tipoServico,
    paragens,
  });
  gravarManuais();

  // Limpa o formulário.
  document.getElementById('form-manual').reset();
  document.getElementById('m-paragens').innerHTML = '';
  adicionarLinhaParagem();
  adicionarLinhaParagem();

  renderAlteracoes();
  atualizarResumo();
  setStatus('Viagem manual guardada com sucesso.');
}

/* ---------------- Exportação / Restauro ---------------- */

/* Gera o JSON consolidado: oficiais (sem ocultadas) + manuais. */
function construirBaseConsolidada() {
  const base = JSON.parse(JSON.stringify(state.data));

  // 1) Remover viagens ocultadas dos serviços oficiais.
  for (const servico of base.servicos) {
    for (const sentido of servico.sentidos || []) {
      const paragens = sentido.paragens || [];
      for (const oculta of viagensOcultas.values()) {
        const oi = paragens.findIndex((p) => norm(p.nome) === norm(oculta.origem));
        const di = paragens.findIndex((p) => norm(p.nome) === norm(oculta.destino));
        if (oi < 0 || di < 0 || oi === di) continue;
        if (oculta.linha && servico.linha && oculta.linha !== servico.linha) continue;
        if (oculta.operador && servico.operador && oculta.operador !== servico.operador) continue;
        paragens[oi].horarios = (paragens[oi].horarios || []).filter((h) => h !== oculta.partida);
        paragens[di].horarios = (paragens[di].horarios || []).filter((h) => h !== oculta.chegada);
      }
    }
  }

  // 2) Acrescentar viagens manuais como novos serviços.
  for (const v of viagensManuais) {
    base.servicos.push({
      operador: v.operador || '—',
      fonte: 'manual',
      linha: v.linha || '—',
      sentidos: [{
        nome: v.sentido || '',
        tipo_servico: v.tipoServico || null,
        paragens: v.paragens.map((p) => ({ nome: p.nome, horarios: [p.hora] })),
      }],
    });
  }

  return base;
}

function exportarBase() {
  try {
    if (!state.data) {
      setStatus('Ainda não há dados carregados para exportar.', true);
      return;
    }
    const base = construirBaseConsolidada();
    const blob = new Blob([JSON.stringify(base, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'horarios.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('horarios.json atualizado descarregado.');
  } catch (err) {
    console.error(err);
    setStatus('Erro ao exportar: ' + err.message, true);
  }
}

function restaurarFabrica() {
  if (!confirm('Repor os dados de fábrica? Isto apaga todas as viagens ocultadas e manuais.')) return;
  viagensOcultas = new Map();
  viagensManuais = [];
  try {
    localStorage.removeItem(OCULTAS_KEY);
    localStorage.removeItem(MANUAIS_KEY);
  } catch (err) {
    console.warn(err);
  }
  renderViagens();
  renderAlteracoes();
  atualizarResumo();
  setStatus('Dados de fábrica restaurados.');
}

/* ---------------- Mensagens & Reportes (localStorage) ---------------- */

const REPORTES_KEY = 'ra_reportes_erros';

function carregarReportes() {
  try {
    const raw = localStorage.getItem(REPORTES_KEY);
    const lista = raw ? JSON.parse(raw) : [];
    return Array.isArray(lista) ? lista : [];
  } catch (err) {
    console.warn('Reportes ilegíveis:', err);
    return [];
  }
}

function gravarReportes(lista) {
  try {
    localStorage.setItem(REPORTES_KEY, JSON.stringify(lista));
  } catch (err) {
    console.warn('Não foi possível gravar reportes:', err);
  }
}

function atualizarBadgeMensagens() {
  const badge = document.getElementById('mensagens-badge');
  if (!badge) return;
  const naoLidas = carregarReportes().filter((r) => !r.lida).length;
  badge.textContent = String(naoLidas);
  badge.classList.toggle('hidden', naoLidas === 0);
}

function formatarDataReporte(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '—';
    return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso || '—';
  }
}

function renderMensagens() {
  const box = document.getElementById('mensagens-lista');
  const resumo = document.getElementById('mensagens-resumo');
  if (!box) return;

  const lista = carregarReportes().sort((a, b) => String(b.data).localeCompare(String(a.data)));
  const naoLidas = lista.filter((r) => !r.lida).length;
  if (resumo) {
    resumo.textContent = lista.length
      ? `${lista.length} reporte${lista.length === 1 ? '' : 's'} · ${naoLidas} não lida${naoLidas === 1 ? '' : 's'}`
      : 'Sem reportes';
  }

  if (!lista.length) {
    box.innerHTML = `
      <div class="rounded-2xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-slate-200/70">
        <p class="text-sm font-semibold text-slate-500">Ainda não há reportes submetidos.</p>
        <p class="mt-1 text-xs text-slate-400">Os reportes enviados na app aparecem aqui.</p>
      </div>`;
    return;
  }

  box.innerHTML = lista.map((r) => `
    <article class="mb-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ${r.lida ? 'ring-slate-200/70' : 'ring-brand-300'}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="truncate text-sm font-bold text-slate-900">${esc(r.assunto || '(sem assunto)')}</h3>
            ${r.lida
              ? '<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Lida</span>'
              : '<span class="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">Nova</span>'}
          </div>
          <p class="mt-0.5 text-[11px] font-medium text-slate-400">${esc(formatarDataReporte(r.data))} · ${esc(r.email || '—')}</p>
        </div>
      </div>
      <p class="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">${esc(r.mensagem || '')}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" data-reporte-lida="${esc(r.id)}"
                class="rounded-full px-3 py-1.5 text-xs font-bold transition active:scale-95 ${r.lida ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-brand-600 text-white hover:bg-brand-700'}">
          ${r.lida ? 'Marcar como não lida' : 'Marcar como lida'}
        </button>
        <button type="button" data-reporte-eliminar="${esc(r.id)}"
                class="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-600 ring-1 ring-rose-200 transition hover:bg-rose-100 active:scale-95">
          Eliminar
        </button>
      </div>
    </article>`).join('');

  box.querySelectorAll('[data-reporte-lida]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-reporte-lida');
      const lista2 = carregarReportes();
      const item = lista2.find((r) => r.id === id);
      if (item) { item.lida = !item.lida; gravarReportes(lista2); }
      renderMensagens();
      atualizarBadgeMensagens();
    });
  });

  box.querySelectorAll('[data-reporte-eliminar]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-reporte-eliminar');
      const lista2 = carregarReportes().filter((r) => r.id !== id);
      gravarReportes(lista2);
      renderMensagens();
      atualizarBadgeMensagens();
    });
  });
}

function abrirMensagens() {
  const modal = document.getElementById('mensagens-modal');
  if (!modal) return;
  renderMensagens();
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function fecharMensagens() {
  const modal = document.getElementById('mensagens-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function ligarMensagens() {
  const btn = document.getElementById('btn-mensagens');
  const fechar = document.getElementById('mensagens-fechar');
  const overlay = document.getElementById('mensagens-overlay');
  if (!btn) return;

  btn.addEventListener('click', abrirMensagens);
  fechar?.addEventListener('click', fecharMensagens);
  overlay?.addEventListener('click', fecharMensagens);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('mensagens-modal')?.classList.contains('hidden')) {
      fecharMensagens();
    }
  });

  atualizarBadgeMensagens();
}

/* ---------------- Inicialização ---------------- */

function bindEvents() {
  const btnAdd = document.getElementById('btn-add-paragem');
  if (btnAdd) btnAdd.addEventListener('click', () => adicionarLinhaParagem());

  const form = document.getElementById('form-manual');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); submeterManual(); });

  const filtro = document.getElementById('gestao-filtro');
  if (filtro) filtro.addEventListener('input', renderViagens);

  const btnExp = document.getElementById('btn-exportar');
  if (btnExp) btnExp.addEventListener('click', exportarBase);

  const btnRes = document.getElementById('btn-restaurar');
  if (btnRes) btnRes.addEventListener('click', restaurarFabrica);

  ligarMensagens();
}

async function init() {
  // Overrides do localStorage (independentes do fetch).
  carregarOcultas();
  carregarManuais();
  atualizarResumo();

  // Formulário começa com duas paragens (origem + destino).
  adicionarLinhaParagem();
  adicionarLinhaParagem();

  bindEvents();

  try {
    await loadData();
    buildStops();
    populateDatalist();
    buildTrips();
    renderViagens();
    renderAlteracoes();
    atualizarResumo();
    setStatus(`${state.trips.length} viagens carregadas de horarios.json.`);
  } catch (err) {
    console.error(err);
    setStatus('Erro ao carregar horarios.json — ' + err.message + ' (sirva a pasta com um servidor HTTP).', true);
    renderViagens();
    renderAlteracoes();
  }
}

document.addEventListener('DOMContentLoaded', init);
