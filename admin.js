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
const ALTERACOES_KEY = 'ra_alteracoes_linhas';

/* Email autorizado a aceder ao painel (bloqueio simples, sem OAuth). */
const ADMIN_EMAIL = 'hugo.henrique.frade@gmail.com';
const ADMIN_SESSAO_KEY = 'admin_autenticado';

const state = {
  data: null,   // conteúdo de horarios.json
  stops: [],    // nomes únicos e válidos para o <datalist>
  trips: [],    // viagens oficiais achatadas
  linhas: [],   // linhas/serviços agrupados (gestão por linha)
};

let viagensOcultas = new Map(); // chave -> { chave, origem, destino, partida, chegada, linha, operador }
let viagensManuais = [];        // { id, linha, operador, sentido, tipoServico, paragens: [{nome, hora}] }
let alteracoesLinhas = [];      // { id, chave, linha, operador, fonte, resumo, data }

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

/* ---------------- Agrupamento por LINHA / SERVIÇO ----------------
   Em vez de listar dezenas de milhares de pares origem-destino, agrupamos
   cada serviço oficial numa "linha" única (ex.: "Linha 2 - BEJA - VILA DE
   FRADES"). Cada linha agrega os seus sentidos, a sequência de paragens e o
   PDF associado (fonte). */

/* Chave estável de uma linha: linha + operador + fonte (PDF). */
function chaveLinha(servico) {
  return [norm(servico.linha), norm(servico.operador), norm(servico.fonte)].join('|');
}

/* Constrói a lista de linhas agrupadas a partir dos serviços oficiais. */
function buildLinhas() {
  const mapa = new Map();

  for (const servico of state.data.servicos) {
    const chave = chaveLinha(servico);
    let linha = mapa.get(chave);
    if (!linha) {
      linha = {
        chave,
        linha: servico.linha || '—',
        operador: servico.operador || '—',
        fonte: servico.fonte || '',
        sentidos: [],
        paragens: [],       // sequência única de paragens (ordem de aparição)
        paragensSet: new Set(),
        totalParagens: 0,
        totalViagens: 0,
      };
      mapa.set(chave, linha);
    }

    for (const sentido of servico.sentidos || []) {
      const paragens = (sentido.paragens || []).filter((p) => isValidStopName(p.nome));
      if (!paragens.length) continue;

      linha.sentidos.push({
        nome: sentido.nome || '',
        tipoServico: sentido.tipo_servico || null,
        periodo: sentido.periodo || null,
        paragens: paragens.map((p) => ({ nome: p.nome, horarios: [...(p.horarios || [])] })),
      });

      for (const p of paragens) {
        const n = norm(p.nome);
        if (!linha.paragensSet.has(n)) {
          linha.paragensSet.add(n);
          linha.paragens.push(p.nome);
        }
      }
    }
  }

  // Calcula totais e descarta linhas sem paragens válidas.
  const linhas = [];
  for (const linha of mapa.values()) {
    if (!linha.sentidos.length) continue;
    linha.totalParagens = linha.paragens.length;
    linha.totalViagens = linha.sentidos.reduce((acc, s) => acc + s.paragens.length, 0);
    delete linha.paragensSet;
    linhas.push(linha);
  }

  // Ordena por nome de linha (natural, com números).
  linhas.sort((a, b) => a.linha.localeCompare(b.linha, 'pt', { numeric: true, sensitivity: 'base' }));
  state.linhas = linhas;
}

