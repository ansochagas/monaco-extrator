import React, { useState, useRef } from "react";
import { Upload, Download, FileText, CheckCircle, Loader } from "lucide-react";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import arteColaboradorSrc from "./assets/arte_colaborador_monaco.png";
import arteGerenteSrc from "./assets/arte_gerente_red.png";

const arteColaboradorNovoSrc = "/arte_colaborador_nova.jpeg";

GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

const normalizeCell = (value) => (value ?? "").toString().trim();

const NAME_PARTICLES = new Set(["DA", "DE", "DI", "DO", "DOS", "DAS", "E"]);

const normalizeComparable = (value) =>
  normalizeCell(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const normalizeDisplayName = (value) =>
  normalizeCell(value).replace(/\s+/g, " ").trim();

const buildAbbreviatedName = (value) => {
  const parts = normalizeDisplayName(value).split(" ").filter(Boolean);
  if (parts.length <= 2) return parts.join(" ");

  return parts
    .map((part, index) => {
      if (index === 0 || index === parts.length - 1) return part;
      if (NAME_PARTICLES.has(part)) return part;
      return `${part.charAt(0)}.`;
    })
    .join(" ");
};

const buildCompactName = (value) => {
  const parts = normalizeDisplayName(value).split(" ").filter(Boolean);
  if (parts.length <= 2) return parts.join(" ");

  const lastRelevant =
    [...parts]
      .reverse()
      .find((part) => !NAME_PARTICLES.has(part) && part.length > 1) ||
    parts[parts.length - 1];

  return [parts[0], lastRelevant].filter(Boolean).join(" ");
};

const buildVendorNameVariants = (value) => {
  const baseName = normalizeDisplayName(value).toUpperCase() || "SEM NOME";
  return [...new Set([baseName, buildAbbreviatedName(baseName), buildCompactName(baseName)])]
    .map((name) => normalizeDisplayName(name))
    .filter(Boolean);
};

const HEADER_LABELS = [
  "vendedor",
  "apurado",
  "comissao",
  "premios",
  "total",
  "lancamentos",
  "area",
];

const OPTIONAL_HEADERS = ["total", "lancamentos", "area"];

const REQUIRED_HEADERS = HEADER_LABELS.filter(
  (h) => !OPTIONAL_HEADERS.includes(h)
);

const HEADER_ALIASES = {
  vendedor: ["vendedor", "usuario", "colaborador"],
  apurado: ["apurado", "entradas"],
  comissao: ["comissao", "comissão"],
  premios: ["premios", "premio", "prêmios", "prêmio"],
  total: ["total", "liquido", "líquido", "saldo_final"],
  lancamentos: [
    "lancamentos",
    "lancamento",
    "lançamentos",
    "lançamento",
    "ajustes",
    "ajuste",
    "acertos",
  ],
  area: ["area", "área", "regiao", "região", "setor"],
};

const DEFAULT_COLUMN_INDICES = {
  area: 1,
  vendedor: 2,
  apurado: 3,
  comissao: 4,
  premios: 6,
  total: 7,
  lancamentos: 10,
};

const isHeaderRow = (cells) => {
  const normalized = cells.map(normalizeComparable);
  const hasRequired = REQUIRED_HEADERS.every((label) =>
    normalized.some((cell) => cell.startsWith(label))
  );
  if (!hasRequired) return false;
  const missingOptional = OPTIONAL_HEADERS.filter(
    (label) => !normalized.some((cell) => cell.startsWith(label))
  );
  return true;
};

const detectColumnIndices = (rows) => {
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row];
    if (!cells.length) continue;
    const normalized = cells.map(normalizeComparable);
    if (!isHeaderRow(normalized)) continue;

    const indices = {};
    Object.entries(HEADER_ALIASES).forEach(([key, aliases]) => {
      const idx = normalized.findIndex((cell) =>
        aliases.some((alias) => cell.startsWith(alias))
      );
      if (idx >= 0) indices[key] = idx;
    });

    return indices;
  }

  return null;
};

