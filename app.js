'use strict';

/* =============================================================
   Horários do Alentejo
   Lê horarios.json e pesquisa viagens por origem → destino.

   Correções importantes:
   1) Emparelhamento cronológico partida/chegada — os arrays
      `horarios` das paragens NÃO estão alinhados por índice em
      muitos sentidos. Cada partida é emparelhada com a primeira
      chegada cuja hora seja >= à partida. Pares inválidos são
      rejeitados.
   2) Filtro por dia da semana consoante a data escolhida.
   3) Consolidação/desduplicação de viagens idênticas.
   4) Timeline cronológica única.
   ============================================================= */

const DATA_URL = './horarios.json';

const state = {
  data: null, // conteúdo de horarios.json
  stops: [],  // nomes únicos e válidos (higienizados) para o <datalist>
  trips: [],  // viagens achatadas: { origem, destino, partida, chegada, ... }
};

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

/* Higienização das paragens:
   rejeita strings com formato HH:MM, números e termos com menos de 3 letras */
function isValidStopName(name) {
  if (name == null) return false;
  const s = String(name).trim();
  if (!s) return false;
  if (/^\d{1,2}:\d{2}$/.test(s)) return false;    // formato HH:MM
  if (/^[\d\s.,;:/\-–—]+$/.test(s)) return false; // só números/símbolos
  const letters = (s.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  return letters >= 3;
}

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/* Duração legível entre duas horas HH:MM (assume que a chegada é no mesmo dia) */
function duracaoLabel(partida, chegada) {
  const a = toMinutes(partida);
  const b = toMinutes(chegada);
  if (a == null || b == null || b < a) return '';
  const diff = b - a;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h && m) return `${h}h${String(m).padStart(2, '0')}`;
  if (h) return `${h}h`;
  return `${m} min`;
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

/* ---------------- Dias de circulação ---------------- */

/* Converte o tipo_servico num conjunto de dias da semana (0=Dom … 6=Sáb).
   Devolve null quando o serviço circula todos os dias. */
function diasDoTipo(tipo) {
  const TODOS = [0, 1, 2, 3, 4, 5, 6];
  const UTEIS = [1, 2, 3, 4, 5];
  const map = {
    todos_os_dias: TODOS,
    dias_uteis: UTEIS,
    segunda_a_sexta: UTEIS,
    segunda_a_quarta: [1, 2, 3],
    segunda_feira_quarta_feira: [1, 3],
    segunda_feira_terca_feira_quarta_feira_sexta_feira: [1, 2, 3, 5],
    quarta_feira: [3],
    quarta_feira_sexta_feira: [3, 5],
    quinta_feira: [4],
    sabado: [6],
    domingo: [0],
  };
  if (tipo && map[tipo]) return map[tipo];
  // Sem tipo definido: assume dias úteis (comportamento mais comum nos PDFs).
  return UTEIS;
}

/* O serviço circula no dia da semana indicado? */
function circulaNoDia(tipo, diaSemana) {
  const dias = diasDoTipo(tipo);
  return dias.includes(diaSemana);
}

/* ---------------- Carregamento ---------------- */

async function loadData() {
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Não foi possível carregar ' + DATA_URL + ' (HTTP ' + res.status + ')');
  }
  state.data = await res.json();
  if (!state.data || !Array.isArray(state.data.servicos)) {
    throw new Error('Estrutura de horarios.json inesperada.');
  }
}

/* Constrói a lista única de paragens válidas (higienizada) */
function buildStops() {
  const map = new Map(); // norm -> valor original
  for (const servico of state.data.servicos) {
    for (const sentido of servico.sentidos) {
      for (const paragem of sentido.paragens) {
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
  list.innerHTML = '';
  for (const value of state.stops) {
    const opt = document.createElement('option');
    opt.value = value;
    list.appendChild(opt);
  }
}

/* ---------------- Seletor visual de paragens (modal) ---------------- */

let seletorCampo = null; // 'origem' | 'destino'

/* Abre o modal do seletor de paragens para o campo indicado. */
function abrirSeletorParagens(campo) {
  seletorCampo = campo;
  const modal = document.getElementById('seletor-paragens');
  const titulo = document.getElementById('seletor-titulo');
  const pesquisa = document.getElementById('seletor-pesquisa');

  titulo.textContent = campo === 'origem' ? 'Escolher Paragem de Origem' : 'Escolher Paragem de Destino';
  pesquisa.value = '';
  renderListaParagens('');

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Foco automático na barra de pesquisa (após o modal ficar visível).
  setTimeout(() => {
    pesquisa.focus({ preventScroll: true });
  }, 80);
}

/* Fecha o modal do seletor de paragens. */
function fecharSeletorParagens() {
  const modal = document.getElementById('seletor-paragens');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  seletorCampo = null;
}

/* Renderiza a lista de paragens agrupada por letra inicial. */
function renderListaParagens(filtro) {
  const box = document.getElementById('seletor-lista');
  const termo = norm(filtro || '');
  const lista = state.stops.filter((s) => !termo || norm(s).includes(termo));

  if (!lista.length) {
    box.innerHTML = `
      <p class="px-4 py-10 text-center text-sm font-medium text-slate-400">
        Nenhuma paragem encontrada.
      </p>`;
    return;
  }

  let html = '';
  let letraAtual = '';
  for (const nome of lista) {
    // Agrupa pela letra inicial sem acentos (Á -> A).
    const letra = (norm(nome)[0] || '#').toUpperCase();
    if (letra !== letraAtual) {
      letraAtual = letra;
      html += `
        <div class="sticky top-0 z-10 bg-white/95 px-4 py-1.5 text-[11px] font-extrabold uppercase tracking-wider text-brand-600 backdrop-blur">
          ${esc(letra)}
        </div>`;
    }
    html += `
      <button type="button" class="paragem-opcao flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-slate-800 transition hover:bg-brand-50 hover:text-brand-700 active:bg-brand-100"
              data-paragem="${esc(nome)}">
        <span class="pointer-events-none text-slate-300" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        </span>
        <span class="min-w-0 flex-1 truncate">${esc(nome)}</span>
      </button>`;
  }
  box.innerHTML = html;
}

/* Escolhe uma paragem: preenche o campo, fecha o modal e valida. */
function escolherParagem(nome) {
  if (!seletorCampo) return;
  const input = document.getElementById(seletorCampo);
  input.value = nome;
  fecharSeletorParagens();
  input.focus();
  const origem = document.getElementById('origem').value.trim();
  const destino = document.getElementById('destino').value.trim();
  if (origem && destino) runSearch();
}

/* Liga os eventos do seletor de paragens. */
function ligarSeletorParagens() {
  document.querySelectorAll('.lista-btn').forEach((btn) => {
    btn.addEventListener('click', () => abrirSeletorParagens(btn.dataset.lista));
  });

  document.getElementById('seletor-fechar').addEventListener('click', fecharSeletorParagens);
  document.getElementById('seletor-overlay').addEventListener('click', fecharSeletorParagens);

  const pesquisa = document.getElementById('seletor-pesquisa');
  pesquisa.addEventListener('input', () => renderListaParagens(pesquisa.value));

  // Delegação: clique numa paragem da lista.
  document.getElementById('seletor-lista').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.paragem-opcao');
    if (btn) escolherParagem(btn.dataset.paragem);
  });

  // Fechar com a tecla Escape.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !document.getElementById('seletor-paragens').classList.contains('hidden')) {
      ev.preventDefault();
      fecharSeletorParagens();
    }
  }, true);
}

