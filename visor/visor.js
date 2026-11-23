// Visor en línea del compendio: PDF.js con índice de marcadores y buscador propio.
import * as pdfjsLib from "./pdfjs/build/pdf.min.mjs";

globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFLinkService, PDFViewer, LinkTarget } = await import("./pdfjs/web/pdf_viewer.mjs");

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/build/pdf.worker.min.mjs", import.meta.url).href;

const RUTAS = {
  pdf: "compendio.pdf",
  meta: "datos/compendio.json",
  texto: "datos/texto.json",
};
const POR_TANDA = 200;
const MAX_RESULTADOS = 10000;
const CONTEXTO = 70;

const $ = (id) => document.getElementById(id);
const numero = new Intl.NumberFormat("es-CL");
const estrecho = matchMedia("(max-width: 760px)");

// ---------------------------------------------------------------------------
// Normalización: minúsculas y sin tildes (la ñ se conserva), largo idéntico al
// original para que cada posición del texto normalizado sea la misma del real.
// ---------------------------------------------------------------------------
const plegados = new Map();
function plegarCaracter(c) {
  let r = plegados.get(c);
  if (r === undefined) {
    if (c === "ñ" || c === "Ñ") r = "ñ";
    else {
      const base = c.normalize("NFD")[0].toLowerCase();
      r = base.length === 1 ? base : c;
    }
    plegados.set(c, r);
  }
  return r;
}
function plegar(texto) {
  const minusculas = texto.toLowerCase();
  if (minusculas.length === texto.length) return minusculas.replace(/[^\x00-\x7f]/g, plegarCaracter);
  let salida = "";
  for (const c of texto) salida += c.length === 1 ? plegarCaracter(c) : c;
  return salida;
}
// Pie de página que Ley Chile repite en cada hoja: no cuenta para la búsqueda. Se
// reemplaza por \0 (mismo largo), así no hay coincidencias dentro de él ni a través de él.
const PIE_LEY_CHILE = /biblioteca del congreso nacional de chile - www\.leychile\.cl - documento generado el \S+ ?pagina \d+ de \d+/g;
function sinPie(plano) {
  return plano.replace(PIE_LEY_CHILE, (m) => "\0".repeat(m.length));
}
const esLetra = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function prepararConsulta(texto) {
  return plegar(texto.replace(/\s+/g, " ").trim());
}

function* coincidencias(plano, q, palabraCompleta) {
  let desde = 0;
  while (true) {
    const i = plano.indexOf(q, desde);
    if (i === -1) return;
    desde = i + 1;
    if (palabraCompleta && (esLetra(plano[i - 1]) || esLetra(plano[i + q.length]))) continue;
    yield i;
  }
}

function escapar(t) {
  return t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function tituloLegible(t) {
  return t.replace(/^ART[ÍíI]CULO\b/, "Artículo");
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const estado = {
  meta: null,
  marcadores: [], // {nivel, titulo, pagina, offset}
  normas: [], // índices de marcadores de nivel 2
  textos: null,
  planos: null,
  cargaTexto: null,
  resultados: [],
  mostrados: 0,
  actual: -1,
  consulta: "",
  palabraCompleta: false,
  pendiente: null, // resultado al que hay que desplazarse cuando se dibuje su página
};

// ---------------------------------------------------------------------------
// Visor PDF.js
// ---------------------------------------------------------------------------
const contenedor = $("contenedor-visor");
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget?.BLANK ?? 2, externalLinkRel: "noopener noreferrer" });
const viewer = new PDFViewer({
  container: contenedor,
  viewer: $("visor"),
  eventBus,
  linkService,
  textLayerMode: 1,
  removePageBorders: false,
});
linkService.setViewer(viewer);

const paginaInicial = (() => {
  const m = location.hash.match(/(?:pagina|page)=(\d+)/);
  return m ? Number(m[1]) : 1;
})();

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = estrecho.matches ? "page-width" : "page-width";
  if (paginaInicial > 1) viewer.currentPageNumber = Math.min(paginaInicial, viewer.pagesCount);
});

let primeraPagina = true;
eventBus.on("pagerendered", () => {
  if (primeraPagina) {
    primeraPagina = false;
    $("carga").hidden = true;
  }
});

eventBus.on("pagechanging", ({ pageNumber }) => {
  $("pagina").value = pageNumber;
  actualizarUbicacion(pageNumber);
  history.replaceState(null, "", `#pagina=${pageNumber}`);
});