const findHeaderRowIndex = (rows) => {
  for (let i = 0; i < rows.length; i += 1) {
    const cells = Array.isArray(rows[i]) ? rows[i] : [rows[i]];
    if (isHeaderRow(cells)) return i;
  }
  return -1;
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  const cleaned = value
    .toString()
    .replace(/\s+/g, "")
    .replace(/[^0-9,.-]/g, "");

  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
  } else {
    const dots = cleaned.match(/\./g);
    if (dots && dots.length > 1) {
      const lastIndex = cleaned.lastIndexOf(".");
      normalized =
        cleaned.slice(0, lastIndex).replace(/\./g, "") +
        cleaned.slice(lastIndex);
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  }

  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toCurrency = (value) =>
  toNumber(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const isNearZero = (value) => Math.abs(toNumber(value)) < 0.000001;

const PDF_DATE_REGEX = /\b\d{2}\/\d{2}\/\d{4}\b/;

const PDF_COLUMNS = {
  vendedorMaxX: 190,
  vendido: { min: 195, max: 235 },
  comissao: { min: 235, max: 285 },
  premios: { min: 285, max: 333 },
  liquido: { min: 333, max: 372 },
  retirado: { min: 372, max: 410 },
  lancamentos: { min: 410, max: 455 },
  dAnterior: { min: 455, max: 525 },
  caixa: { min: 525, max: 590 },
};

const groupPdfLines = (items) => {
  const linesByY = new Map();

  for (const item of items) {
    const str = normalizeCell(item?.str);
    if (!str) continue;

    const x = Number(item?.transform?.[4] ?? 0);
    const y = Number(item?.transform?.[5] ?? 0);
    const yKey = y.toFixed(1);

    if (!linesByY.has(yKey)) linesByY.set(yKey, []);
    linesByY.get(yKey).push({ x, y, str });
  }

  return [...linesByY.entries()]
    .map(([y, lineItems]) => ({
      y: Number(y),
      items: lineItems.sort((a, b) => a.x - b.x),
    }))
    .sort((a, b) => b.y - a.y);
};

const readPdfColumn = (lineItems, minX, maxX) =>
  lineItems
    .filter((item) => item.x >= minX && item.x < maxX)
    .map((item) => item.str)
    .join("")
    .trim();

const buildAreaNameFromLine = (lineItems) =>
  lineItems
    .filter((item) => item.x > 55)
    .map((item) => item.str)
    .join(" ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^AREA:\s*/i, "")
    .trim();

const parsePdfData = async (arrayBuffer, periodoFallback = "") => {
  const loadingTask = getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const areasMap = new Map();
  let dataFechamento = "";
  let currentArea = "Geral";

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const lines = groupPdfLines(textContent.items);

    let insideAreaTable = false;

    for (const line of lines) {
      const lineText = line.items
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!lineText) continue;

      if (!dataFechamento) {
        const foundDate = lineText.match(PDF_DATE_REGEX);
        if (foundDate) {
          dataFechamento = foundDate[0];
        }
      }

      if (/^AREA:/i.test(lineText)) {
        currentArea = buildAreaNameFromLine(line.items) || "Geral";
        insideAreaTable = false;
        continue;
      }

      if (/^VENDEDOR\b/i.test(lineText) && /D\.ANTERIOR/i.test(lineText)) {
        insideAreaTable = true;
        continue;
      }

      if (!insideAreaTable) continue;
      if (lineText.includes("----")) continue;
      if (/\bVENDEDORES\b/i.test(lineText)) continue;

      const vendedor = line.items
        .filter((item) => item.x < PDF_COLUMNS.vendedorMaxX)
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!vendedor || /^VENDEDOR$/i.test(vendedor)) continue;

      const dAnteriorText = readPdfColumn(
        line.items,
        PDF_COLUMNS.dAnterior.min,
        PDF_COLUMNS.dAnterior.max
      );

      if (!dAnteriorText) continue;

      const vendido = toNumber(
        readPdfColumn(line.items, PDF_COLUMNS.vendido.min, PDF_COLUMNS.vendido.max)
      );
      const comissao = toNumber(
        readPdfColumn(
          line.items,
          PDF_COLUMNS.comissao.min,
          PDF_COLUMNS.comissao.max
        )
      );
      const premios = toNumber(
        readPdfColumn(line.items, PDF_COLUMNS.premios.min, PDF_COLUMNS.premios.max)
      );
      const liquido = toNumber(
        readPdfColumn(line.items, PDF_COLUMNS.liquido.min, PDF_COLUMNS.liquido.max)
      );
      const lancamentos = toNumber(
        readPdfColumn(
          line.items,
          PDF_COLUMNS.lancamentos.min,
          PDF_COLUMNS.lancamentos.max
        )
      );
      const dAnterior = toNumber(dAnteriorText);
      const caixaText = readPdfColumn(
        line.items,
        PDF_COLUMNS.caixa.min,
        PDF_COLUMNS.caixa.max
      );
      const caixa = caixaText ? toNumber(caixaText) : dAnterior;

      const cambista = {
        nome: vendedor,
        nApostas: "0",
        entradas: toCurrency(vendido),
        comissao: toCurrency(comissao),
        saidas: toCurrency(premios),
        liquido: toCurrency(liquido),
        lancamentos: toCurrency(lancamentos),
        parcial: toCurrency(caixa),
        cartoes: "0,00",
        saldoAnterior: toCurrency(dAnterior),
        saldoAnteriorNumero: dAnterior,
      };

      if (!areasMap.has(currentArea)) {
        areasMap.set(currentArea, []);
      }
      areasMap.get(currentArea).push(cambista);
    }
  }

  const periodoFinal = dataFechamento || periodoFallback || "";
  const gerentes = [];

  for (const [areaNome, cambistas] of areasMap) {
    const totalComissao = cambistas.reduce(
      (sum, cambista) => sum + toNumber(cambista.comissao),
      0
    );
    gerentes.push({
      nome: areaNome,
      area: areaNome,
      comissao: toCurrency(totalComissao),
      periodo: periodoFinal,
      cambistas,
    });
  }

  if (!gerentes.length) {
    gerentes.push({
      nome: "Relatorio Geral",
      area: "Geral",
      comissao: "0,00",
      periodo: periodoFinal,
      cambistas: [],
    });
  }

  return gerentes;
};