/* ---------------- Emparelhamento partida/chegada ---------------- */

/* Dado o array de partidas e o array de chegadas (podem ter tamanhos
   diferentes e não estar alinhados por índice), emparelha cada partida
   com uma chegada válida (hora >= partida). Rejeita pares inválidos.

   - Se os dois arrays tiverem o mesmo tamanho, assume alinhamento por
     índice (é o formato dos PDFs com colunas alinhadas) e valida cada par.
   - Caso contrário, emparelha cada partida com a primeira chegada livre
     cuja hora seja >= à partida (emparelhamento cronológico). */
function emparelharHorarios(partidas, chegadas) {
  const P = (partidas || []).filter((h) => toMinutes(h) != null);
  const C = (chegadas || []).filter((h) => toMinutes(h) != null);

  // Caso 1: arrays alinhados por índice.
  if (P.length === C.length) {
    const pares = [];
    for (let i = 0; i < P.length; i++) {
      if (toMinutes(C[i]) >= toMinutes(P[i])) {
        pares.push({ partida: P[i], chegada: C[i] });
      }
    }
    return pares;
  }

  // Caso 2: arrays desalinhados → emparelhamento cronológico.
  const ch = C
    .map((h) => ({ hora: h, min: toMinutes(h) }))
    .sort((a, b) => a.min - b.min);

  const usados = new Set();
  const pares = [];

  for (const p of P) {
    const pMin = toMinutes(p);
    let escolhido = -1;
    for (let i = 0; i < ch.length; i++) {
      if (usados.has(i)) continue;
      if (ch[i].min >= pMin) { escolhido = i; break; }
    }
    if (escolhido === -1) continue; // sem chegada válida → rejeita

    usados.add(escolhido);
    pares.push({ partida: p, chegada: ch[escolhido].hora });
  }

  return pares;
}

/* ---------------- Construção das viagens ---------------- */

function buildTrips() {
  const trips = [];

  for (const servico of state.data.servicos) {
    for (const sentido of servico.sentidos) {
      const paragens = sentido.paragens;

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
              // Rota completa (paragens intermédias) para o acordeão.
              rota: construirRota(paragens, oi, di, par.partida, par.chegada),
            });
          }
        }
      }
    }
  }

  state.trips = trips;
}

/* Constrói a lista ordenada de paragens entre origem (oi) e destino (di),
   com a hora de cada paragem para esta viagem concreta.

   As paragens intermédias não têm hora própria por viagem no JSON, pelo que
   a hora é interpolada linearmente entre a partida e a chegada, respeitando
   a ordem das paragens. */
function construirRota(paragens, oi, di, partida, chegada) {
  const pMin = toMinutes(partida);
  const cMin = toMinutes(chegada);
  const n = di - oi; // número de troços
  const rota = [];

  for (let k = oi; k <= di; k++) {
    const p = paragens[k];
    if (!isValidStopName(p.nome)) continue;

    let hora = null;
    if (k === oi) {
      hora = partida;
    } else if (k === di) {
      hora = chegada;
    } else if (pMin != null && cMin != null && n > 0) {
      // Interpolação proporcional à posição na rota.
      const frac = (k - oi) / n;
      const min = Math.round(pMin + (cMin - pMin) * frac);
      hora = minutosParaHora(min);
    }

    rota.push({
      nome: p.nome,
      hora,
      isOrigem: k === oi,
      isDestino: k === di,
    });
  }

  return rota;
}