eventBus.on("scalechanging", ({ scale, presetValue }) => {
  const select = $("escala");
  const opcion = [...select.options].find((o) => o.value === (presetValue ?? String(scale)));
  if (opcion && !opcion.hidden) select.value = opcion.value;
  else {
    const personalizada = select.querySelector('[value="personalizada"]');
    personalizada.textContent = `${Math.round(scale * 100)} %`;
    select.value = "personalizada";
  }
});

eventBus.on("textlayerrendered", ({ pageNumber }) => {
  resaltarPagina(pageNumber);
  if (estado.pendiente && estado.pendiente.p === pageNumber) enfocarActual();
});

async function abrirDocumento() {
  const tarea = pdfjsLib.getDocument({
    url: RUTAS.pdf,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 256 * 1024,
    standardFontDataUrl: "pdfjs/standard_fonts/",
    cMapUrl: "pdfjs/cmaps/",
    cMapPacked: true,
    wasmUrl: "pdfjs/wasm/",
  });
  tarea.onProgress = ({ loaded, total }) => {
    const barra = $("progreso");
    if (total) {
      barra.max = total;
      barra.value = loaded;
    }
  };
  try {
    const documento = await tarea.promise;
    viewer.setDocument(documento);
    linkService.setDocument(documento);
    $("total-paginas").textContent = `/ ${numero.format(documento.numPages)}`;
  } catch (error) {
    console.error(error);
    $("texto-carga").innerHTML =
      'No se pudo abrir el PDF. <a href="https://github.com/n-a-monterocarvajal/Compendio-Normativo-Gobierno-Descentralizacion-y-Regionalizacion-Chile/releases/latest">Descárguelo desde el release</a>.';
    $("progreso").hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Metadatos e índice
// ---------------------------------------------------------------------------
async function cargarMeta() {
  const meta = await (await fetch(RUTAS.meta)).json();
  estado.meta = meta;
  estado.marcadores = meta.marcadores.map(([nivel, titulo, pagina]) => ({ nivel, titulo, pagina, offset: 0 }));
  estado.normas = estado.marcadores.flatMap((m, i) => (m.nivel === 2 ? [i] : []));
  if (meta.titulo) $("titulo").textContent = meta.titulo;
  if (meta.url_descarga) $("descargar").href = meta.url_descarga;

  const pie = $("pie-panel");
  const fecha = meta.publicado ? new Date(meta.publicado).toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" }) : "";
  pie.innerHTML =
    `Versión ${meta.url_release ? `<a href="${escapar(meta.url_release)}">${escapar(meta.tag || meta.archivo)}</a>` : escapar(meta.archivo)}` +
    (fecha ? `, publicada el ${escapar(fecha)}` : "") +
    `. ${numero.format(meta.paginas)} páginas.`;

  construirIndice();
  actualizarUbicacion(viewer.currentPageNumber || 1);
}

function arbolDeMarcadores(lista) {
  const raiz = { nivel: 0, hijos: [] };
  const pila = [raiz];
  lista.forEach((m, i) => {
    const nodo = { ...m, i, hijos: [] };
    while (pila.length > 1 && pila.at(-1).nivel >= m.nivel) pila.pop();
    pila.at(-1).hijos.push(nodo);
    pila.push(nodo);
  });
  return raiz.hijos;
}

const iconoFlecha = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const filasPorMarcador = new Map();

function dibujarLista(nodos, ul, abrirHasta) {
  for (const nodo of nodos) {
    const li = document.createElement("li");
    li.className = `nivel-${Math.min(nodo.nivel, 3)}`;
    const fila = document.createElement("div");
    fila.className = "fila";

    const desplegar = document.createElement("button");
    desplegar.type = "button";
    desplegar.className = "desplegar" + (nodo.hijos.length ? "" : " vacio");
    desplegar.innerHTML = iconoFlecha;
    desplegar.setAttribute("aria-expanded", "false");
    desplegar.setAttribute("aria-label", "Desplegar");
    desplegar.tabIndex = nodo.hijos.length ? 0 : -1;

    const entrada = document.createElement("button");
    entrada.type = "button";
    entrada.className = "entrada";
    entrada.title = nodo.titulo;
    entrada.innerHTML = `<span>${escapar(tituloLegible(nodo.titulo))}</span><span class="pag">${numero.format(nodo.pagina)}</span>`;
    entrada.addEventListener("click", () => {
      irAPagina(nodo.pagina);
      if (estrecho.matches) mostrarPanel(false);
    });
    filasPorMarcador.set(nodo.i, entrada);

    fila.append(desplegar, entrada);
    li.append(fila);
    ul.append(li);

    if (nodo.hijos.length) {
      let sub = null;
      const alternar = (abrir) => {
        if (abrir && !sub) {
          sub = document.createElement("ul");
          dibujarLista(nodo.hijos, sub, abrirHasta);
          li.append(sub);
        }
        if (sub) sub.hidden = !abrir;
        desplegar.setAttribute("aria-expanded", String(abrir));
      };
      desplegar.addEventListener("click", () => alternar(desplegar.getAttribute("aria-expanded") !== "true"));
      if (nodo.nivel < abrirHasta) alternar(true);
    }
  }
}

function construirIndice() {
  const nav = $("indice");
  nav.textContent = "";
  const ul = document.createElement("ul");
  dibujarLista(arbolDeMarcadores(estado.marcadores), ul, 2);
  nav.append(ul);
}

// Última norma (marcador de nivel 2) que empieza en la página indicada o antes.
function normaDePagina(p) {
  const { normas, marcadores } = estado;
  let lo = 0, hi = normas.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marcadores[normas[mid]].pagina <= p) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

// Marcador más profundo (nivel ≥ 3) vigente en la posición indicada de la página.
function seccionDePosicion(p, pos) {
  const { marcadores } = estado;
  let lo = 0, hi = marcadores.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = marcadores[mid];
    if (m.pagina < p || (m.pagina === p && m.offset <= pos)) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = r; i >= 0; i--) {
    if (marcadores[i].nivel <= 2) return null;
    if (marcadores[i].titulo !== "Encabezado") return marcadores[i];
  }
  return null;
}

let normaMarcada = null;
function actualizarUbicacion(p) {
  if (!estado.marcadores.length) return;
  const n = normaDePagina(p);
  const marcador = n >= 0 ? estado.marcadores[estado.normas[n]] : null;
  $("ubicacion").textContent = marcador ? marcador.titulo : "";
  const fila = n >= 0 ? filasPorMarcador.get(estado.normas[n]) : null;
  if (normaMarcada !== fila) {
    normaMarcada?.classList.remove("actual");
    fila?.classList.add("actual");
    normaMarcada = fila;
  }
}

function irAPagina(p) {
  viewer.scrollPageIntoView({ pageNumber: p });
}

// ---------------------------------------------------------------------------
// Texto para el buscador
// ---------------------------------------------------------------------------
function cargarTexto() {
  if (!estado.cargaTexto) {
    $("estado-busqueda").textContent = "Cargando el texto del compendio…";
    estado.cargaTexto = fetch(RUTAS.texto)
      .then((r) => r.json())
      .then((textos) => {
        estado.textos = textos;
        estado.planos = textos.map((t) => sinPie(plegar(t)));
        ubicarMarcadoresEnTexto();
        if (!$("consulta").value.trim()) $("estado-busqueda").textContent = "Escriba al menos dos caracteres. No distingue mayúsculas ni tildes.";
      })
      .catch((error) => {
        console.error(error);
        $("estado-busqueda").textContent = "No se pudo cargar el texto para buscar.";
        estado.cargaTexto = null;
        throw error;
      });
  }
  return estado.cargaTexto;
}

// Ubica cada marcador profundo (artículos, títulos) dentro del texto de su página,
// para saber en qué artículo cae cada coincidencia.
function ubicarMarcadoresEnTexto() {
  let paginaPrevia = 0, desde = 0;
  for (const m of estado.marcadores) {
    if (m.pagina !== paginaPrevia) { paginaPrevia = m.pagina; desde = 0; }
    if (m.nivel <= 2) { m.offset = 0; continue; }
    const plano = estado.planos[m.pagina - 1] || "";
    const i = plano.indexOf(prepararConsulta(m.titulo), desde);
    if (i >= 0) { m.offset = i; desde = i + 1; } else m.offset = desde;
  }
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------
function rangoDePaginas() {
  if (!$("solo-norma").checked || !estado.normas.length) return [1, estado.textos.length];
  const n = normaDePagina(viewer.currentPageNumber || 1);
  if (n < 0) return [1, estado.textos.length];
  const desde = estado.marcadores[estado.normas[n]].pagina;
  const siguiente = estado.normas[n + 1];
  const hasta = siguiente !== undefined ? estado.marcadores[siguiente].pagina : estado.textos.length;
  return [desde, hasta];
}

async function buscar() {
  const texto = $("consulta").value;
  const q = prepararConsulta(texto);
  estado.consulta = q.length >= 2 ? q : "";
  estado.palabraCompleta = $("palabra-completa").checked;
  estado.resultados = [];
  estado.actual = -1;
  estado.pendiente = null;
  $("resultados").textContent = "";

  if (!estado.consulta) {
    $("estado-busqueda").textContent = "Escriba al menos dos caracteres. No distingue mayúsculas ni tildes.";
    actualizarFlechas();
    resaltarTodo();
    return;
  }
  await cargarTexto();
  if (q !== prepararConsulta($("consulta").value)) return; // llegó otra consulta mientras cargaba

  const [desde, hasta] = rangoDePaginas();
  const resultados = [];
  const paginas = new Set();
  let excedido = false;
  for (let p = desde; p <= hasta && !excedido; p++) {
    let k = 0;
    for (const pos of coincidencias(estado.planos[p - 1], q, estado.palabraCompleta)) {
      resultados.push({ p, pos, k: k++ });
      paginas.add(p);
      if (resultados.length >= MAX_RESULTADOS) { excedido = true; break; }
    }
  }
  estado.resultados = resultados;
  estado.mostrados = 0;
  if (!resultados.length) {
    $("estado-busqueda").textContent = "Sin coincidencias.";
  } else {
    const cuantas = excedido ? `Más de ${numero.format(MAX_RESULTADOS)} coincidencias` : `${numero.format(resultados.length)} ${resultados.length === 1 ? "coincidencia" : "coincidencias"}`;
    $("estado-busqueda").textContent = `${cuantas} en ${numero.format(paginas.size)} ${paginas.size === 1 ? "página" : "páginas"}.`;
    mostrarMas();
  }
  actualizarFlechas();
  resaltarTodo();
}

// Contexto de una coincidencia, sin el pie de página de Ley Chile.
function fragmento(r) {
  const original = estado.textos[r.p - 1];
  const plano = estado.planos[r.p - 1];
  const largo = estado.consulta.length;
  const limpio = (desde, hasta) => {
    let t = "";
    for (let i = desde; i < hasta; i++) if (plano[i] !== "\0") t += original[i];
    return t.replace(/\s+/g, " ");
  };
  let antes = limpio(0, r.pos);
  let despues = limpio(r.pos + largo, original.length);
  const cortaAntes = antes.length > CONTEXTO;
  const cortaDespues = despues.length > CONTEXTO;
  if (cortaAntes) {
    antes = antes.slice(-CONTEXTO);
    const s = antes.indexOf(" ");
    if (s !== -1) antes = antes.slice(s + 1);
  }
  if (cortaDespues) {
    despues = despues.slice(0, CONTEXTO);
    const s = despues.lastIndexOf(" ");
    if (s > 0) despues = despues.slice(0, s);
  }
  return (cortaAntes ? "… " : "") + escapar(antes) + "<mark>" + escapar(original.slice(r.pos, r.pos + largo)) + "</mark>" + escapar(despues) + (cortaDespues ? " …" : "");
}

function etiquetaUbicacion(r) {
  const n = normaDePagina(r.p);
  const norma = n >= 0 ? estado.marcadores[estado.normas[n]].titulo : "";
  const seccion = seccionDePosicion(r.p, r.pos);
  return { norma, seccion: seccion ? tituloLegible(seccion.titulo) : "" };
}

function mostrarMas() {
  const ol = $("resultados");
  ol.querySelector(".mas")?.remove();
  const hasta = Math.min(estado.resultados.length, estado.mostrados + POR_TANDA);
  const fragmentoDom = document.createDocumentFragment();
  for (let i = estado.mostrados; i < hasta; i++) {
    const r = estado.resultados[i];
    const { norma, seccion } = etiquetaUbicacion(r);
    const li = document.createElement("li");
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "resultado";
    boton.dataset.i = i;
    boton.title = norma;
    boton.innerHTML =
      `<span class="donde"><span>${escapar(seccion ? `${seccion} · ${norma}` : norma)}</span><span>pág. ${numero.format(r.p)}</span></span>` +
      fragmento(r);
    li.append(boton);
    fragmentoDom.append(li);
  }
  ol.append(fragmentoDom);
  estado.mostrados = hasta;
  if (hasta < estado.resultados.length) {
    const li = document.createElement("li");
    li.className = "mas";
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "boton";
    boton.textContent = `Mostrar ${numero.format(Math.min(POR_TANDA, estado.resultados.length - hasta))} más`;
    boton.addEventListener("click", mostrarMas);
    li.append(boton);
    ol.append(li);
  }
}

function seleccionar(i) {
  if (!estado.resultados.length) return;
  i = (i + estado.resultados.length) % estado.resultados.length;
  while (i >= estado.mostrados) mostrarMas();
  $("resultados").querySelector(".resultado.actual")?.classList.remove("actual");
  const boton = $("resultados").querySelector(`.resultado[data-i="${i}"]`);
  boton?.classList.add("actual");
  boton?.scrollIntoView({ block: "nearest" });
  estado.actual = i;
  const r = estado.resultados[i];
  $("estado-busqueda").textContent = `Coincidencia ${numero.format(i + 1)} de ${numero.format(estado.resultados.length)}${estado.resultados.length >= MAX_RESULTADOS ? "+" : ""}.`;
  estado.pendiente = r;
  actualizarFlechas();
  resaltarTodo();
  if (!enfocarActual()) irAPagina(r.p);
}

function actualizarFlechas() {
  const hay = estado.resultados.length > 0;
  $("anterior").disabled = !hay;
  $("siguiente").disabled = !hay;
}

// ---------------------------------------------------------------------------
// Resaltado sobre la capa de texto de PDF.js (CSS Custom Highlight API)
// ---------------------------------------------------------------------------
const soportaResaltado = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
const resaltado = soportaResaltado ? new Highlight() : null;
const resaltadoActual = soportaResaltado ? new Highlight() : null;
if (soportaResaltado) {
  resaltadoActual.priority = 1;
  CSS.highlights.set("busqueda", resaltado);
  CSS.highlights.set("busqueda-actual", resaltadoActual);
}
const rangosPorPagina = new Map();

function textoDeCapa(div) {
  const nodos = [], nodo = [], offset = [];
  let texto = "";
  let espacio = false;
  const recorrido = document.createTreeWalker(div, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = recorrido.nextNode(); n; n = recorrido.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      if (n.tagName === "BR") espacio = true;
      continue;
    }
    const indice = nodos.push(n) - 1;
    const valor = n.nodeValue;
    for (let i = 0; i < valor.length; i++) {
      const c = valor[i];
      if (/\s/.test(c)) { espacio = true; continue; }
      if (espacio && texto.length) { texto += " "; nodo.push(indice); offset.push(i); }
      espacio = false;
      texto += c;
      nodo.push(indice);
      offset.push(i);
    }
  }
  return { plano: sinPie(plegar(texto)), nodos, nodo, offset };
}

function resaltarPagina(p) {
  if (!soportaResaltado) return [];
  for (const r of rangosPorPagina.get(p) || []) { resaltado.delete(r); resaltadoActual.delete(r); }
  rangosPorPagina.delete(p);
  if (!estado.consulta) return [];
  const div = viewer.getPageView(p - 1)?.textLayer?.div;
  if (!div || !div.isConnected || !div.firstChild) return [];

  const { plano, nodos, nodo, offset } = textoDeCapa(div);
  const rangos = [];
  const largo = estado.consulta.length;
  for (const s of coincidencias(plano, estado.consulta, estado.palabraCompleta)) {
    const e = s + largo - 1;
    if (e >= nodo.length) break;
    const rango = document.createRange();
    rango.setStart(nodos[nodo[s]], offset[s]);
    rango.setEnd(nodos[nodo[e]], offset[e] + 1);
    rangos.push(rango);
    resaltado.add(rango);
  }
  rangosPorPagina.set(p, rangos);
  const actual = estado.resultados[estado.actual];
  if (actual && actual.p === p && rangos.length) resaltadoActual.add(rangos[Math.min(actual.k, rangos.length - 1)]);
  return rangos;
}

function resaltarTodo() {
  if (!soportaResaltado) return;
  resaltado.clear();
  resaltadoActual.clear();
  rangosPorPagina.clear();
  for (let i = 0; i < viewer.pagesCount; i++) {
    const div = viewer.getPageView(i)?.textLayer?.div;
    if (div && div.isConnected && div.firstChild) resaltarPagina(i + 1);
  }
}

// Desplaza el documento hasta la coincidencia seleccionada, si su página ya tiene capa de texto.
function enfocarActual() {
  const r = estado.pendiente;
  if (!r) return false;
  const rangos = rangosPorPagina.get(r.p);
  if (!rangos || !rangos.length) {
    const vista = viewer.getPageView(r.p - 1);
    if (!vista?.textLayer?.div?.firstChild) return false;
    if (!soportaResaltado) { estado.pendiente = null; irAPagina(r.p); return true; }
    return false;
  }
  const rango = rangos[Math.min(r.k, rangos.length - 1)];
  const caja = rango.getBoundingClientRect();
  const marco = contenedor.getBoundingClientRect();
  contenedor.scrollTop += caja.top - marco.top - marco.height * 0.3;
  if (caja.left < marco.left || caja.right > marco.right) contenedor.scrollLeft += caja.left - marco.left - 40;
  estado.pendiente = null;
  return true;
}

// ---------------------------------------------------------------------------
// Panel, pestañas y teclado
// ---------------------------------------------------------------------------
function mostrarPanel(visible) {
  $("panel").classList.toggle("oculto", !visible);
  $("alternar-panel").setAttribute("aria-expanded", String(visible));
}

function elegirPestana(cual) {
  const buscar = cual === "buscar";
  $("pestana-indice").setAttribute("aria-selected", String(!buscar));
  $("pestana-buscar").setAttribute("aria-selected", String(buscar));
  $("vista-indice").hidden = buscar;
  $("vista-buscar").hidden = !buscar;
}

function abrirBusqueda() {
  mostrarPanel(true);
  elegirPestana("buscar");
  const consulta = $("consulta");
  consulta.focus();
  consulta.select();
  cargarTexto().catch(() => {});
}

function ajustarAltoBarra() {
  document.documentElement.style.setProperty("--alto-barra", `${document.querySelector(".barra").offsetHeight}px`);
}

let espera = null;
$("consulta").addEventListener("input", () => {
  clearTimeout(espera);
  espera = setTimeout(buscar, 220);
});
$("consulta").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(espera);
    const avanzar = () => seleccionar(estado.actual + (e.shiftKey ? -1 : 1));
    if (prepararConsulta($("consulta").value) !== estado.consulta) buscar().then(avanzar);
    else avanzar();
  }
});
$("buscador").addEventListener("submit", (e) => e.preventDefault());
$("solo-norma").addEventListener("change", buscar);
$("palabra-completa").addEventListener("change", buscar);
$("anterior").addEventListener("click", () => seleccionar(estado.actual - 1));
$("siguiente").addEventListener("click", () => seleccionar(estado.actual + 1));
$("resultados").addEventListener("click", (e) => {
  const boton = e.target.closest(".resultado");
  if (!boton) return;
  seleccionar(Number(boton.dataset.i));
  if (estrecho.matches) mostrarPanel(false);
});