/* Verifica se uma linha está oculta (todas as suas viagens ocultas). */
function linhaOculta(linha) {
  let total = 0;
  let ocultas = 0;
  for (const sentido of linha.sentidos) {
    const paragens = sentido.paragens;
    for (let oi = 0; oi < paragens.length; oi++) {
      const pOrigem = paragens[oi];
      for (let di = oi + 1; di < paragens.length; di++) {
        const pDestino = paragens[di];
        const pares = emparelharHorarios(pOrigem.horarios, pDestino.horarios);
        for (const par of pares) {
          total++;
          const chave = chaveViagem({
            origem: pOrigem.nome,
            destino: pDestino.nome,
            partida: par.partida,
            chegada: par.chegada,
            linha: linha.linha,
            operador: linha.operador,
          });
          if (viagensOcultas.has(chave)) ocultas++;
        }
      }
    }
  }
  return total > 0 && ocultas >= total;
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

/* ---------------- Camada: alterações registadas (log de edições) ----------------
   Cada vez que uma linha é editada no modal, registamos aqui um log para que o
   painel "Alterações registadas" reflita imediatamente a ação. */

function carregarAlteracoes() {
  alteracoesLinhas = [];
  try {
    const raw = localStorage.getItem(ALTERACOES_KEY);
    if (!raw) return;
    const lista = JSON.parse(raw);
    if (Array.isArray(lista)) alteracoesLinhas = lista.filter((a) => a && typeof a.chave === 'string');
  } catch (err) {
    console.warn('Alterações de linhas ilegíveis:', err);
  }
}

function gravarAlteracoes() {
  try {
    localStorage.setItem(ALTERACOES_KEY, JSON.stringify(alteracoesLinhas));
  } catch (err) {
    console.warn('Não foi possível gravar alterações de linhas:', err);
  }
}

/* Regista (ou atualiza) o log de uma linha editada. */
function registarAlteracaoLinha({ chave, linha, operador, fonte, resumo }) {
  const existente = alteracoesLinhas.find((a) => a.chave === chave);
  const registo = {
    id: existente ? existente.id : 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    chave,
    linha: linha || '—',
    operador: operador || '',
    fonte: fonte || '',
    resumo: resumo || 'Linha atualizada',
    data: new Date().toISOString(),
  };
  if (existente) {
    Object.assign(existente, registo);
  } else {
    alteracoesLinhas.unshift(registo);
  }
  gravarAlteracoes();
  return registo;
}

function removerAlteracaoLinha(id) {
  alteracoesLinhas = alteracoesLinhas.filter((a) => a.id !== id);
  gravarAlteracoes();
}

/* ---------------- Renderização: lista de LINHAS existentes ---------------- */

/* Ícone de documento/PDF. */
function pdfSVG() {
  return `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </svg>`;
}

/* Ícone de lápis (editar). */
function lapisSVG() {
  return `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>`;
}

/* Uma linha da lista de gestão: nome, nº de paragens, PDF e ações. */
function linhaItem(linha) {
  const oculta = linhaOculta(linha);
  const nParagens = linha.totalParagens;
  const nSentidos = linha.sentidos.length;

  const acaoOcultar = oculta
    ? `<button type="button" class="linha-reativar flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-700 transition hover:bg-brand-100" data-reativar-linha="${esc(linha.chave)}">${olhoSVG()} Reativar</button>`
    : `<button type="button" class="linha-ocultar flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200" data-ocultar-linha="${esc(linha.chave)}">${olhoCortadoSVG()} Ocultar</button>`;

  return `
    <li class="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center ${oculta ? 'opacity-60' : ''}">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          ${oculta ? '<span class="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Ocultada</span>' : ''}
          <span class="truncate text-sm font-bold text-slate-900">${esc(linha.linha)}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span class="font-semibold text-slate-700">${nParagens} paragen${nParagens === 1 ? '' : 's'}</span>
          <span>· ${nSentidos} sentido${nSentidos === 1 ? '' : 's'}</span>
          ${linha.operador && linha.operador !== '—' ? `<span>· ${esc(linha.operador)}</span>` : ''}
          ${linha.fonte ? `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">${pdfSVG()} ${esc(linha.fonte)}</span>` : ''}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button type="button" class="linha-editar flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-700" data-editar-linha="${esc(linha.chave)}">${lapisSVG()} Editar</button>
        ${acaoOcultar}
      </div>
    </li>`;
}

function renderViagens() {
  const box = document.getElementById('gestao-lista');
  if (!box) return;

  const filtro = norm(document.getElementById('gestao-filtro')?.value || '');

  let linhas = state.linhas;
  if (filtro) {
    linhas = linhas.filter((l) => {
      // Filtra pelo nome da linha, operador, PDF ou QUALQUER localidade do percurso.
      const alvo = norm(`${l.linha} ${l.operador} ${l.fonte} ${l.paragens.join(' ')}`);
      return alvo.includes(filtro);
    });
  }

  if (!linhas.length) {
    box.innerHTML = `
      <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center">
        <p class="text-sm font-semibold text-slate-600">${filtro ? 'Sem resultados para a pesquisa' : 'Nenhuma linha carregada'}</p>
        <p class="mt-1 text-xs text-slate-400">${filtro ? 'Tente outro termo.' : 'Verifique se horarios.json está acessível.'}</p>
      </div>`;
    return;
  }

  const nota = `<p class="px-4 py-2 text-[11px] text-slate-400">${linhas.length} linha${linhas.length === 1 ? '' : 's'}${filtro ? ' encontrada' + (linhas.length === 1 ? '' : 's') : ''}.</p>`;
  box.innerHTML = `<ul class="divide-y divide-slate-100">${linhas.map(linhaItem).join('')}</ul>${nota}`;
  ligarViagens();
}

function ligarViagens() {
  const box = document.getElementById('gestao-lista');
  if (!box) return;

  box.querySelectorAll('[data-editar-linha]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const linha = state.linhas.find((l) => l.chave === btn.getAttribute('data-editar-linha'));
      if (linha) abrirModalLinha(linha);
    });
  });

  box.querySelectorAll('[data-ocultar-linha]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const linha = state.linhas.find((l) => l.chave === btn.getAttribute('data-ocultar-linha'));
      if (!linha) return;
      ocultarLinha(linha);
      renderViagens();
      renderAlteracoes();
      atualizarResumo();
    });
  });

  box.querySelectorAll('[data-reativar-linha]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const linha = state.linhas.find((l) => l.chave === btn.getAttribute('data-reativar-linha'));
      if (!linha) return;
      reativarLinha(linha);
      renderViagens();
      renderAlteracoes();
      atualizarResumo();
    });
  });
}

/* ---------------- Ocultar / reativar LINHA inteira ---------------- */

/* Oculta todas as viagens (pares origem-destino) de uma linha. */
function ocultarLinha(linha) {
  for (const sentido of linha.sentidos) {
    const paragens = sentido.paragens;
    for (let oi = 0; oi < paragens.length; oi++) {
      const pOrigem = paragens[oi];
      for (let di = oi + 1; di < paragens.length; di++) {
        const pDestino = paragens[di];
        const pares = emparelharHorarios(pOrigem.horarios, pDestino.horarios);
        for (const par of pares) {
          ocultarViagem({
            origem: pOrigem.nome,
            destino: pDestino.nome,
            partida: par.partida,
            chegada: par.chegada,
            linha: linha.linha,
            operador: linha.operador,
          });
        }
      }
    }
  }
  gravarOcultas();
}

/* Reativa todas as viagens de uma linha. */
function reativarLinha(linha) {
  for (const sentido of linha.sentidos) {
    const paragens = sentido.paragens;
    for (let oi = 0; oi < paragens.length; oi++) {
      const pOrigem = paragens[oi];
      for (let di = oi + 1; di < paragens.length; di++) {
        const pDestino = paragens[di];
        const pares = emparelharHorarios(pOrigem.horarios, pDestino.horarios);
        for (const par of pares) {
          const chave = chaveViagem({
            origem: pOrigem.nome,
            destino: pDestino.nome,
            partida: par.partida,
            chegada: par.chegada,
            linha: linha.linha,
            operador: linha.operador,
          });
          viagensOcultas.delete(chave);
        }
      }
    }
  }
  gravarOcultas();
}

/* ---------------- Modal de edição da linha ----------------
   Modelo padrão de Circulações/Viagens:
   - Secção A: rota (espinha dorsal) = lista ordenada de paragens.
   - Secção B: circulações = cada viagem tem calendário (período + dias) e
     uma tabela de horas por paragem (vazio/"-" = não para). */

let linhaEmEdicao = null;

/* Períodos possíveis de uma viagem. */
const PERIODOS = [
  { id: 'escolar', label: 'Escolar' },
  { id: 'nao_escolar', label: 'Não Escolar' },
  { id: 'anual', label: 'Todo o Ano' },
];

/* Dias de funcionamento possíveis de uma viagem (select compacto). */
const DIAS = [
  { id: 'dias_uteis', label: 'Dias Úteis' },
  { id: 'sabado', label: 'Sábados' },
  { id: 'domingo', label: 'Domingos' },
  { id: 'todos_os_dias', label: 'Todos os dias' },
  { id: 'especificos', label: 'Dias Específicos...' },
  { id: 'evento', label: 'Período / Evento (Datas)...' },
];

/* Dias específicos da semana (mini-painel de alternância). O campo `dia`
   corresponde ao token usado no tipo_servico composto do JSON. */
const DIAS_ESPECIFICOS = [
  { id: 'seg', label: '2ª', dia: 'segunda_feira' },
  { id: 'ter', label: '3ª', dia: 'terca_feira' },
  { id: 'qua', label: '4ª', dia: 'quarta_feira' },
  { id: 'qui', label: '5ª', dia: 'quinta_feira' },
  { id: 'sex', label: '6ª', dia: 'sexta_feira' },
  { id: 'sab', label: 'Sáb', dia: 'sabado' },
  { id: 'dom', label: 'Dom', dia: 'domingo' },
];

/* Converte o tipo_servico do JSON para o modo de dias do modal. */
function diasDeTipo(tipo) {
  const t = String(tipo || '');
  if (t === 'todos_os_dias') return 'todos_os_dias';
  if (t === 'dias_uteis' || t === 'segunda_a_sexta') return 'dias_uteis';
  if (t === 'sabado') return 'sabado';
  if (t === 'domingo') return 'domingo';
  // Combinações de dias (ex.: segunda_feira_quarta_feira) → dias específicos.
  if (DIAS_ESPECIFICOS.some((d) => t.includes(d.dia))) return 'especificos';
  return 'dias_uteis';
}

/* Extrai os dias específicos de um tipo_servico composto. */
function diasEspecificosDeTipo(tipo) {
  const t = String(tipo || '');
  return DIAS_ESPECIFICOS.filter((d) => t.includes(d.dia)).map((d) => d.dia);
}

/* Converte o modo de dias do modal para o tipo_servico do JSON.
   Recebe o objeto da viagem (tem `dias` e `diasEspecificos`). */
function tipoDeDias(v) {
  const d = String(v.dias || 'dias_uteis');
  if (d === 'todos_os_dias') return 'todos_os_dias';
  if (d === 'sabado') return 'sabado';
  if (d === 'domingo') return 'domingo';
  if (d === 'especificos') {
    const dias = (v.diasEspecificos || []).filter(Boolean);
    return dias.length ? dias.join('_') : 'dias_uteis';
  }
  if (d === 'evento') return 'todos_os_dias';
  return 'dias_uteis';
}

/* Constrói o modelo de edição a partir de uma linha agrupada. */
function construirModeloEdicao(linha) {
  // Secção A: rota = paragens únicas por ordem de aparição.
  const rota = [...linha.paragens];

  // Secção B: expande cada sentido nas suas viagens (uma coluna por partida).
  // Em cada sentido, as paragens partilham `horarios[]` alinhado por índice:
  // o índice i é a i-ésima viagem. Vazio / "-" = não efetua serviço.
  const viagens = [];
  for (const sentido of linha.sentidos) {
    const paragens = sentido.paragens || [];
    const temEvento = !!(sentido.data_inicio || sentido.data_fim);
    const nColunas = paragens.reduce((m, p) => Math.max(m, (p.horarios || []).length), 0);
    for (let c = 0; c < nColunas; c++) {
      const horas = {};
      let temHora = false;
      for (const p of paragens) {
        const val = (p.horarios || [])[c];
        const hora = toMinutes(val) != null ? val : '';
        if (hora) temHora = true;
        horas[norm(p.nome)] = hora;
      }
      if (!temHora) continue; // coluna sem qualquer hora (ruído)
      viagens.push({
        nome: sentido.nome || '',
        periodo: sentido.periodo === 'escolar' ? 'escolar'
          : sentido.periodo === 'nao_escolar' ? 'nao_escolar' : 'anual',
        dias: temEvento ? 'evento' : diasDeTipo(sentido.tipoServico),
        diasEspecificos: diasEspecificosDeTipo(sentido.tipoServico),
        data_inicio: sentido.data_inicio || '',
        data_fim: sentido.data_fim || '',
        horas,
      });
    }
  }

  return { rota, viagens };
}

function abrirModalLinha(linha) {
  const modal = document.getElementById('linha-modal');
  if (!modal) return;

  linhaEmEdicao = {
    chave: linha.chave,
    linha: linha.linha,
    operador: (linha.operador && linha.operador !== '—') ? linha.operador : '',
    fonte: linha.fonte || '',
    modelo: construirModeloEdicao(linha),
  };

  document.getElementById('linha-modal-titulo').textContent = linha.linha;
  document.getElementById('linha-modal-operador').value = linhaEmEdicao.operador;
  document.getElementById('linha-modal-fonte').value = linhaEmEdicao.fonte;

  renderMatriz();

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function fecharModalLinha() {
  const modal = document.getElementById('linha-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  linhaEmEdicao = null;
}

/* ===== Matriz de horários (paragens × viagens) ===== */

/* Renderiza a matriz: paragens na vertical, viagens nas colunas. */
function renderMatriz() {
  const box = document.getElementById('matriz-grid');
  if (!box || !linhaEmEdicao) return;
  const { rota, viagens } = linhaEmEdicao.modelo;

  if (!rota.length && !viagens.length) {
    box.innerHTML = `<p class="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-xs font-semibold text-slate-400">Sem dados. Use "Adicionar Paragem" para começar.</p>`;
    return;
  }

  const opcoesPeriodo = (sel) => PERIODOS.map((p) => `<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${p.label}</option>`).join('');
  const opcoesDias = (sel) => DIAS.map((d) => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>${d.label}</option>`).join('');

  // Cabeçalho das colunas (uma por viagem), com calendário + lixo.
  const cabecalho = viagens.map((v, vi) => {
    const diasEspecificosHtml = DIAS_ESPECIFICOS.map((d) => {
      const ativo = (v.diasEspecificos || []).includes(d.dia);
      const cls = ativo ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200';
      return `<button type="button" class="matriz-dia-toggle rounded-md px-1.5 py-1 text-[10px] font-bold transition ${cls}" data-campo="dias-especifico" data-viagem="${vi}" data-dia="${d.dia}" aria-pressed="${ativo}">${d.label}</button>`;
    }).join('');

    return `
    <th class="min-w-[170px] border-l border-slate-200 px-2 py-1.5 align-top">
      <div class="mb-1 flex items-center justify-between gap-1">
        <span class="min-w-0 truncate text-[11px] font-bold text-slate-700" title="${esc(v.nome)}">V${vi + 1}${v.nome ? ` · ${esc(v.nome)}` : ''}</span>
        <button type="button" class="matriz-remover-viagem flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" data-remover-viagem="${vi}" aria-label="Eliminar viagem ${vi + 1}" title="Eliminar viagem">${lixoSVG()}</button>
      </div>
      <select data-campo="periodo" data-viagem="${vi}" aria-label="Período da viagem ${vi + 1}"
              class="mb-1 w-full rounded-lg border border-slate-200 bg-white px-1 py-1 text-[11px] font-medium text-slate-700 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15">${opcoesPeriodo(v.periodo)}</select>
      <select data-campo="dias" data-viagem="${vi}" aria-label="Dias da viagem ${vi + 1}"
              class="w-full rounded-lg border border-slate-200 bg-white px-1 py-1 text-[11px] font-medium text-slate-700 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15">${opcoesDias(v.dias)}</select>
      <div class="matriz-dias-especificos mt-1 flex flex-wrap justify-center gap-1 ${v.dias === 'especificos' ? '' : 'hidden'}" data-viagem="${vi}">${diasEspecificosHtml}</div>
      <div class="matriz-evento-datas mt-1 space-y-1 ${v.dias === 'evento' ? '' : 'hidden'}" data-viagem="${vi}">
        <label class="flex items-center gap-1">
          <span class="shrink-0 text-[9px] font-semibold text-slate-400">De</span>
          <input type="date" value="${esc(v.data_inicio)}" data-campo="data_inicio" data-viagem="${vi}" aria-label="Data de início da viagem ${vi + 1}"
                 class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1 py-1 text-[11px] text-slate-700 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15" />
        </label>
        <label class="flex items-center gap-1">
          <span class="shrink-0 text-[9px] font-semibold text-slate-400">Até</span>
          <input type="date" value="${esc(v.data_fim)}" data-campo="data_fim" data-viagem="${vi}" aria-label="Data de fim da viagem ${vi + 1}"
                 class="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1 py-1 text-[11px] text-slate-700 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15" />
        </label>
      </div>
    </th>`;
  }).join('');

  // Linhas (paragens) com células de hora por viagem.
  const linhas = rota.map((nome, pi) => {
    const chave = norm(nome);
    const celulas = viagens.map((v, vi) => {
      const hora = v.horas[chave] || '';
      const vazio = !toMinutes(hora);
      return `<td class="border-l border-slate-100 p-1">
        <input type="text" value="${esc(hora)}" data-campo="hora" data-viagem="${vi}" data-paragem="${pi}"
               placeholder="--:--" inputmode="numeric" aria-label="Hora de ${esc(nome)} na viagem ${vi + 1}"
               class="w-full rounded-lg border px-1.5 py-1.5 text-center text-xs font-bold tabular-nums outline-none transition focus:border-brand-600 focus:ring-4 focus:ring-brand-600/15 ${vazio ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-slate-300 bg-white text-slate-900'}" />
      </td>`;
    }).join('');
    return `<tr>
      <th class="min-w-[160px] border-r border-slate-200 bg-white px-2 py-1.5 text-left">
        <input type="text" value="${esc(nome)}" data-campo="paragem-nome" data-paragem="${pi}"
               placeholder="Nome da paragem"
               class="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-semibold text-slate-900 outline-none transition focus:border-brand-600 focus:bg-white focus:ring-4 focus:ring-brand-600/15" />
      </th>
      ${celulas}
    </tr>`;
  }).join('');

  box.innerHTML = `<table class="min-w-full border-collapse text-xs">
    <thead><tr>
      <th class="min-w-[160px] border-b border-r border-slate-200 bg-slate-50 px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">Paragem</th>
      ${cabecalho}
    </tr></thead>
    <tbody>${linhas}</tbody>
  </table>`;

  ligarMatriz();
}