const parseExcelData = (rows, periodoTexto) => {
  const gerentes = [];

  const headerRowIndex = findHeaderRowIndex(rows);
  const detectedColumns = detectColumnIndices(rows) || {};
  const COLUMN_INDICES = {
    ...DEFAULT_COLUMN_INDICES,
    ...detectedColumns,
  };

  // Agrupar cambistas por área
  const areasMap = new Map();

  // Mapeamento de colunas detectado dinamicamente (com fallback nas posicoes padrao)
  // Assume fixed column positions (0-based)
  // 0: empty, 1: area, 2: VENDEDOR, 3: APURADO, 4: COMISSAO, 5: old_liquido, 6: PREMIOS, 7: TOTAL, 8: tpremios, 9: fpremio, 10: LANCAMENTOS
  let rowIndex = -1;
  for (const row of rows) {
    rowIndex += 1;
    const cells = Array.isArray(row) ? row : [row];
    const trimmed = cells.map(normalizeCell);
    if (trimmed.every((cell) => !cell)) {
      continue;
    }

    // Skip header row if it looks like headers ou estamos na/antes da linha de cabeçalho detectada
    if (
      isHeaderRow(trimmed) ||
      (headerRowIndex >= 0 && rowIndex <= headerRowIndex)
    ) {
      continue;
    }

    const nameIndex = COLUMN_INDICES.vendedor;
    const nameCell = nameIndex >= 0 ? trimmed[nameIndex] : "";

    if (!nameCell) continue;

    const areaIndex = COLUMN_INDICES.area;
    const areaCell = areaIndex >= 0 ? trimmed[areaIndex] : "Geral";

    // Usar "Geral" como fallback se não houver área
    const areaNome = areaCell || "Geral";

    const getCurrency = (index) => {
      return index >= 0 && index < trimmed.length
        ? toCurrency(trimmed[index] || 0)
        : "0,00";
    };

    const getNumber = (index) => {
      return index >= 0 && index < trimmed.length
        ? toNumber(trimmed[index] || 0)
        : 0;
    };

    const totalValue = getNumber(COLUMN_INDICES.total);
    // Lançamentos: usa o valor da coluna se existir, senão 0
    const lancamentosValue =
      COLUMN_INDICES.lancamentos >= 0 &&
      COLUMN_INDICES.lancamentos < trimmed.length
        ? getNumber(COLUMN_INDICES.lancamentos)
        : 0;

    const parcialValue = totalValue + lancamentosValue;

    const cambista = {
      nome: nameCell,
      nApostas: "0",
      entradas: getCurrency(COLUMN_INDICES.apurado),
      comissao: getCurrency(COLUMN_INDICES.comissao),
      saidas: getCurrency(COLUMN_INDICES.premios),
      liquido: getCurrency(COLUMN_INDICES.total),
      lancamentos: getCurrency(COLUMN_INDICES.lancamentos),
      parcial: toCurrency(parcialValue),
      cartoes: "0,00",
    };

    // Agrupar por área
    if (!areasMap.has(areaNome)) {
      areasMap.set(areaNome, []);
    }
    areasMap.get(areaNome).push(cambista);
  }

  // Converter mapa de áreas para array de gerentes
  for (const [areaNome, cambistas] of areasMap) {
    const gerente = {
      nome: areaNome,
      area: areaNome,
      comissao: "0,00",
      periodo: periodoTexto || "",
      cambistas: cambistas,
    };
    gerentes.push(gerente);
  }

  // Se não encontrou nenhuma área, manter compatibilidade com o sistema antigo
  if (gerentes.length === 0) {
    const gerente = {
      nome: "Relatório Geral",
      area: "Geral",
      comissao: "0,00",
      periodo: periodoTexto || "",
      cambistas: [],
    };
    gerentes.push(gerente);
  }

  return gerentes;
};

const isDebugLoggingEnabled = () => {
  if (import.meta?.env?.VITE_ENABLE_DEBUG === "1") {
    return true;
  }
  if (typeof window !== "undefined") {
    try {
      return localStorage.getItem("monaco_debug_logs") === "1";
    } catch {
      return false;
    }
  }
  return false;
};

const DEBUG_LOGS = isDebugLoggingEnabled();
console.log("[DEBUG FLAG]", DEBUG_LOGS, {
  arteColaboradorSrc,
  arteColaboradorNovoSrc,
  arteGerenteSrc,
});