/* Converte minutos desde a meia-noite em "HH:MM". */
function minutosParaHora(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* ---------------- Pesquisa ---------------- */

function findTrips(origem, destino, diaSemana) {
  const oKey = norm(origem);
  const dKey = norm(destino);

  return state.trips.filter((t) =>
    t.origemNorm === oKey &&
    t.destinoNorm === dKey &&
    circulaNoDia(t.tipoServico, diaSemana)
  );
}

/* ---------------- Consolidação ---------------- */

/* Agrupa viagens com a mesma partida e chegada, juntando operadores/linhas. */
function consolidar(trips) {
  const map = new Map();

  for (const t of trips) {
    const key = `${t.partida}|${t.chegada}`;
    if (!map.has(key)) {
      map.set(key, {
        partida: t.partida,
        chegada: t.chegada,
        partidaMin: t.partidaMin,
        operadores: new Set(),
        linhas: new Set(),
        tipos: new Set(),
        rota: t.rota, // rota completa do primeiro serviço do grupo
      });
    }
    const g = map.get(key);
    g.operadores.add(t.operador);
    g.linhas.add(t.linha);
    if (t.tipoServico) g.tipos.add(t.tipoServico);
    // Prefere a rota mais detalhada (com mais paragens).
    if (t.rota && (!g.rota || t.rota.length > g.rota.length)) g.rota = t.rota;
  }

  return [...map.values()]
    .map((g) => ({
      partida: g.partida,
      chegada: g.chegada,
      partidaMin: g.partidaMin,
      operadores: [...g.operadores],
      linhas: [...g.linhas],
      tipos: [...g.tipos],
      rota: g.rota || [],
    }))
    .sort((a, b) => a.partidaMin - b.partidaMin);
}

/* ---------------- Renderização ---------------- */

/* Ícone de localização (Google Maps). */
function mapaSVG() {
  return `<svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </svg>`;
}

/* Link discreto para o Google Maps de uma paragem. */
function mapaLink(nome) {
  const url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(nome + ' Alentejo');
  return `<a href="${url}" target="_blank" rel="noopener"
             class="mapa-link inline-flex shrink-0 items-center justify-center rounded-full p-0.5 text-slate-400 transition hover:bg-brand-50 hover:text-brand-600"
             data-mapa="1"
             aria-label="Ver ${esc(nome)} no Google Maps"
             title="Ver no Google Maps">${mapaSVG()}</a>`;
}

/* Linha da rota detalhada (paragem intermédia). */
function rotaLinha(p) {
  const destaque = p.isOrigem || p.isDestino;
  const ponto = p.isOrigem
    ? 'bg-brand-600'
    : p.isDestino
      ? 'bg-slate-900'
      : 'bg-slate-300';
  const nomeCls = destaque ? 'font-bold text-slate-900' : 'font-medium text-slate-600';
  const horaCls = destaque ? 'font-bold text-slate-900' : 'text-slate-500';

  return `
    <li class="flex items-center gap-3 py-1.5">
      <span class="relative z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white ${ponto}"></span>
      <span class="min-w-0 flex-1 truncate text-xs ${nomeCls}">${esc(p.nome)}</span>
      ${mapaLink(p.nome)}
      <span class="shrink-0 text-xs tabular-nums ${horaCls}">${p.hora ? esc(p.hora) : '—'}</span>
    </li>`;
}

/* Ícone de estrela (favorito). */
function estrelaSVG() {
  return `<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />
  </svg>`;
}

function tripCard(trip, isNext, isPast, index) {
  const cls = isNext ? 'viagem-proxima bg-brand-50/60' : (isPast ? 'viagem-passada' : '');
  const badge = isNext
    ? '<span class="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Próxima</span>'
    : (isPast
      ? '<span class="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">Já partiu</span>'
      : '');
  const dur = duracaoLabel(trip.partida, trip.chegada);

  const operadores = trip.operadores
    .map((o) => `<span class="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">${esc(o)}</span>`)
    .join('');
  const linhas = trip.linhas
    .map((l) => `<span class="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">${esc(l)}</span>`)
    .join('');
  const tipos = trip.tipos
    .map((t) => `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">${esc(tipoLabel(t))}</span>`)
    .join('');

  const rota = (trip.rota || []).map(rotaLinha).join('');
  const nParagens = (trip.rota || []).length;

  const favKey = chaveFavorito(trip);
  const isFav = favoritos.has(favKey);

  return `
    <li class="relative ${cls}">
      <button type="button"
              class="viagem-toggle flex w-full items-stretch gap-4 px-4 py-4 pr-12 text-left transition hover:bg-slate-50/70 focus:outline-none focus-visible:bg-slate-50"
              aria-expanded="false" aria-controls="rota-${index}">
        <div class="flex w-14 shrink-0 flex-col items-center">
          <span class="viagem-hora-partida text-xl font-extrabold tabular-nums leading-none text-slate-900">${esc(trip.partida)}</span>
          <span class="mt-1 h-full w-px flex-1 bg-slate-200"></span>
          <span class="mt-1 text-sm font-bold tabular-nums leading-none text-slate-500">${esc(trip.chegada)}</span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            ${badge}
            ${dur ? `<span class="text-[11px] font-semibold text-slate-500">${esc(dur)} de viagem</span>` : ''}
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            ${linhas}
            ${operadores}
            ${tipos}
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
            <span class="inline-flex min-w-0 items-center gap-1">
              <span class="truncate font-semibold text-slate-800">${esc(trip.origem)}</span>
              ${mapaLink(trip.origem)}
            </span>
            <span class="text-slate-400" aria-hidden="true">→</span>
            <span class="inline-flex min-w-0 items-center gap-1">
              <span class="truncate font-semibold text-slate-800">${esc(trip.destino)}</span>
              ${mapaLink(trip.destino)}
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center">
          <svg viewBox="0 0 24 24" class="viagem-seta h-5 w-5 text-slate-400 transition-transform duration-300" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      <button type="button"
              class="fav-btn absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-brand-50 hover:text-brand-600 ${isFav ? 'is-fav' : ''}"
              data-fav="${esc(favKey)}"
              aria-pressed="${isFav}"
              aria-label="${isFav ? 'Remover dos guardados' : 'Guardar viagem'}"
              title="${isFav ? 'Remover dos guardados' : 'Guardar viagem'}">
        ${estrelaSVG()}
      </button>

      <div id="rota-${index}" class="viagem-detalhe hidden border-t border-slate-100 bg-slate-50/60 px-4 py-3">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Rota completa · ${nParagens} ${nParagens === 1 ? 'paragem' : 'paragens'}
        </p>
        <ul class="relative ml-1 border-l border-slate-200 pl-4">${rota}</ul>
      </div>
    </li>`;
}

function renderResults(trips, origem, destino, diaSemana) {
  const box = document.getElementById('results');

  if (!trips.length) {
    box.innerHTML = `
      <div class="rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
        <p class="text-sm font-semibold text-slate-600">Nenhuma viagem encontrada</p>
        <p class="mt-1 text-xs text-slate-400">Não há ligações diretas de <strong>${esc(origem)}</strong> para <strong>${esc(destino)}</strong> que circulem no dia escolhido.</p>
      </div>`;
    return;
  }

  const consolidados = consolidar(trips).map((t) => ({ ...t, origem, destino }));
  const hoje = new Date();
  const isHoje = hoje.getDay() === diaSemana;
  const now = nowMinutes();

  let nextIndex = -1;
  if (isHoje) {
    nextIndex = consolidados.findIndex((t) => t.partidaMin >= now);
  }

  const rows = consolidados.map((t, i) => {
    const isNext = i === nextIndex;
    const isPast = isHoje && t.partidaMin < now;
    return tripCard(t, isNext, isPast, i);
  }).join('');

  // Mapa chave -> viagem, para o clique da estrela de favorito.
  viagensPorChave = new Map();
  for (const t of consolidados) {
    viagensPorChave.set(chaveFavorito(t), t);
  }

  box.innerHTML = `
    <div class="mb-2 flex items-center justify-between px-1">
      <h2 class="text-sm font-bold text-slate-700">${consolidados.length} partida${consolidados.length === 1 ? '' : 's'}</h2>
      <span class="text-xs font-semibold text-slate-400">${esc(origem)} → ${esc(destino)}</span>
    </div>
    <article class="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <ul class="divide-y divide-slate-100">${rows}</ul>
    </article>`;

  ligarAcordeoes();
  ligarFavoritos();
}

/* Liga o clique de cada cartão à abertura/fecho da rota detalhada. */
function ligarAcordeoes() {
  const box = document.getElementById('results');
  box.querySelectorAll('.viagem-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const detalhe = document.getElementById(btn.getAttribute('aria-controls'));
      const seta = btn.querySelector('.viagem-seta');
      if (!detalhe) return;

      const aberto = !detalhe.classList.contains('hidden');
      detalhe.classList.toggle('hidden', aberto);
      btn.setAttribute('aria-expanded', String(!aberto));
      if (seta) seta.classList.toggle('rotate-180', !aberto);
    });
  });

  // Os links do Google Maps não devem abrir/fechar o accordion.
  box.querySelectorAll('.mapa-link').forEach((link) => {
    link.addEventListener('click', (ev) => ev.stopPropagation());
  });
}

/* ---------------- Favoritos (localStorage) ---------------- */

const FAV_KEY = 'ra_favoritos_v1';
let favoritos = new Map(); // chave -> { origem, destino, partida, chegada, linha, operador }

/* Chave única de uma viagem guardada. */
function chaveFavorito(t) {
  const linha = Array.isArray(t.linhas) ? t.linhas.join(',') : (t.linha || '');
  const operador = Array.isArray(t.operadores) ? t.operadores.join(',') : (t.operador || '');
  return [norm(t.origem), norm(t.destino), t.partida, t.chegada, linha, operador].join('|');
}

function carregarFavoritos() {
  favoritos = new Map();
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return;
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista)) return;
    for (const f of lista) {
      if (f && f.origem && f.destino && f.partida) favoritos.set(chaveFavorito(f), f);
    }
  } catch (err) {
    console.warn('Favoritos ilegíveis:', err);
  }
}

function gravarFavoritos() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favoritos.values()]));
  } catch (err) {
    console.warn('Não foi possível gravar favoritos:', err);
  }
  atualizarContadorFavoritos();
}