/* Lê as edições (nomes de paragem e horas) de volta para o modelo. */
function sincronizarMatriz() {
  const box = document.getElementById('matriz-grid');
  if (!box || !linhaEmEdicao) return;
  const { rota, viagens } = linhaEmEdicao.modelo;

  box.querySelectorAll('[data-campo="paragem-nome"]').forEach((input) => {
    const pi = Number(input.getAttribute('data-paragem'));
    if (rota[pi] != null) rota[pi] = input.value.trim();
  });

  box.querySelectorAll('[data-campo="hora"]').forEach((input) => {
    const vi = Number(input.getAttribute('data-viagem'));
    const pi = Number(input.getAttribute('data-paragem'));
    const nome = rota[pi];
    const viagem = viagens[vi];
    if (nome == null || !viagem) return;
    const val = input.value.trim();
    viagem.horas[norm(nome)] = toMinutes(val) != null ? val : '';
  });

  box.querySelectorAll('[data-campo="periodo"]').forEach((sel) => {
    const vi = Number(sel.getAttribute('data-viagem'));
    if (viagens[vi]) viagens[vi].periodo = sel.value;
  });

  box.querySelectorAll('[data-campo="dias"]').forEach((sel) => {
    const vi = Number(sel.getAttribute('data-viagem'));
    if (viagens[vi]) viagens[vi].dias = sel.value;
  });

  // Dias específicos (alternância de botões).
  box.querySelectorAll('[data-campo="dias-especifico"]').forEach((btn) => {
    const vi = Number(btn.getAttribute('data-viagem'));
    const viagem = viagens[vi];
    if (!viagem) return;
    const dia = btn.getAttribute('data-dia');
    const ativo = btn.getAttribute('aria-pressed') === 'true';
    const set = new Set(viagem.diasEspecificos || []);
    if (ativo) set.add(dia); else set.delete(dia);
    viagem.diasEspecificos = [...set];
  });

  // Evento: intervalo de datas.
  box.querySelectorAll('[data-campo="data_inicio"]').forEach((input) => {
    const vi = Number(input.getAttribute('data-viagem'));
    if (viagens[vi]) viagens[vi].data_inicio = input.value.trim();
  });
  box.querySelectorAll('[data-campo="data_fim"]').forEach((input) => {
    const vi = Number(input.getAttribute('data-viagem'));
    if (viagens[vi]) viagens[vi].data_fim = input.value.trim();
  });
}

