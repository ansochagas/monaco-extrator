import React, { useState, useRef } from "react";
import { Upload, Download, FileText, CheckCircle, Loader } from "lucide-react";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import arteColaboradorSrc from "./assets/arte_colaborador_monaco.png";
import arteGerenteSrc from "./assets/arte_gerente_red.png";

const normalizeCell = (value) => (value ?? "").toString().trim();

const normalizeComparable = (value) =>
  normalizeCell(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

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
  const normalized = value
    .toString()
    .replace(/\s+/g, "")
    .replace(/\./g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toCurrency = (value) =>
  toNumber(value).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

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

  // Mapeamento de colunas detectado dinamicamente (com fallback nas posições padrão)
  // Assume fixed column positions (0-based)
  // 0: empty, 1: area, 2: VENDEDOR, 3: APURADO, 4: COMISSÃO, 5: old_liquido, 6: PRÊMIOS, 7: TOTAL, 8: tpremios, 9: fpremio, 10: LANÇAMENTOS
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
    const allowedExtensions = [".xlsx", ".xls", ".csv"];

    if (!uploadedFile) {
      setError("Selecione um arquivo de relatório");
      return;
    }

    const fileName = (uploadedFile.name || "").toLowerCase();
    if (!allowedExtensions.some((ext) => fileName.endsWith(ext))) {
      setError("Envie um arquivo Excel válido (.xlsx ou .xls)");
      return;
    }

    if (!periodoManual.trim()) {
      setError("Informe o período do relatório antes de prosseguir");
      return;
    }

    setFile(uploadedFile);
    setError(null);
    setProcessing(true);

    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) {
        throw new Error("Planilha sem abas válidas");
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

      const parsedData = parseExcelData(rows, periodoManual.trim());
      if (!parsedData.length) {
        throw new Error("Nenhuma gerência identificada. Verifique o arquivo.");
      }

      setProcessedData(parsedData);
    } catch (err) {
      setError("Erro ao processar Excel: " + err.message);
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

    const img = await loadImage(arteColaboradorSrc, "cambista");

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const valores = {
      apurado: toCurrency(data.entradas),
      comissao: toCurrency(data.comissao),
      premios: toCurrency(data.saidas),
      liquido: toCurrency(data.liquido),
      lancamentos: toCurrency(data.lancamentos),
      total: toCurrency(data.parcial || data.liquido),
    };

    const base = Math.max(canvas.width, canvas.height);
    const fontSm = Math.round(base * 0.032);
    const fontMd = Math.round(base * 0.04);
    const fontLg = Math.round(base * 0.058);
    const UNIT_Y = Math.round(fontMd * 0.35);
    const UNIT_X = Math.round(fontMd * 0.4);

    const POS = {
      periodo: [0.62, 0.23],
      vendedor: [0.6, 0.355],
      apurado: [0.77, 0.47],
      comissao: [0.77, 0.535],
      premios: [0.77, 0.6],
      liquido: [0.77, 0.665],
      lancamentos: [0.77, 0.755],
      total: [0.77, 0.84],
    };

    const OFFSET_MAP = {
      periodo: { x: -13, y: 4.5 },
      vendedor: { x: -3, y: 3 },
      apurado: { x: 0, y: 1 },
      comissao: { x: 0, y: 2 },
      premios: { x: 0, y: 3 },
      liquido: { x: 0, y: 4 },
      lancamentos: { x: 0, y: 3 },
      total: { x: 0, y: 3 },
    };

    const point = (key) => {
      const [px, py] = POS[key] || [0.5, 0.5];
      const offset = OFFSET_MAP[key] || { x: 0, y: 0 };
      return {
        x: Math.round(px * canvas.width + offset.x * UNIT_X),
        y: Math.round(py * canvas.height + offset.y * UNIT_Y),
      };
    };

    const draw = (text, key, options = {}) => {
      const { align = "left", size = fontMd, color = "#041046" } = options;
      const p = point(key);
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.font = `900 ${size}px "Montserrat", Arial, sans-serif`;
      ctx.fillText(String(text || ""), p.x, p.y);
    };

    draw(data.periodo || "-", "periodo", {
      align: "left",
      size: Math.round(fontSm * 0.95),
      color: "#ffffff",
    });

    // Renderização inteligente do nome do vendedor para evitar overflow
    const renderVendedorName = (name) => {
      const upperName = (name || "Vendedor").toUpperCase();
      const length = upperName.length;

      // Ajuste dinâmico do tamanho da fonte baseado no comprimento
      let fontSize = fontLg;
      if (length > 15) fontSize = Math.round(fontLg * 0.85); // ~49px
      if (length > 20) fontSize = Math.round(fontLg * 0.75); // ~43px
      if (length > 25) fontSize = Math.round(fontLg * 0.7); // ~40px

      // Se ainda for muito longo, quebrar em 2 linhas
      if (length > 30) {
        const words = upperName.split(" ");
        if (words.length >= 3) {
          const midPoint = Math.ceil(words.length / 2);
          const line1 = words.slice(0, midPoint).join(" ");
          const line2 = words.slice(midPoint).join(" ");

          // Desenhar primeira linha
          draw(line1, "vendedor", {
            align: "left",
            size: Math.round(fontSize * 0.9),
            color: "#041046",
          });

          // Desenhar segunda linha (ligeiramente abaixo)
          const pos = point("vendedor");
          ctx.fillStyle = "#041046";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.font = `900 ${Math.round(
            fontSize * 0.9
          )}px "Montserrat", Arial, sans-serif`;
          ctx.fillText(line2, pos.x, pos.y + Math.round(fontSize * 0.6));

          return;
        }
      }

      // Renderização normal com fonte ajustada
      draw(upperName, "vendedor", {
        align: "left",
        size: fontSize,
        color: "#041046",
      });
    };

    renderVendedorName(data.nome);

    const drawValor = (value, key, opts = {}) =>
      draw(value, key, { align: "center", size: fontMd, ...opts });

    drawValor(valores.apurado, "apurado");
    drawValor(valores.comissao, "comissao");
    drawValor(valores.premios, "premios");
    drawValor(valores.liquido, "liquido");
    drawValor(valores.lancamentos, "lancamentos");
    drawValor(valores.total, "total", { size: Math.round(fontLg * 0.8) });

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

    // Título
    ctx.fillStyle = "#1a365d";
    ctx.font = fontTitle;
    ctx.textAlign = "center";
    ctx.fillText("RELATÓRIO DE ÁREA", width / 2, currentY);
    currentY += 40;

    // Nome da área
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
            Período do relatório
          </label>
          <input
            type="text"
            value={periodoManual}
            onChange={(event) => setPeriodoManual(event.target.value)}
            placeholder="Ex.: 10/11/2025 à 16/11/2025"
            className="w-full bg-white/90 text-[#0b1e6d] rounded-xl px-4 py-3 font-semibold focus:outline-none focus:ring-2 focus:ring-[#f4c041]"
          />
          <p className="text-blue-100/70 text-sm mt-2">
            Esse período será exibido nas artes e no resumo de cada gerente.
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
                  <span className="text-xs">Excel</span>
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
                accept=".xlsx,.xls,.csv"
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