function atualizarContadorFavoritos() {
  const badge = document.getElementById('fav-count');
  if (!badge) return;
  const n = favoritos.size;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

/* Alterna o estado de favorito de uma viagem. */
function alternarFavorito(trip) {
  const key = chaveFavorito(trip);
  if (favoritos.has(key)) {
    favoritos.delete(key);
  } else {
    favoritos.set(key, {
      origem: trip.origem,
      destino: trip.destino,
      partida: trip.partida,
      chegada: trip.chegada,
      linha: Array.isArray(trip.linhas) ? trip.linhas.join(', ') : (trip.linha || ''),
      operador: Array.isArray(trip.operadores) ? trip.operadores.join(', ') : (trip.operador || ''),
      // Guarda a rota completa para o acordeão na aba Guardados.
      rota: Array.isArray(trip.rota) ? trip.rota : [],
    });
  }
  gravarFavoritos();
  return favoritos.has(key);
}

/* Dispara a micro-animação (giro + escala) da estrela. */
function animarEstrela(btn) {
  if (!btn) return;
  btn.classList.remove('fav-pop');
  // Força o reinício da animação em cliques consecutivos.
  void btn.offsetWidth;
  btn.classList.add('fav-pop');
  btn.addEventListener('animationend', () => btn.classList.remove('fav-pop'), { once: true });
}

/* Liga os botões de estrela dos cartões de resultado. */
function ligarFavoritos() {
  const box = document.getElementById('results');
  box.querySelectorAll('.fav-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.getAttribute('data-fav');
      const trip = viagensPorChave.get(key);
      if (!trip) return;
      const agoraFav = alternarFavorito(trip);
      btn.classList.toggle('is-fav', agoraFav);
      btn.setAttribute('aria-pressed', String(agoraFav));
      const label = agoraFav ? 'Remover dos guardados' : 'Guardar viagem';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      animarEstrela(btn);
    });
  });
}

/*
 * Sincroniza o estado visual de TODAS as estrelas presentes no DOM com a
 * lista de favoritos atual (fonte de verdade: localStorage / Map `favoritos`).
 * Corrige a dessincronização quando uma viagem é removida noutra aba.
 */
function syncFavoriteButtons() {
  document.querySelectorAll('.fav-btn').forEach((btn) => {
    // Os cartões de resultado usam data-fav; os guardados usam data-fav-remover.
    const key = btn.getAttribute('data-fav') || btn.getAttribute('data-fav-remover');
    if (!key) return;
    const ativo = favoritos.has(key);
    btn.classList.toggle('is-fav', ativo);
    btn.setAttribute('aria-pressed', String(ativo));
    const label = ativo ? 'Remover dos guardados' : 'Guardar viagem';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  });
}

/* Mapa auxiliar chave -> viagem consolidada (para o clique da estrela). */
let viagensPorChave = new Map();

/* ---------------- Camada: viagens ocultas (localStorage) ---------------- */

const OCULTAS_KEY = 'ra_viagens_ocultas';
let viagensOcultas = new Map(); // chave -> { chave, origem, destino, partida, chegada, linha, operador }

function carregarOcultas() {
  viagensOcultas = new Map();
  try {
    const raw = localStorage.getItem(OCULTAS_KEY);
    if (!raw) return;
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista)) return;
    for (const item of lista) {
      if (typeof item === 'string') {
        // Compatibilidade com o formato antigo (apenas chave).
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

/* Oculta (desativa) uma viagem oficial. */
function ocultarViagem(trip) {
  const chave = chaveFavorito(trip);
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
  rebuildTrips();
}

/* Reativa uma viagem oficial previamente ocultada. */
function reativarViagem(chave) {
  viagensOcultas.delete(chave);
  gravarOcultas();
  rebuildTrips();
}

/* ---------------- Camada: viagens manuais (localStorage) ---------------- */

const MANUAIS_KEY = 'ra_viagens_adicionadas';
let viagensManuais = []; // { id, linha, operador, sentido, tipoServico, paragens: [{nome, hora}] }

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

/* Converte uma viagem manual em viagens achatadas (uma por par origem→destino). */
function manuaisParaTrips() {
  const trips = [];
  for (const v of viagensManuais) {
    const paragens = (v.paragens || []).filter((p) => isValidStopName(p.nome) && toMinutes(p.hora) != null);
    for (let oi = 0; oi < paragens.length; oi++) {
      for (let di = oi + 1; di < paragens.length; di++) {
        const pO = paragens[oi];
        const pD = paragens[di];
        if (toMinutes(pD.hora) < toMinutes(pO.hora)) continue;
        trips.push({
          operador: v.operador || '—',
          linha: v.linha || '—',
          sentido: v.sentido || '',
          tipoServico: v.tipoServico || null,
          origem: pO.nome,
          destino: pD.nome,
          origemNorm: norm(pO.nome),
          destinoNorm: norm(pD.nome),
          partida: pO.hora,
          chegada: pD.hora,
          partidaMin: toMinutes(pO.hora),
          rota: paragens.slice(oi, di + 1).map((p, k) => ({
            nome: p.nome,
            hora: p.hora,
            isOrigem: k === 0,
            isDestino: k === di - oi,
          })),
          manual: true,
          manualId: v.id,
        });
      }
    }
  }
  return trips;
}

/* Reconstrói a lista de viagens (oficiais não ocultadas + manuais). */
function rebuildTrips() {
  buildTrips();
  state.trips = state.trips.filter((t) => !viagensOcultas.has(chaveFavorito(t)));
  state.trips = state.trips.concat(manuaisParaTrips());
}

/* ---------------- Vista: Guardados ---------------- */

/* Cartão de uma viagem guardada, com acordeão da rota completa. */
function favoritoCard(fav, index) {
  const dur = duracaoLabel(fav.partida, fav.chegada);
  const linha = fav.linha
    ? `<span class="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">${esc(fav.linha)}</span>`
    : '';
  const operador = fav.operador
    ? `<span class="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">${esc(fav.operador)}</span>`
    : '';

  const rota = (fav.rota || []).map(rotaLinha).join('');
  const nParagens = (fav.rota || []).length;
  const detalhe = nParagens
    ? `
      <div id="fav-rota-${index}" class="viagem-detalhe hidden border-t border-slate-100 bg-slate-50/60 px-4 py-3">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Rota completa · ${nParagens} ${nParagens === 1 ? 'paragem' : 'paragens'}
        </p>
        <ul class="relative ml-1 border-l border-slate-200 pl-4">${rota}</ul>
      </div>`
    : '';

  return `
    <li class="fav-cartao relative overflow-hidden">
      <button type="button"
              class="viagem-toggle flex w-full items-stretch gap-4 px-4 py-4 pr-12 text-left transition hover:bg-slate-50/70 focus:outline-none focus-visible:bg-slate-50"
              aria-expanded="false" aria-controls="fav-rota-${index}">
        <div class="flex w-14 shrink-0 flex-col items-center">
          <span class="text-xl font-extrabold tabular-nums leading-none text-slate-900">${esc(fav.partida)}</span>
          <span class="mt-1 h-full w-px flex-1 bg-slate-200"></span>
          <span class="mt-1 text-sm font-bold tabular-nums leading-none text-slate-500">${esc(fav.chegada)}</span>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-bold text-slate-900">${esc(fav.origem)} <span class="text-brand-600">→</span> ${esc(fav.destino)}</p>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            ${linha}
            ${operador}
            ${dur ? `<span class="text-[11px] font-semibold text-slate-500">${esc(dur)} de viagem</span>` : ''}
          </div>
        </div>
        <div class="flex shrink-0 items-center">
          <svg viewBox="0 0 24 24" class="viagem-seta h-5 w-5 text-slate-400 transition-transform duration-300" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
      </button>

      <button type="button"
              class="fav-btn is-fav absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition hover:bg-brand-50 hover:text-brand-600"
              data-fav-remover="${esc(chaveFavorito(fav))}"
              aria-label="Remover dos guardados" title="Remover dos guardados">
        ${estrelaSVG()}
      </button>

      ${detalhe}
    </li>`;
}

function renderFavoritos() {
  const box = document.getElementById('favoritos');
  const lista = [...favoritos.values()].sort((a, b) => {
    const o = norm(a.origem).localeCompare(norm(b.origem), 'pt');
    if (o !== 0) return o;
    return (toMinutes(a.partida) ?? 0) - (toMinutes(b.partida) ?? 0);
  });

  if (!lista.length) {
    box.innerHTML = `
      <div class="rounded-3xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          ${estrelaSVG()}
        </div>
        <p class="text-sm font-semibold text-slate-700">Ainda não tem viagens guardadas</p>
        <p class="mt-1 text-xs text-slate-400">Toque na estrela de uma viagem para a guardar aqui.</p>
      </div>`;
    return;
  }

  const rows = lista.map((fav, i) => favoritoCard(fav, i)).join('');
  box.innerHTML = `
    <div class="mb-2 flex items-center justify-between px-1">
      <h2 class="text-sm font-bold text-slate-700">${lista.length} viage${lista.length === 1 ? 'm' : 'ns'} guardada${lista.length === 1 ? '' : 's'}</h2>
    </div>
    <article class="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <ul class="divide-y divide-slate-100">${rows}</ul>
    </article>`;

  ligarFavoritosGuardados();
}

/* Liga os cartões guardados: acordeão da rota e remoção animada. */
function ligarFavoritosGuardados() {
  const box = document.getElementById('favoritos');

  // Acordeão: expande/recolhe a rota completa (igual à pesquisa).
  box.querySelectorAll('.viagem-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const detalhe = document.getElementById(btn.getAttribute('aria-controls'));
      const seta = btn.querySelector('.viagem-seta');
      if (!detalhe) return;
      const aberto = !detalhe.classList.contains('hidden');
      detalhe.classList.toggle('hidden', aberto);
      btn.setAttribute('aria-expanded', String(!aberto));
      if (seta) seta.classList.toggle('rotate-180', !aberto);
    });
  });

  // Os links do Google Maps não devem abrir/fechar o accordion.
  box.querySelectorAll('.mapa-link').forEach((link) => {
    link.addEventListener('click', (ev) => ev.stopPropagation());
  });

  // Remoção: a estrela "atropela" o cartão e este colapsa.
  box.querySelectorAll('[data-fav-remover]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const chave = btn.getAttribute('data-fav-remover');
      const cartao = btn.closest('.fav-cartao');
      if (!cartao || cartao.classList.contains('fav-remover')) return;

      // Bloqueia cliques adicionais no cartão durante a animação.
      cartao.classList.add('fav-remover');

      // Atualiza o estado e o localStorage imediatamente.
      favoritos.delete(chave);
      gravarFavoritos();

      // Se os resultados da pesquisa ainda estiverem montados em segundo
      // plano, atualiza já a estrela correspondente desse resultado.
      const estrelaResultado = document.querySelector(`#results .fav-btn[data-fav="${CSS.escape(chave)}"]`);
      if (estrelaResultado) {
        estrelaResultado.classList.remove('is-fav');
        estrelaResultado.setAttribute('aria-pressed', 'false');
        estrelaResultado.setAttribute('aria-label', 'Guardar viagem');
        estrelaResultado.title = 'Guardar viagem';
      }

      // Remove fisicamente o elemento após a animação.
      const remover = () => {
        cartao.remove();
        if (!favoritos.size) renderFavoritos();
      };
      cartao.addEventListener('animationend', remover, { once: true });
      setTimeout(remover, 600); // salvaguarda
    });
  });
}