/* Liga os controlos da matriz (eliminar viagem, dias específicos, modo de dias). */
function ligarMatriz() {
  const box = document.getElementById('matriz-grid');
  if (!box || !linhaEmEdicao) return;

  // Eliminar viagem (coluna inteira).
  box.querySelectorAll('[data-remover-viagem]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sincronizarMatriz();
      const vi = Number(btn.getAttribute('data-remover-viagem'));
      linhaEmEdicao.modelo.viagens.splice(vi, 1);
      renderMatriz();
    });
  });

  // Alternância de dias específicos da semana.
  box.querySelectorAll('.matriz-dia-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ativo = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!ativo));
      if (!ativo) {
        btn.classList.remove('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
        btn.classList.add('bg-brand-600', 'text-white');
      } else {
        btn.classList.remove('bg-brand-600', 'text-white');
        btn.classList.add('bg-slate-100', 'text-slate-600', 'hover:bg-slate-200');
      }
    });
  });

  // Mudança do modo de dias → re-renderiza para mostrar/ocultar o mini-painel.
  box.querySelectorAll('[data-campo="dias"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      sincronizarMatriz();
      renderMatriz();
    });
  });
}

/* ===== Guardar: compila cada viagem para o formato do JSON ===== */

function guardarModalLinha() {
  if (!linhaEmEdicao) return;
  sincronizarMatriz();

  const novoOperador = document.getElementById('linha-modal-operador').value.trim();
  const novaFonte = document.getElementById('linha-modal-fonte').value.trim();
  const rota = linhaEmEdicao.modelo.rota.filter((n) => isValidStopName(n));
  const chaves = rota.map((n) => norm(n));

  // Agrupa as viagens por (sentido, período, dias, dias específicos, evento)
  // para reconstruir os sentidos, preservando as várias colunas de horários.
  const grupos = new Map();
  for (const v of linhaEmEdicao.modelo.viagens) {
    const chave = [
      norm(v.nome || ''),
      v.periodo,
      String(v.dias || ''),
      (v.diasEspecificos || []).slice().sort().join(','),
      v.data_inicio || '',
      v.data_fim || '',
    ].join('|');
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        nome: v.nome || '', periodo: v.periodo, dias: v.dias,
        diasEspecificos: v.diasEspecificos || [],
        data_inicio: v.data_inicio || '', data_fim: v.data_fim || '',
        trips: [],
      });
    }
    grupos.get(chave).trips.push(v);
  }

  const sentidos = [];
  for (const g of grupos.values()) {
    const paragens = chaves.map((chave, i) => ({ nome: rota[i], horarios: [] }));
    for (const trip of g.trips) {
      chaves.forEach((chave, i) => {
        const hora = trip.horas[chave];
        paragens[i].horarios.push(toMinutes(hora) != null ? hora : '-');
      });
    }
    const paragensFinais = paragens.filter((p) => p.horarios.some((h) => toMinutes(h) != null));
    if (paragensFinais.length < 2) continue; // precisa de origem + destino
    const sentido = {
      nome: g.nome || `${paragensFinais[0].nome} → ${paragensFinais[paragensFinais.length - 1].nome}`,
      tipo_servico: tipoDeDias(g),
      periodo: g.periodo,
      paragens: paragensFinais,
    };
    // Evento: guarda o intervalo de datas.
    if (g.dias === 'evento') {
      if (g.data_inicio) sentido.data_inicio = g.data_inicio;
      if (g.data_fim) sentido.data_fim = g.data_fim;
    }
    sentidos.push(sentido);
  }

  // Aplica as alterações ao serviço correspondente em state.data.
  const chave = linhaEmEdicao.chave;
  for (const servico of state.data.servicos) {
    if (chaveLinha(servico) !== chave) continue;
    servico.operador = novoOperador || null;
    servico.fonte = novaFonte || servico.fonte;
    servico.sentidos = sentidos;
  }

  // Reconstrói as estruturas derivadas.
  buildStops();
  populateDatalist();
  buildTrips();
  buildLinhas();
  renderViagens();

  // Regista a alteração no histórico (obrigatório).
  registarAlteracaoLinha({
    chave,
    linha: linhaEmEdicao.linha,
    operador: novoOperador || '',
    fonte: novaFonte || '',
    resumo: 'Horários/Paragens atualizados',
  });
  renderAlteracoes();
  atualizarResumo();
  fecharModalLinha();
  setStatus('Linha atualizada com sucesso.');
}