const App = () => {
  const [file, setFile] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [processedData, setProcessedData] = useState(null);
  const [error, setError] = useState(null);
  const [periodoManual, setPeriodoManual] = useState("");
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);

  const handleFileUpload = async (e) => {
    const uploadedFile = e.target.files[0];
    const allowedExtensions = [".xlsx", ".xls", ".csv", ".pdf"];
    if (!uploadedFile) {
      setError("Selecione um arquivo de relatorio");
      return;
    }
    const fileName = (uploadedFile.name || "").toLowerCase();
    const isPdfFile = fileName.endsWith(".pdf");
    if (!allowedExtensions.some((ext) => fileName.endsWith(ext))) {
      setError("Envie um arquivo valido (.xlsx, .xls, .csv ou .pdf)");
      return;
    }
    if (!isPdfFile && !periodoManual.trim()) {
      setError("Informe o periodo do relatorio antes de prosseguir");
      return;
    }
    setFile(uploadedFile);
    setError(null);
    setProcessing(true);
    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      let parsedData = [];
      if (isPdfFile) {
        parsedData = await parsePdfData(arrayBuffer, periodoManual.trim());
      } else {
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!firstSheet) {
          throw new Error("Planilha sem abas validas");
        }
        const rows = XLSX.utils.sheet_to_json(firstSheet, {
          header: 1,
          raw: false,
          blankrows: false,
          defval: "",
        });
        if (!rows.length) {
          throw new Error("Planilha vazia");
        }
        parsedData = parseExcelData(rows, periodoManual.trim());
      }
      if (!parsedData.length) {
        throw new Error("Nenhuma gerencia identificada. Verifique o arquivo.");
      }
      setProcessedData(parsedData);
    } catch (err) {
      setError("Erro ao processar relatorio: " + err.message);
      console.error(err);
    } finally {
      setProcessing(false);
    }
  };

  const loadImage = (src, label) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (DEBUG_LOGS) {
          console.log(`[ART LOADER] ${label || "imagem"} carregada`, src);
        }
        resolve(img);
      };
      img.onerror = (err) => {
        console.error(`[ART LOADER] erro ao carregar ${label || src}`, err);
        reject(err);
      };
      if (DEBUG_LOGS) {
        console.log(`[ART LOADER] solicitando ${label || "imagem"}:`, src);
      }
      img.src = src;
    });

  const generateCambistaImage = async (data) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let img;
    try {
      img = await loadImage(arteColaboradorNovoSrc, "cambista_novo");
    } catch {
      img = await loadImage(arteColaboradorSrc, "cambista_fallback");
    }
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const boxes = {
      // Coordenadas calibradas a partir da arte 1080x1080.
      vendedor: { x: 0.4972, y: 0.3981, w: 0.4269, h: 0.0917 },
      saldoAte: { x: 0.4963, y: 0.5065, w: 0.4269, h: 0.0917 },
      // A caixa amarela ocupa 0.0759..0.9250; este recorte ignora a zona do "R$" fixo.
      saldo: { x: 0.225, y: 0.6509, w: 0.69, h: 0.162 },
    };
    const drawFittedText = (text, box, options = {}) => {
      const {
        maxSize = Math.round(canvas.height * 0.06),
        minSize = Math.round(canvas.height * 0.026),
        color = "#0b2f8f",
        align = "left",
        weight = 900,
        horizontalPadding = 0.03,
        nudgeUnitsX = 0,
        nudgeUnitsY = 0,
        sizeSteps = null,
        textVariants = null,
      } = options;
      const x = Math.round(box.x * canvas.width);
      const y = Math.round(box.y * canvas.height);
      const w = Math.round(box.w * canvas.width);
      const h = Math.round(box.h * canvas.height);
      const contentText = String(text || "").trim();
      if (!contentText) return;
      const maxWidth = Math.max(20, w - Math.round(w * horizontalPadding * 2));
      let fontSize = maxSize;
      let renderedText = contentText;

      if (Array.isArray(sizeSteps) && sizeSteps.length) {
        const candidateSizes = [...new Set(sizeSteps.filter(Boolean))].sort(
          (a, b) => b - a
        );
        const candidateTexts =
          Array.isArray(textVariants) && textVariants.length
            ? textVariants
            : [contentText];

        let picked = null;
        for (const candidateText of candidateTexts) {
          for (const candidateSize of candidateSizes) {
            ctx.font = `${weight} ${candidateSize}px "Montserrat", Arial, sans-serif`;
            if (ctx.measureText(candidateText).width <= maxWidth) {
              picked = { fontSize: candidateSize, text: candidateText };
              break;
            }
          }
          if (picked) break;
        }

        if (picked) {
          fontSize = picked.fontSize;
          renderedText = picked.text;
        } else {
          fontSize = candidateSizes[candidateSizes.length - 1];
          renderedText = candidateTexts[candidateTexts.length - 1];
        }
      } else {
        while (fontSize > minSize) {
          ctx.font = `${weight} ${fontSize}px "Montserrat", Arial, sans-serif`;
          if (ctx.measureText(contentText).width <= maxWidth) break;
          fontSize -= 2;
        }
      }
      const anchorX =
        align === "center"
          ? x + Math.round(w / 2)
          : x + Math.round(w * horizontalPadding);
      ctx.fillStyle = color;
      ctx.textAlign = align === "center" ? "center" : "left";
      ctx.textBaseline = "middle";
      ctx.font = `${weight} ${fontSize}px "Montserrat", Arial, sans-serif`;
      // 1 unidade = largura aproximada de 1 espaco no tamanho de fonte atual.
      const unitPx = Math.max(4, ctx.measureText(" ").width);
      const finalX = anchorX + Math.round(nudgeUnitsX * unitPx);
      const finalY = y + Math.round(h / 2) + Math.round(nudgeUnitsY * unitPx);
      ctx.fillText(renderedText, finalX, finalY);
    };
    const vendedor = buildVendorNameVariants(data?.nome);
    const saldoAte = normalizeCell(data?.periodo || data?.saldoAte || "-");
    const saldo = toCurrency(
      data?.saldoAnteriorNumero ?? data?.saldoAnterior ?? data?.parcial ?? 0
    );
    drawFittedText(vendedor[0], boxes.vendedor, {
      color: "#0b2f8f",
      align: "center",
      horizontalPadding: 0.05,
      sizeSteps: [
        Math.round(canvas.height * 0.054),
        Math.round(canvas.height * 0.049),
        Math.round(canvas.height * 0.044),
      ],
      textVariants: vendedor,
    });
    drawFittedText(saldoAte, boxes.saldoAte, {
      maxSize: Math.round(canvas.height * 0.05),
      minSize: Math.round(canvas.height * 0.022),
      color: "#0b2f8f",
      align: "left",
      horizontalPadding: 0.028,
      nudgeUnitsX: 4,
    });
    drawFittedText(saldo, boxes.saldo, {
      maxSize: Math.round(canvas.height * 0.11),
      minSize: Math.round(canvas.height * 0.038),
      color: "#000000",
      align: "left",
      horizontalPadding: 0.03,
      nudgeUnitsX: 4,
      nudgeUnitsY: 0,
    });
    return canvas.toDataURL("image/png");
  };

  const generateGerenteImageClean = async (gerente) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Dimensões fixas para layout clean
    const width = 800;
    const height = 600;
    const margin = 60; // Aumentado de 40 para 60 para dar mais espaço ao título
    const headerHeight = 80;
    const rowHeight = 50;

    canvas.width = width;
    canvas.height = height;

    // Fundo branco
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Bordas
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);

    const toNum = (s) => {
      if (!s && s !== 0) return 0;
      const clean = String(s)
        .replace(/\s+/g, "")
        .replace(/\./g, "")
        .replace(/,/, ".");
      const signFixed = clean.replace(/-\s+/, "-");
      const n = parseFloat(signFixed.replace(/[^\d.-]/g, ""));
      return isNaN(n) ? 0 : n;
    };

    const fmt = (n) =>
      (n || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const totals = (gerente.cambistas || []).reduce(
      (acc, c) => {
        acc.entradas += toNum(c.entradas);
        acc.saidas += toNum(c.saidas);
        acc.comissoes += toNum(c.comissao);
        acc.lancamentos += toNum(c.lancamentos);
        acc.cartoes += toNum(c.cartoes);
        acc.qtd += Number(c.nApostas || 0);
        acc.parcial += toNum(c.parcial);
        return acc;
      },
      {
        entradas: 0,
        saidas: 0,
        comissoes: 0,
        lancamentos: 0,
        cartoes: 0,
        qtd: 0,
        parcial: 0,
      }
    );

    const parcialCalc = totals.parcial;
    const liquidoCalc = parcialCalc - totals.cartoes;
    const qtdCambistas = Array.isArray(gerente.cambistas)
      ? gerente.cambistas.length
      : 0;

    // Configuração de fonte
    const fontTitle = 'bold 24px "Montserrat", Arial, sans-serif';
    const fontHeader = 'bold 18px "Montserrat", Arial, sans-serif';
    const fontNormal = '16px "Montserrat", Arial, sans-serif';

    let currentY = margin + 20;

    // Titulo
    ctx.fillStyle = "#1a365d";
    ctx.font = fontTitle;
    ctx.textAlign = "center";
    ctx.fillText("RELATORIO DE AREA", width / 2, currentY);
    currentY += 40;

    // Nome da area
    ctx.fillStyle = "#2d3748";
    ctx.font = fontHeader;
    ctx.fillText(gerente.nome || "Área", width / 2, currentY);
    currentY += 30;

    // Período
    ctx.fillStyle = "#4a5568";
    ctx.font = fontNormal;
    ctx.fillText(
      `Período: ${gerente.periodo || "Não informado"}`,
      width / 2,
      currentY
    );
    currentY += 40;

    // Linha separadora
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin + 20, currentY);
    ctx.lineTo(width - margin - 20, currentY);
    ctx.stroke();
    currentY += 20;

    // Quantidade de cambistas
    ctx.fillStyle = "#2d3748";
    ctx.font = fontNormal;
    ctx.textAlign = "left";
    ctx.fillText(
      `Quantidade de Cambistas: ${qtdCambistas}`,
      margin + 20,
      currentY
    );
    currentY += 40;

    // Linha separadora
    ctx.beginPath();
    ctx.moveTo(margin + 20, currentY);
    ctx.lineTo(width - margin - 20, currentY);
    ctx.stroke();
    currentY += 20;

    // Tabela de valores - Nova ordem conforme solicitado
    const tableData = [
      {
        label: "Apurado:",
        value: fmt(totals.entradas),
        color: "#38a169",
      },
      { label: "Comissões:", value: fmt(totals.comissoes), color: "#e53e3e" },
      { label: "Prêmios:", value: fmt(totals.saidas), color: "#e53e3e" },
      {
        label: "Total:",
        value: fmt(parcialCalc),
        color: parcialCalc >= 0 ? "#38a169" : "#e53e3e",
      },
      {
        label: "Lançamentos:",
        value: fmt(totals.lancamentos),
        color: "#38a169",
      },
      {
        label: "Saldo:",
        value: fmt(liquidoCalc),
        color: liquidoCalc >= 0 ? "#38a169" : "#e53e3e",
      },
    ];

    tableData.forEach((item) => {
      // Label
      ctx.fillStyle = "#4a5568";
      ctx.font = fontNormal;
      ctx.textAlign = "left";
      ctx.fillText(item.label, margin + 20, currentY);

      // Value
      ctx.fillStyle = item.color;
      ctx.textAlign = "right";
      ctx.fillText(`R$ ${item.value}`, width - margin - 20, currentY);

      currentY += rowHeight;
    });

    return canvas.toDataURL("image/png");
  };

  const generateGerenteImage = async (gerente) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = await loadImage(arteGerenteSrc, "gerente");

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const toNum = (s) => {
      if (!s && s !== 0) return 0;
      const clean = String(s)
        .replace(/\s+/g, "")
        .replace(/\./g, "")
        .replace(/,/, ".");
      const signFixed = clean.replace(/-\s+/, "-");
      const n = parseFloat(signFixed.replace(/[^\d.-]/g, ""));
      return isNaN(n) ? 0 : n;
    };
    const fmt = (n) =>
      (n || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const totals = (gerente.cambistas || []).reduce(
      (acc, c) => {
        acc.entradas += toNum(c.entradas);
        acc.saidas += toNum(c.saidas);
        acc.comissoes += toNum(c.comissao);
        acc.lancamentos += toNum(c.lancamentos);
        acc.cartoes += toNum(c.cartoes);
        acc.qtd += Number(c.nApostas || 0);
        acc.parcial += toNum(c.parcial); // sum of each cambista's parcial (total + lancamentos)
        return acc;
      },
      {
        entradas: 0,
        saidas: 0,
        comissoes: 0,
        lancamentos: 0,
        cartoes: 0,
        qtd: 0,
        parcial: 0,
      }
    );

    const parcialCalc = totals.parcial; // use the sum of cambistas' parcial
    const liquidoCalc = parcialCalc - totals.cartoes; // adjust if needed
    const qtdCambistas = Array.isArray(gerente.cambistas)
      ? gerente.cambistas.length
      : 0;

    const base = Math.max(canvas.width, canvas.height);
    const fontSm = Math.round(base * 0.03);
    const fontMd = Math.round(base * 0.038);
    const fontLg = Math.round(base * 0.065);

    const POS = {
      supervisor: [0.14, 0.155],
      data: [0.195, 0.285],
      qtd_cambistas: [0.8675, 0.28],
      entradas: [0.3725, 0.44],
      comissoes: [0.795, 0.44],
      saidas: [0.38, 0.57],
      qtd_apostas: [0.8125, 0.57],
      lancamentos: [0.4075, 0.7],
      saldo_final: [0.79, 0.695],
      saldo_enviar: [0.525, 0.84],
    };

    const point = (key) => {
      const [px, py] = POS[key] || [0.5, 0.5];
      return {
        x: Math.round(px * canvas.width),
        y: Math.round(py * canvas.height),
      };
    };

    const draw = (text, key, options = {}) => {
      const { align = "left", size = fontMd, color = "#000" } = options;
      const p = point(key);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.font = `900 ${size}px "Montserrat", Arial, sans-serif`;
      ctx.fillText(String(text || ""), p.x, p.y);
    };

    draw(gerente.nome || "Supervisor", "supervisor", {
      size: Math.round(fontMd * 0.9),
    });
    draw(gerente.periodo || "", "data", { size: Math.round(fontSm * 0.9) });
    draw(String(qtdCambistas), "qtd_cambistas", {
      align: "center",
      size: Math.round(fontSm * 0.9),
    });
    draw(fmt(totals.entradas), "entradas", { align: "center" });
    draw(fmt(totals.comissoes), "comissoes", { align: "center" });
    draw(fmt(totals.saidas), "saidas", { align: "center" });
    draw(String(totals.qtd || 0), "qtd_apostas", { align: "center" });
    draw(fmt(totals.lancamentos), "lancamentos", { align: "center" });
    draw(fmt(parcialCalc), "saldo_final", { align: "center" });
    draw(fmt(liquidoCalc), "saldo_enviar", {
      align: "center",
      size: fontLg,
      color: liquidoCalc >= 0 ? "#00AA00" : "#CC0000",
    });

    return canvas.toDataURL("image/png");
  };

  const generateResumoImage = async (gerente) => {
    const rows = Array.isArray(gerente?.cambistas) ? gerente.cambistas : [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const width = 1400;
    const margin = 60;
    const blockHeaderHeight = 110;
    const tableHeaderHeight = 56;
    const rowHeight = 54;
    const totalRows = rows.length + 1;
    canvas.width = width;
    canvas.height =
      margin * 2 +
      blockHeaderHeight +
      tableHeaderHeight +
      rowHeight * Math.max(totalRows, 1);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const headerX = margin;
    const headerWidth = width - margin * 2;

    ctx.fillStyle = "#050505";
    ctx.fillRect(headerX, margin, headerWidth, 60);
    ctx.fillStyle = "#ffffff";
    ctx.font = '700 30px "Montserrat", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${gerente?.nome || "Gerente"} / Comissão R$ ${
        gerente?.comissao || "0,00"
      }`,
      headerX + headerWidth / 2,
      margin + 30
    );

    ctx.fillStyle = "#111111";
    ctx.fillRect(headerX, margin + 60, headerWidth, 40);
    ctx.fillStyle = "#ffffff";
    ctx.font = '600 24px "Montserrat", Arial, sans-serif';
    ctx.fillText(
      `Período: ${gerente?.periodo || "Não informado"}`,
      headerX + headerWidth / 2,
      margin + 80
    );

    const numericFields = [
      "entradas",
      "comissao",
      "saidas",
      "liquido",
      "lancamentos",
      "parcial",
    ];

    const totals = {
      nApostas: 0,
      entradas: 0,
      comissao: 0,
      saidas: 0,
      liquido: 0,
      lancamentos: 0,
      parcial: 0,
    };

    const preparedRows = rows.map((c) => {
      totals.nApostas += Number(c?.nApostas || 0);
      const prepared = {
        nome: c?.nome || "",
        nApostas: String(c?.nApostas || "0"),
      };
      numericFields.forEach((field) => {
        const num = toNumber(c?.[field]);
        totals[field] += num;
        prepared[field] = {
          raw: num,
          text: toCurrency(num),
        };
      });
      return prepared;
    });

    const totalRow = {
      nome: "Total",
      nApostas: String(totals.nApostas || 0),
    };
    numericFields.forEach((field) => {
      totalRow[field] = {
        raw: totals[field],
        text: toCurrency(totals[field]),
      };
    });

    const tableRows = [...preparedRows, totalRow];

    const columns = [
      { key: "nome", label: "Usuário", ratio: 0.23, align: "left" },
      { key: "nApostas", label: "Nº apostas", ratio: 0.07, align: "center" },
      { key: "entradas", label: "Apurado", ratio: 0.1, align: "center" },
      { key: "comissao", label: "Comissão", ratio: 0.1, align: "center" },
      { key: "saidas", label: "Prêmios", ratio: 0.09, align: "center" },
      { key: "liquido", label: "Líquido", ratio: 0.09, align: "center" },
      {
        key: "lancamentos",
        label: "Lançamentos",
        ratio: 0.09,
        align: "center",
      },
      { key: "parcial", label: "Total", ratio: 0.1, align: "center" },
    ];

    const colPositions = [];
    let cursorX = headerX;
    columns.forEach((col) => {
      const widthCol = headerWidth * col.ratio;
      colPositions.push({
        ...col,
        x: cursorX,
        width: widthCol,
      });
      cursorX += widthCol;
    });

    let currentY = margin + blockHeaderHeight;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(headerX, currentY, headerWidth, tableHeaderHeight);
    ctx.fillStyle = "#ffffff";
    ctx.font = '700 20px "Montserrat", Arial, sans-serif';
    ctx.textBaseline = "middle";
    colPositions.forEach((col) => {
      const anchor =
        col.align === "center"
          ? col.x + col.width / 2
          : col.align === "right"
          ? col.x + col.width - 12
          : col.x + 12;
      ctx.textAlign =
        col.align === "right"
          ? "right"
          : col.align === "center"
          ? "center"
          : "left";
      ctx.fillText(col.label, anchor, currentY + tableHeaderHeight / 2);
    });

    currentY += tableHeaderHeight;
    ctx.font = '600 20px "Montserrat", Arial, sans-serif';
    ctx.textAlign = "left";

    const resolveColor = (key, rawValue, isTotal) => {
      if (key === "nome" || key === "nApostas") {
        return isTotal ? "#000000" : "#111111";
      }
      const basePositive = "#0f8f2c";
      const baseNegative = "#c00000";
      switch (key) {
        case "entradas":
        case "liquido":
        case "lancamentos":
        case "parcial":
          return rawValue >= 0 ? basePositive : baseNegative;
        case "comissao":
        case "saidas":
          return baseNegative;
        default:
          return isTotal ? "#000000" : "#111111";
      }
    };

    tableRows.forEach((row, index) => {
      const isTotal = index === tableRows.length - 1;
      ctx.fillStyle = isTotal
        ? "#d1d5db"
        : index % 2 === 0
        ? "#f8fafc"
        : "#eef2ff";
      ctx.fillRect(headerX, currentY, headerWidth, rowHeight);

      colPositions.forEach((col) => {
        const anchor =
          col.align === "center"
            ? col.x + col.width / 2
            : col.align === "right"
            ? col.x + col.width - 14
            : col.x + 14;
        ctx.textAlign =
          col.align === "right"
            ? "right"
            : col.align === "center"
            ? "center"
            : "left";
        ctx.fillStyle = resolveColor(col.key, row[col.key]?.raw ?? 0, isTotal);
        ctx.font = `${
          isTotal ? "700" : "600"
        } 20px "Montserrat", Arial, sans-serif`;
        const value =
          typeof row[col.key] === "object" && row[col.key] !== null
            ? row[col.key].text
            : row[col.key] || "";
        ctx.fillText(value, anchor, currentY + rowHeight / 2);
      });

      currentY += rowHeight;
    });

    return canvas.toDataURL("image/png");
  };

  const downloadAllImages = async () => {
    if (!processedData) return;

    setProcessing(true);

    try {
      const zip = new JSZip();

      const normalizePart = (value, fallback) => {
        const base = String(value || fallback || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[\/:*?"<>|]+/g, " ")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_");
        return base.length ? base.slice(0, 40) : fallback;
      };

      for (let index = 0; index < processedData.length; index++) {
        const gerente = processedData[index];
        // Usar o nome da área para o nome da pasta
        const areaNome = gerente?.area || gerente?.nome || `area_${index + 1}`;
        const folderSlug = normalizePart(areaNome, `area_${index + 1}`);
        const gerenteFolder =
          zip.folder(folderSlug) || zip.folder(`area_${index + 1}`);

        if (!gerenteFolder) {
          continue;
        }

        const gerenteImg = await generateGerenteImageClean(gerente);
        gerenteFolder.file("gerente.png", gerenteImg.split(",")[1], {
          base64: true,
        });

        const resumoImg = await generateResumoImage(gerente);
        gerenteFolder.file("resumo.png", resumoImg.split(",")[1], {
          base64: true,
        });

        await new Promise((resolve) => setTimeout(resolve, 100));

        for (const cambista of gerente.cambistas) {
          const saldoAnteriorAtual =
            cambista?.saldoAnteriorNumero ??
            cambista?.saldoAnterior ??
            cambista?.parcial ??
            0;

          if (isNearZero(saldoAnteriorAtual)) {
            continue;
          }

          const cambistaImg = await generateCambistaImage({
            ...cambista,
            periodo: gerente.periodo,
          });

          const cambistaFile = `${normalizePart(
            cambista?.nome,
            "cambista"
          )}.png`;
          gerenteFolder.file(cambistaFile, cambistaImg.split(",")[1], {
            base64: true,
          });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "relatorios_monaco.zip";
      link.click();

      alert("Arquivo ZIP baixado com sucesso!");
    } catch (err) {
      setError("Erro ao gerar imagens: " + err.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#040b2c] via-[#031a73] to-[#07104c] text-white relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_15%,rgba(244,192,65,0.16),transparent_55%)] pointer-events-none"></div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_80%,rgba(29,78,216,0.2),transparent_60%)] pointer-events-none"></div>

      <div className="relative z-10 bg-gradient-to-r from-[#081042]/95 via-[#112a9c]/95 to-[#081042]/95 backdrop-blur-sm py-12 px-6 shadow-2xl border-b border-[#f4c041]/30">
        <div className="max-w-6xl mx-auto text-center">
          <div className="flex flex-col items-center justify-center gap-6 mb-6">
            <div className="relative">
              <img
                src="/logo_monaco.jpeg"
                alt="Monaco Loterias Logo"
                className="w-64 h-64 object-contain drop-shadow-2xl"
              />
              <div className="absolute -inset-3 bg-gradient-to-r from-[#f5d06c]/40 to-[#1c3ed6]/40 rounded-full blur-lg -z-10"></div>
            </div>
          </div>
          <p className="text-xl text-blue-100 max-w-2xl mx-auto leading-relaxed">
            Gerador de relatórios
          </p>
        </div>
      </div>

      <div className="relative z-10 max-w-6xl mx-auto p-8 space-y-6">
        <div className="bg-white/5 backdrop-blur-xl rounded-2xl p-6 border border-white/10 shadow-2xl">
          <label className="block text-sm font-semibold text-[#ffe8a0] uppercase tracking-widest mb-2">
            Periodo do relatorio
          </label>
          <input
            type="text"
            value={periodoManual}
            onChange={(event) => setPeriodoManual(event.target.value)}
            placeholder="Ex.: 10/11/2025 à 16/11/2025"
            className="w-full bg-white/90 text-[#0b1e6d] rounded-xl px-4 py-3 font-semibold focus:outline-none focus:ring-2 focus:ring-[#f4c041]"
          />
          <p className="text-blue-100/70 text-sm mt-2">
            Em PDF a data de fechamento e lida automaticamente. Em Excel/CSV,
            preencha o periodo manualmente.
          </p>
        </div>

        {!processedData && (
          <div className="bg-white/5 backdrop-blur-xl rounded-2xl p-12 border border-white/10 shadow-2xl hover:shadow-yellow-500/10 transition-all duration-500 hover:border-[#f4c041]/40">
            <div className="text-center">
              <div className="relative mb-8">
                <div className="w-24 h-24 bg-gradient-to-br from-[#ffe28a] to-[#f3b73d] rounded-full flex items-center justify-center mx-auto shadow-lg">
                  <Upload className="w-12 h-12 text-white" />
                </div>
                <div className="absolute -top-2 -right-2 w-8 h-8 bg-[#f4c041] text-[#031046] rounded-full flex items-center justify-center font-black animate-bounce">
                  <span className="text-xs">ARQ</span>
                </div>
              </div>

              <h2 className="text-3xl font-bold mb-4 bg-gradient-to-r from-white to-[#ffe8ab] bg-clip-text text-transparent">
                Envie o relatório semanal
              </h2>
              <p className="text-blue-100/80 mb-8 text-lg max-w-md mx-auto leading-relaxed">
                Arraste ou clique para selecionar o relatório exportado da
                plataforma Monaco
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.pdf"
                onChange={handleFileUpload}
                className="hidden"
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={processing}
                className="bg-gradient-to-r from-[#ffe289] to-[#f0b432] text-[#041043] font-bold py-4 px-10 rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 mx-auto shadow-lg hover:shadow-yellow-500/40 transform hover:scale-105"
              >
                {processing ? (
                  <>
                    <Loader className="animate-spin w-6 h-6" />
                    <span className="text-lg">Processando relatório...</span>
                  </>
                ) : (
                  <>
                    <FileText className="w-6 h-6" />
                    <span className="text-lg">Selecionar relatório</span>
                  </>
                )}
              </button>

              {file && (
                <div className="mt-8 p-4 bg-[#f4c041]/15 border border-[#f4c041]/30 rounded-xl backdrop-blur-sm">
                  <p className="text-[#fcd977] flex items-center justify-center gap-3 text-lg">
                    <CheckCircle className="w-6 h-6" />
                    <span className="font-medium">{file.name}</span>
                  </p>
                </div>
              )}

              {error && (
                <div className="mt-8 p-4 bg-red-500/15 border border-red-500/30 rounded-xl backdrop-blur-sm">
                  <p className="text-red-200 text-lg">{error}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {processedData && (
          <div className="space-y-8">
            <div className="bg-gradient-to-r from-[#071c68]/80 to-[#0b2c90]/80 backdrop-blur-xl rounded-2xl p-8 border border-[#f4c041]/30 shadow-2xl">
              <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
                <div className="text-center lg:text-left">
                  <h2 className="text-3xl font-bold mb-3 flex items-center gap-3 justify-center lg:justify-start">
                    <div className="w-10 h-10 bg-[#f4c041] rounded-full flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-[#071251]" />
                    </div>
                    <span className="bg-gradient-to-r from-white to-[#ffe08c] bg-clip-text text-transparent">
                      Relatório processado com sucesso!
                    </span>
                  </h2>
                  <p className="text-blue-50 text-lg">
                    <span className="font-semibold text-[#f6d36f]">
                      {processedData.length}
                    </span>{" "}
                    áreas encontradas &bull;{" "}
                    <span className="font-semibold text-[#f6d36f]">
                      {processedData.reduce(
                        (sum, g) =>
                          sum +
                          (Array.isArray(g.cambistas) ? g.cambistas.length : 0),
                        0
                      )}
                    </span>{" "}
                    cambistas
                  </p>
                </div>
                <button
                  onClick={downloadAllImages}
                  disabled={processing}
                  className="bg-gradient-to-r from-[#ffe186] to-[#f1b02d] text-[#041043] font-bold py-4 px-8 rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 shadow-lg hover:shadow-yellow-500/40 transform hover:scale-105"
                >
                  {processing ? (
                    <>
                      <Loader className="animate-spin w-6 h-6" />
                      <span className="text-lg">Gerando Artes...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-6 h-6" />
                      <span className="text-lg">Baixar ZIP</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="bg-white/5 backdrop-blur-xl rounded-2xl p-6 border border-white/10 shadow-2xl">
              <h3 className="text-xl font-bold text-[#ffe8a0] mb-4 uppercase tracking-wide">
                Áreas encontradas
              </h3>
              <div className="divide-y divide-white/10">
                {processedData.map((gerente, idx) => (
                  <div
                    key={`resumo-${idx}`}
                    className="flex items-center justify-between py-3"
                  >
                    <span className="text-blue-100 font-medium">
                      {gerente && gerente.nome
                        ? gerente.nome
                        : `Gerente ${idx + 1}`}
                    </span>
                    <span className="text-[#f6d36f] font-semibold">
                      {Array.isArray(gerente?.cambistas)
                        ? gerente.cambistas.length
                        : 0}{" "}
                      cambistas
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center">
              <button
                onClick={() => {
                  setProcessedData(null);
                  setFile(null);
                  setError(null);
                }}
                className="bg-gradient-to-r from-[#122178] to-[#1a2fa7] hover:from-[#0e1960] hover:to-[#1f37c1] text-white font-bold py-4 px-12 rounded-xl transition-all duration-300 shadow-lg hover:shadow-blue-900/40 transform hover:scale-105"
              >
                Processar novo relatório
              </button>
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default App;