/* ---------------- Abas ---------------- */

function mudarAba(nome) {
  const views = {
    pesquisa: document.getElementById('view-pesquisa'),
    guardados: document.getElementById('view-guardados'),
  };
  const tabs = {
    pesquisa: document.getElementById('tab-pesquisa'),
    guardados: document.getElementById('tab-guardados'),
  };

  for (const key of Object.keys(views)) {
    const ativo = key === nome;
    views[key].classList.toggle('hidden', !ativo);
    tabs[key].setAttribute('aria-selected', String(ativo));
    const cls = 'tab-btn relative flex items-center gap-1.5 rounded-t-xl px-4 py-2.5 text-sm font-bold transition';
    tabs[key].className = `${cls} ${ativo ? 'bg-white text-brand-700 shadow-sm' : 'text-white/80 hover:bg-white/10 hover:text-white'}`;
  }

  if (nome === 'guardados') renderFavoritos();
  // Ao voltar à pesquisa, garante que as estrelas refletem os favoritos atuais.
  if (nome === 'pesquisa') syncFavoriteButtons();
}

function setStatus(message, isError = false) {
  const box = document.getElementById('results');
  box.innerHTML = `
    <div class="rounded-2xl px-6 py-10 text-center ${isError ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200' : 'bg-white/70 text-slate-500 ring-1 ring-slate-200'}">
      <p class="text-sm font-semibold">${esc(message)}</p>
      ${isError ? '<p class="mt-1 text-xs">Sirva a pasta com um servidor HTTP (ex.: <code class="font-mono">py -m http.server 8000</code>).</p>' : ''}
    </div>`;
}

/* ---------------- Data ---------------- */

function hojeISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function diaSemanaDaData(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=Dom … 6=Sáb
}

const NOMES_DIA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function atualizarInfoData() {
  const iso = document.getElementById('data').value;
  const info = document.getElementById('data-info');
  if (!iso) { info.textContent = ''; return; }
  const dia = diaSemanaDaData(iso);
  const nome = NOMES_DIA[dia];
  const fimSemana = dia === 0 || dia === 6;
  info.textContent = fimSemana
    ? `${nome} — apenas serviços de fim de semana`
    : `${nome} — serviços de dias úteis`;
  info.className = `mt-1.5 text-xs font-medium ${fimSemana ? 'text-slate-900' : 'text-brand-700'}`;
}

/* ---------------- Reportes de erros (localStorage) ---------------- */

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