$("pestana-indice").addEventListener("click", () => elegirPestana("indice"));
$("pestana-buscar").addEventListener("click", abrirBusqueda);
$("abrir-busqueda").addEventListener("click", abrirBusqueda);
$("alternar-panel").addEventListener("click", () => mostrarPanel($("panel").classList.contains("oculto")));

$("pagina").addEventListener("change", () => {
  const p = parseInt($("pagina").value, 10);
  if (p >= 1 && p <= viewer.pagesCount) viewer.currentPageNumber = p;
  else $("pagina").value = viewer.currentPageNumber;
});
$("pagina").addEventListener("focus", () => $("pagina").select());
$("escala").addEventListener("change", () => {
  const v = $("escala").value;
  if (v !== "personalizada") viewer.currentScaleValue = v;
});
$("acercar").addEventListener("click", () => viewer.increaseScale());
$("alejar").addEventListener("click", () => viewer.decreaseScale());

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    abrirBusqueda();
  } else if (e.key === "F3" || (mod && e.key.toLowerCase() === "g")) {
    if (!estado.resultados.length) return;
    e.preventDefault();
    seleccionar(estado.actual + (e.shiftKey ? -1 : 1));
  } else if (e.key === "Escape" && estrecho.matches && !$("panel").classList.contains("oculto")) {
    mostrarPanel(false);
  }
});

window.addEventListener("resize", ajustarAltoBarra);
estrecho.addEventListener("change", () => mostrarPanel(!estrecho.matches));
ajustarAltoBarra();
if (estrecho.matches) mostrarPanel(false);

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
abrirDocumento();
cargarMeta().catch((error) => {
  console.error(error);
  $("indice").innerHTML = '<p class="aviso">No se pudo cargar el índice.</p>';
});

const consultaInicial = new URLSearchParams(location.hash.slice(1)).get("buscar");
if (consultaInicial) {
  $("consulta").value = consultaInicial;
  abrirBusqueda();
  buscar();
}