/* ---------------- Renderização: alterações registadas ---------------- */

function alteracaoLinha(item) {
  const isManual = item.tipo === 'manual';
  const isEditada = item.tipo === 'editada';

  if (isEditada) {
    return `
    <li class="flex items-center gap-3 px-4 py-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">Editada</span>
          <span class="truncate text-sm font-bold text-slate-900">${esc(item.linha)}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
          <span class="font-semibold text-slate-700">${esc(item.resumo)}</span>
          ${item.operador ? `<span>· ${esc(item.operador)}</span>` : ''}
          ${item.fonte ? `<span>· ${esc(item.fonte)}</span>` : ''}
        </div>
      </div>
      <div class="shrink-0">
        <button type="button" class="alteracao-eliminar flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" data-alteracao-id="${esc(item.id)}" aria-label="Remover registo" title="Remover registo">${lixoSVG()}</button>
      </div>
    </li>`;
  }

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

  const editadas = alteracoesLinhas.map((a) => ({ tipo: 'editada', ...a }));

  const itens = [...editadas, ...manuais, ...ocultadas];

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

  box.querySelectorAll('[data-alteracao-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      removerAlteracaoLinha(btn.getAttribute('data-alteracao-id'));
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
  const nEditadas = alteracoesLinhas.length;
  const total = nOcultas + nManuais + nEditadas;
  el.textContent = `${total} alteraç${total === 1 ? 'ão' : 'ões'} · ${nEditadas} linha${nEditadas === 1 ? '' : 's'} editada${nEditadas === 1 ? '' : 's'} · ${nOcultas} ocultada${nOcultas === 1 ? '' : 's'} · ${nManuais} ${nManuais === 1 ? 'manual' : 'manuais'}`;
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

/* ---------------- Autenticação (bloqueio simples) ---------------- */

/* Mostra o painel e esconde o ecrã de bloqueio. */
function mostrarPainel() {
  const login = document.getElementById('login-card');
  const conteudo = document.getElementById('admin-content');
  if (login) login.style.display = 'none';
  if (conteudo) conteudo.style.display = '';
}

/* Mostra o ecrã de bloqueio e esconde o painel. */
function mostrarLogin() {
  const login = document.getElementById('login-card');
  const conteudo = document.getElementById('admin-content');
  if (login) login.style.display = '';
  if (conteudo) conteudo.style.display = 'none';
}

/* Verifica se já existe sessão autenticada. */
function verificarSessao() {
  if (localStorage.getItem(ADMIN_SESSAO_KEY) === 'true') {
    mostrarPainel();
    return true;
  }
  mostrarLogin();
  return false;
}

/* Processa a tentativa de entrada. */
function tentarEntrar() {
  const input = document.getElementById('login-email');
  const erro = document.getElementById('login-erro');
  const valor = String(input?.value || '').trim().toLowerCase();

  if (valor === ADMIN_EMAIL) {
    localStorage.setItem(ADMIN_SESSAO_KEY, 'true');
    if (erro) erro.classList.add('hidden');
    mostrarPainel();
  } else {
    if (erro) erro.classList.remove('hidden');
    input?.focus();
  }
}

/* Termina a sessão e recarrega a página. */
function sair() {
  localStorage.removeItem(ADMIN_SESSAO_KEY);
  location.reload();
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

  // Modal de edição de linha.
  const modalFechar = document.getElementById('linha-modal-fechar');
  if (modalFechar) modalFechar.addEventListener('click', fecharModalLinha);
  const modalOverlay = document.getElementById('linha-modal-overlay');
  if (modalOverlay) modalOverlay.addEventListener('click', fecharModalLinha);
  const modalGuardar = document.getElementById('linha-modal-guardar');
  if (modalGuardar) modalGuardar.addEventListener('click', guardarModalLinha);
  const modalCancelar = document.getElementById('linha-modal-cancelar');
  if (modalCancelar) modalCancelar.addEventListener('click', fecharModalLinha);

  // Adicionar paragem à rota (matriz).
  const rotaAdd = document.getElementById('rota-add-paragem');
  if (rotaAdd) rotaAdd.addEventListener('click', () => {
    if (!linhaEmEdicao) return;
    sincronizarMatriz();
    linhaEmEdicao.modelo.rota.push('');
    renderMatriz();
  });

  // Adicionar nova viagem (coluna em branco na matriz).
  const viagemAdd = document.getElementById('viagem-add');
  if (viagemAdd) viagemAdd.addEventListener('click', () => {
    if (!linhaEmEdicao) return;
    sincronizarMatriz();
    linhaEmEdicao.modelo.viagens.push({ nome: '', periodo: 'anual', dias: 'dias_uteis', horas: {} });
    renderMatriz();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharModalLinha();
  });

  ligarMensagens();
}

async function init() {
  // Liga sempre os eventos de login/sair (necessários antes da autenticação).
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', (e) => { e.preventDefault(); tentarEntrar(); });

  const btnSair = document.getElementById('btn-sair');
  if (btnSair) btnSair.addEventListener('click', sair);

  // Bloqueio de acesso: sem sessão válida, mostra o login e não carrega o painel.
  if (!verificarSessao()) return;

  // Overrides do localStorage (independentes do fetch).
  carregarOcultas();
  carregarManuais();
  carregarAlteracoes();
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
    buildLinhas();
    renderViagens();
    renderAlteracoes();
    atualizarResumo();
    setStatus(`${state.linhas.length} linhas carregadas de horarios.json.`);
  } catch (err) {
    console.error(err);
    setStatus('Erro ao carregar horarios.json — ' + err.message + ' (sirva a pasta com um servidor HTTP).', true);
    renderViagens();
    renderAlteracoes();
  }
}

document.addEventListener('DOMContentLoaded', init);