function abrirReporte() {
  const modal = document.getElementById('reporte-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('rep-email')?.focus({ preventScroll: true }), 80);
}

function fecharReporte() {
  const modal = document.getElementById('reporte-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function submeterReporte(e) {
  e.preventDefault();
  const email = document.getElementById('rep-email').value.trim();
  const assunto = document.getElementById('rep-assunto').value.trim();
  const mensagem = document.getElementById('rep-mensagem').value.trim();
  const erro = document.getElementById('rep-erro');

  const mostrarErro = (txt) => {
    if (!erro) return;
    erro.textContent = txt;
    erro.classList.remove('hidden');
  };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    mostrarErro('Indica um email de contacto válido.');
    return;
  }
  if (!assunto) { mostrarErro('Indica o assunto ou a linha.'); return; }
  if (!mensagem) { mostrarErro('Descreve o erro encontrado.'); return; }
  erro?.classList.add('hidden');

  const lista = carregarReportes();
  lista.push({
    id: 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    data: new Date().toISOString(),
    email,
    assunto,
    mensagem,
    lida: false,
  });
  gravarReportes(lista);

  // Confirmação visual e fecho.
  document.getElementById('reporte-form').reset();
  fecharReporte();
  mostrarToast('Reporte enviado. Obrigado pela ajuda!');
}

/* Pequeno toast de confirmação. */
function mostrarToast(texto) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-xl transition-all duration-300';
    document.body.appendChild(toast);
  }
  toast.textContent = texto;
  toast.style.opacity = '0';
  toast.style.transform = 'translate(-50%, 8px)';
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, 0)';
  });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, 8px)';
  }, 2600);
}

function ligarReporte() {
  const btn = document.getElementById('info-btn');
  const fechar = document.getElementById('reporte-fechar');
  const overlay = document.getElementById('reporte-overlay');
  const form = document.getElementById('reporte-form');
  if (!btn || !form) return;

  btn.addEventListener('click', abrirReporte);
  fechar?.addEventListener('click', fecharReporte);
  overlay?.addEventListener('click', fecharReporte);
  form.addEventListener('submit', submeterReporte);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('reporte-modal')?.classList.contains('hidden')) {
      fecharReporte();
    }
  });
}

/* ---------------- Assistente Inteligente (100% frontend) ---------------- */

const ASSIST_SAUDACAO = 'Olá! Escreve de onde sais e para onde queres ir (ex: Lisboa para Évora amanhã).';

const ASSIST_SUGESTOES = [
  'Beja para Évora',
  'Évora para Estremoz amanhã',
  'Lisboa para Portalegre',
];

/* Palavras que não ajudam a identificar paragens. */
const ASSIST_STOPWORDS = new Set([
  'de', 'do', 'da', 'dos', 'das', 'para', 'pra', 'pro', 'a', 'o', 'as', 'os',
  'e', 'em', 'no', 'na', 'nos', 'nas', 'ate', 'ao', 'aos', 'que', 'quero', 'ir',
  'sair', 'saio', 'parto', 'partida', 'chegar', 'chego', 'viagem', 'viagens',
  'autocarro', 'autocarros', 'bus', 'horario', 'horarios', 'horas', 'hora',
  'por', 'favor', 'pf', 'me', 'leva', 'levar', 'como', 'vou', 'gostaria',
  'preciso', 'queria', 'saber', 'ver', 'mostra', 'mostrar', 'dia', 'hoje',
  'amanha', 'depois', 'proxima', 'proximo', 'seguinte', 'sabado', 'domingo',
  'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'feira', 'util', 'uteis',
  'fim', 'semana', 'manha', 'tarde', 'noite', 'cerca', 'mais',
  'menos', 'primeiro', 'primeira', 'ultimo', 'ultima', 'entre', 'desde',
]);

/* Remove acentos e pontuação, devolve tokens úteis. */
function assistTokens(texto) {
  return norm(texto)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !ASSIST_STOPWORDS.has(t));
}

/*
 * Encontra a paragem conhecida que melhor corresponde a um fragmento de texto.
 * Estratégia: (1) igualdade exata normalizada; (2) a paragem contém o termo;
 * (3) o termo contém a paragem; (4) melhor pontuação por tokens em comum.
 */
function assistEncontrarParagem(fragmento) {
  const alvo = norm(fragmento).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!alvo) return null;

  // 1) Igualdade exata
  for (const paragem of state.stops) {
    if (norm(paragem) === alvo) return paragem;
  }

  // 2) A paragem contém o termo (ex.: "evora" -> "Évora")
  const contem = state.stops.filter((p) => norm(p).includes(alvo));
  if (contem.length) {
    // Prefere a que começa pelo termo e, em empate, a mais curta (mais específica).
    contem.sort((a, b) => {
      const ca = norm(a).startsWith(alvo) ? 0 : 1;
      const cb = norm(b).startsWith(alvo) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return a.length - b.length;
    });
    return contem[0];
  }

  // 3) O termo contém a paragem (ex.: "estacao rodoviaria de beja" -> "Beja")
  const contido = state.stops.filter((p) => alvo.includes(norm(p)));
  if (contido.length) {
    contido.sort((a, b) => b.length - a.length);
    return contido[0];
  }

  // 4) Pontuação por tokens em comum
  const tokens = assistTokens(fragmento);
  if (!tokens.length) return null;
  let melhor = null;
  let melhorScore = 0;
  for (const paragem of state.stops) {
    const pTokens = assistTokens(paragem);
    if (!pTokens.length) continue;
    let score = 0;
    for (const t of tokens) {
      if (pTokens.some((pt) => pt === t)) score += 2;
      else if (pTokens.some((pt) => pt.startsWith(t) || t.startsWith(pt))) score += 1;
    }
    if (score > melhorScore) { melhorScore = score; melhor = paragem; }
  }
  return melhorScore >= 2 ? melhor : null;
}

/* Distância de Levenshtein (para sugestões por aproximação). */
function assistLevenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[t.length];
}

/*
 * Sugestão por aproximação: encontra a paragem mais parecida com o termo
 * escrito (mesmo com gralhas, ex.: "portaleg" -> "Portalegre", "evra" -> "Évora").
 * Devolve { paragem, distancia, confianca } ou null.
 */
function assistSugerirParagem(termo) {
  const alvo = norm(termo).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (alvo.length < 3) return null;

  let melhor = null;
  let melhorDist = Infinity;
  for (const paragem of state.stops) {
    const p = norm(paragem);
    // Compara com a paragem inteira e com cada palavra (ex.: "Évora" em "Évora (Terminal)").
    const candidatos = [p, ...p.split(' ')];
    for (const c of candidatos) {
      if (!c) continue;
      // Prefixo: "portaleg" é prefixo de "portalegre" -> distância baixa.
      const dist = c.startsWith(alvo) || alvo.startsWith(c)
        ? Math.abs(c.length - alvo.length)
        : assistLevenshtein(alvo, c);
      if (dist < melhorDist) { melhorDist = dist; melhor = paragem; }
    }
  }
  if (!melhor) return null;

  // Limiar: aceita até ~40% de diferença face ao comprimento do termo.
  const limite = Math.max(2, Math.ceil(alvo.length * 0.4));
  if (melhorDist > limite) return null;

  const confianca = 1 - melhorDist / Math.max(alvo.length, norm(melhor).length);
  return { paragem: melhor, distancia: melhorDist, confianca };
}

/* Interpreta "de X para Y", "X para Y", "X -> Y", "X a Y", etc. */
function assistInterpretar(texto) {
  const limpo = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!limpo) return { origem: null, destino: null, sugestoes: [] };

  // Padrões com separadores explícitos.
  const padroes = [
    /\bde\s+(.+?)\s+(?:para|pra|pro|ate|até|a)\s+(.+)$/i,
    /\b(?:desde|partindo de)\s+(.+?)\s+(?:para|pra|pro|ate|até|a)\s+(.+)$/i,
    /(.+?)\s*(?:->|→|=>|>)\s*(.+)$/,
    /\b(?:ir|vou|quero ir|queria ir)\s+(?:de\s+)?(.+?)\s+(?:para|pra|pro|ate|até|a)\s+(.+)$/i,
    /^(.+?)\s+(?:para|pra|pro|ate|até)\s+(.+)$/i,
  ];

  for (const re of padroes) {
    const m = re.exec(limpo);
    if (m) {
      const origem = assistEncontrarParagem(m[1]);
      const destino = assistEncontrarParagem(m[2]);
      // Gera sugestões por aproximação para o lado que não teve correspondência exata.
      const sugestoes = [];
      if (!origem) {
        const s = assistSugerirParagem(m[1]);
        if (s) sugestoes.push({ campo: 'origem', termo: m[1].trim(), ...s });
      }
      if (!destino) {
        const s = assistSugerirParagem(m[2]);
        if (s) sugestoes.push({ campo: 'destino', termo: m[2].trim(), ...s });
      }
      if (origem || destino || sugestoes.length) return { origem, destino, sugestoes };
    }
  }

  // Sem separador: tenta encontrar duas paragens distintas na frase.
  const tokens = limpo.split(/\s+/);
  const encontradas = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = tokens.length; j > i; j--) {
      const frag = tokens.slice(i, j).join(' ');
      const p = assistEncontrarParagem(frag);
      if (p && !encontradas.includes(p)) {
        encontradas.push(p);
        i = j - 1;
        break;
      }
    }
    if (encontradas.length >= 2) break;
  }
  if (encontradas.length >= 2) return { origem: encontradas[0], destino: encontradas[1], sugestoes: [] };
  if (encontradas.length === 1) return { origem: encontradas[0], destino: null, sugestoes: [] };

  // Última tentativa: sugestões por aproximação sobre os tokens úteis.
  const uteis = assistTokens(limpo);
  const sugestoes = [];
  for (const t of uteis) {
    const s = assistSugerirParagem(t);
    if (s && !sugestoes.some((x) => x.paragem === s.paragem)) {
      sugestoes.push({ campo: sugestoes.length === 0 ? 'origem' : 'destino', termo: t, ...s });
    }
    if (sugestoes.length >= 2) break;
  }
  return { origem: null, destino: null, sugestoes };
}

/* Deteta a data pedida ("hoje", "amanhã", dia da semana) e devolve ISO. */
function assistInterpretarData(texto) {
  const t = norm(texto);
  const hoje = new Date();
  const addDias = (n) => {
    const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + n);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  };

  if (/\bdepois de amanha\b/.test(t)) return { iso: addDias(2), label: 'depois de amanhã' };
  if (/\bamanha\b/.test(t)) return { iso: addDias(1), label: 'amanhã' };
  if (/\bhoje\b/.test(t)) return { iso: addDias(0), label: 'hoje' };

  const dias = [
    { re: /\bdomingo\b/, dow: 0, label: 'domingo' },
    { re: /\bsegunda(?:-feira)?\b/, dow: 1, label: 'segunda-feira' },
    { re: /\bterca(?:-feira)?\b/, dow: 2, label: 'terça-feira' },
    { re: /\bquarta(?:-feira)?\b/, dow: 3, label: 'quarta-feira' },
    { re: /\bquinta(?:-feira)?\b/, dow: 4, label: 'quinta-feira' },
    { re: /\bsexta(?:-feira)?\b/, dow: 5, label: 'sexta-feira' },
    { re: /\bsabado\b/, dow: 6, label: 'sábado' },
  ];
  for (const d of dias) {
    if (d.re.test(t)) {
      let delta = (d.dow - hoje.getDay() + 7) % 7;
      if (delta === 0) delta = 7; // "próxima" ocorrência
      return { iso: addDias(delta), label: d.label };
    }
  }
  return null;
}

/* ---------------- Interface do assistente ---------------- */

let assistAberto = false;

function assistAbrir() {
  const painel = document.getElementById('assist-panel');
  if (!painel || assistAberto) return;
  assistAberto = true;
  painel.classList.remove('hidden');
  document.getElementById('assist-badge')?.classList.add('hidden');
  setTimeout(() => document.getElementById('assist-input')?.focus({ preventScroll: true }), 80);
}

function assistFechar() {
  const painel = document.getElementById('assist-panel');
  if (!painel || !assistAberto) return;
  assistAberto = false;
  painel.classList.add('hidden');
}

function assistAlternar() {
  if (assistAberto) assistFechar(); else assistAbrir();
}

/* Adiciona uma bolha de mensagem ao painel. */
function assistMensagem(texto, autor = 'bot', extraHTML = '') {
  const box = document.getElementById('assist-mensagens');
  if (!box) return null;
  const wrap = document.createElement('div');
  wrap.className = `assist-msg flex ${autor === 'user' ? 'justify-end' : 'justify-start'}`;
  const bolha = document.createElement('div');
  bolha.className = `assist-bolha ${autor === 'user' ? 'assist-bolha-user' : 'assist-bolha-bot'}`;
  bolha.innerHTML = `${esc(texto)}${extraHTML}`;
  wrap.appendChild(bolha);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

/* Indicador "a escrever…". */
function assistATyping() {
  const box = document.getElementById('assist-mensagens');
  if (!box) return null;
  const wrap = document.createElement('div');
  wrap.className = 'assist-msg flex justify-start';
  wrap.innerHTML = `<div class="assist-bolha assist-bolha-bot assist-typing"><span></span><span></span><span></span></div>`;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

/* Renderiza as sugestões rápidas. */
function assistRenderSugestoes() {
  const box = document.getElementById('assist-sugestoes');
  if (!box) return;
  box.innerHTML = ASSIST_SUGESTOES
    .map((s) => `<button type="button" class="assist-sugestao rounded-full bg-slate-100 px-3 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-brand-50 hover:text-brand-700 active:scale-95">${esc(s)}</button>`)
    .join('');
  box.querySelectorAll('.assist-sugestao').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById('assist-input');
      assistProcessar(btn.textContent);
      if (input) input.value = '';
    });
  });
}

/* Executa a pesquisa para um par origem/destino e responde no chat. */
function assistExecutarPesquisa(origem, destino, dataInfo) {
  if (norm(origem) === norm(destino)) {
    assistMensagem('A origem e o destino parecem ser a mesma paragem. Indica duas paragens diferentes.');
    return;
  }

  // Preenche os inputs e dispara a pesquisa.
  document.getElementById('origem').value = origem;
  document.getElementById('destino').value = destino;
  if (dataInfo) {
    const dataInput = document.getElementById('data');
    dataInput.value = dataInfo.iso;
    atualizarInfoData();
  }
  mudarAba('pesquisa');
  runSearch();

  // Conta os resultados efetivamente apresentados.
  const n = document.querySelectorAll('#results .viagem-toggle').length;
  const quando = dataInfo ? ` ${dataInfo.label}` : '';

  if (n === 0) {
    assistMensagem(
      `Não encontrei viagens entre ${origem} e ${destino}${quando}. Tenta outra data ou verifica as paragens.`
    );
    return;
  }

  const primeira = document.querySelector('#results .viagem-hora-partida')?.textContent?.trim();
  const hora = primeira ? ` A primeira partida é às ${primeira}.` : '';
  assistMensagem(
    `Encontrei ${n} ${n === 1 ? 'viagem' : 'viagens'} entre ${origem} e ${destino}${quando}.${hora}`,
    'bot',
    `<div class="mt-2"><button type="button" class="assist-ver-resultados rounded-full bg-brand-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-700 active:scale-95">Ver resultados</button></div>`
  );

  const botoes = document.querySelectorAll('#assist-mensagens .assist-ver-resultados');
  botoes[botoes.length - 1]?.addEventListener('click', () => {
    mudarAba('pesquisa');
    assistFechar();
    document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* Pergunta de confirmação por aproximação: "Refere-se a X?" com Sim/Não. */
function assistConfirmarSugestao(sugestao, contexto) {
  const { paragem, termo, campo } = sugestao;
  const rotulo = campo === 'origem' ? 'origem' : 'destino';
  assistMensagem(
    `Não percebi perfeitamente. Refere-se a ${paragem}?`,
    'bot',
    `<div class="mt-2 flex gap-2">
       <button type="button" class="assist-sim rounded-full bg-brand-600 px-3.5 py-1.5 text-xs font-bold text-white transition hover:bg-brand-700 active:scale-95">Sim</button>
       <button type="button" class="assist-nao rounded-full bg-slate-200 px-3.5 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-300 active:scale-95">Não</button>
     </div>`
  );

  const bolhas = document.querySelectorAll('#assist-mensagens .assist-bolha');
  const ultima = bolhas[bolhas.length - 1];
  const btnSim = ultima?.querySelector('.assist-sim');
  const btnNao = ultima?.querySelector('.assist-nao');

  btnSim?.addEventListener('click', () => {
    btnSim.disabled = true;
    btnNao.disabled = true;
    assistMensagem(`Certo, ${rotulo}: ${paragem}.`, 'user');

    // Completa o par com o que já existia no contexto.
    let origem = contexto.origem;
    let destino = contexto.destino;
    if (campo === 'origem') origem = paragem; else destino = paragem;

    if (origem && destino) {
      assistExecutarPesquisa(origem, destino, contexto.dataInfo);
    } else {
      const falta = !origem ? 'origem' : 'destino';
      assistMensagem(
        `Guardei ${paragem} como ${rotulo}. Falta indicar a ${falta} — escreve, por exemplo: "${origem || paragem} para ${destino || 'Destino'}".`
      );
    }
  });

  btnNao?.addEventListener('click', () => {
    btnSim.disabled = true;
    btnNao.disabled = true;
    assistMensagem(
      `Sem problema. Tenta escrever de novo com mais detalhe ou usa o botão ☰ junto ao campo para escolher da lista alfabética de paragens.`
    );
  });
}

/* Processa a mensagem do utilizador e responde. */
function assistProcessar(texto) {
  const msg = String(texto || '').trim();
  if (!msg) return;

  assistMensagem(msg, 'user');
  const typing = assistATyping();

  setTimeout(() => {
    typing?.remove();

    const { origem, destino, sugestoes } = assistInterpretar(msg);
    const dataInfo = assistInterpretarData(msg);

    // Caso 1: ambas as paragens identificadas com confiança.
    if (origem && destino) {
      assistExecutarPesquisa(origem, destino, dataInfo);
      return;
    }

    // Caso 2: há sugestões por aproximação (para um ou ambos os lados).
    if (sugestoes && sugestoes.length) {
      const s = sugestoes[0];
      assistConfirmarSugestao(s, { origem, destino, dataInfo });
      return;
    }

    // Caso 3: nada identificado.
    const parcial = origem
      ? ` Identifiquei a origem "${origem}", mas não o destino.`
      : (destino ? ` Identifiquei o destino "${destino}", mas não a origem.` : '');
    assistMensagem(
      `Não consegui identificar as paragens.${parcial} Experimenta escrever no formato: Origem para Destino.`
    );
  }, 420);
}

/* Liga os eventos do assistente. */
function ligarAssistente() {
  const btn = document.getElementById('assist-btn');
  const fechar = document.getElementById('assist-fechar');
  const form = document.getElementById('assist-form');
  const input = document.getElementById('assist-input');
  if (!btn || !form) return;

  btn.addEventListener('click', assistAlternar);
  fechar?.addEventListener('click', assistFechar);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = input.value;
    input.value = '';
    input.style.height = 'auto';
    assistProcessar(texto);
  });

  // Enter envia; Shift+Enter faz nova linha.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Auto-cresce o textarea.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  });

  // Escape fecha o painel.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && assistAberto) assistFechar();
  });

  // Mensagem de boas-vindas + sugestões.
  assistMensagem(ASSIST_SAUDACAO);
  assistRenderSugestoes();
}

/* ---------------- Inicialização ---------------- */

function bindEvents() {
  const form = document.getElementById('search-form');
  const swapBtn = document.getElementById('btn-swap');
  const origem = document.getElementById('origem');
  const destino = document.getElementById('destino');
  const dataInput = document.getElementById('data');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });

  swapBtn.addEventListener('click', () => {
    const a = origem.value;
    origem.value = destino.value;
    destino.value = a;
    origem.focus();
    if (origem.value.trim() && destino.value.trim()) runSearch();
  });

  dataInput.addEventListener('change', () => {
    atualizarInfoData();
    if (origem.value.trim() && destino.value.trim()) runSearch();
  });

  document.getElementById('tab-pesquisa').addEventListener('click', () => mudarAba('pesquisa'));
  document.getElementById('tab-guardados').addEventListener('click', () => mudarAba('guardados'));
}

function runSearch() {
  const origem = document.getElementById('origem').value.trim();
  const destino = document.getElementById('destino').value.trim();
  const iso = document.getElementById('data').value;

  if (!origem || !destino) {
    setStatus('Indique a origem e o destino.');
    return;
  }
  if (norm(origem) === norm(destino)) {
    setStatus('A origem e o destino têm de ser diferentes.');
    return;
  }

  const diaSemana = iso ? diaSemanaDaData(iso) : new Date().getDay();
  const trips = findTrips(origem, destino, diaSemana);
  renderResults(trips, origem, destino, diaSemana);
}

async function init() {
  const dataInput = document.getElementById('data');
  dataInput.value = hojeISO();
  atualizarInfoData();

  carregarFavoritos();
  atualizarContadorFavoritos();
  carregarOcultas();
  carregarManuais();
  mudarAba('pesquisa');
  bindEvents();
  ligarSeletorParagens();
  ligarAssistente();
  ligarReporte();

  try {
    await loadData();
    buildStops();
    rebuildTrips();
    populateDatalist();
    setStatus('Escolha a origem e o destino para ver as viagens do dia.');
    document.getElementById('origem').focus();
  } catch (err) {
    console.error(err);
    setStatus('Erro ao carregar horarios.json — ' + err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', init);
