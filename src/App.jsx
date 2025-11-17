import React, { useState, useRef } from "react";
import { Upload, Download, FileText, CheckCircle, Loader } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import JSZip from "jszip";
import arteColaboradorSrc from "./assets/arte_colaborador.png";
import arteGerenteSrc from "./assets/arte_gerente_red.png";

// Set PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

const isDebugLoggingEnabled = () => {
  if (import.meta?.env?.VITE_ENABLE_DEBUG === "1") {
    return true;
  }
  if (typeof window !== "undefined") {
    try {
      return localStorage.getItem("fortbet_debug_logs") === "1";
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
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);

  const parsePDFText = (text) => parsePDFTextStable(text);
  const handleFileUpload = async (e) => {
    const uploadedFile = e.target.files[0];
    if (!uploadedFile || uploadedFile.type !== "application/pdf") {
      setError("Por favor, selecione um arquivo PDF v\u00E1lido");
      return;
    }

    setFile(uploadedFile);
    setError(null);
    setProcessing(true);

    try {
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let text = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        text += textContent.items.map((item) => item.str).join(" ") + "\n";
      }

      if (DEBUG_LOGS) {
        console.log("Texto extraÃ­do:", text);
        console.log(
          "Texto limpo:",
          text.replace(/\n/g, " ").replace(/\s+/g, " ")
        );
      }

      const parsedData = parsePDFText(text);

      if (DEBUG_LOGS) {
        console.log("Dados parseados:", parsedData);
        console.log("NÃƒÂºmero de gerentes encontrados:", parsedData.length);
      }

      if (parsedData.length === 0) {
        if (DEBUG_LOGS) {
          console.error("DEBUG: Nenhum gerente encontrado");
          console.log("Texto completo para anÃƒÂ¡lise:", text);
        }
        throw new Error("Nenhum dado encontrado no PDF");
      }

      setProcessedData(parsedData);
    } catch (err) {
      setError("Erro ao processar PDF: " + err.message);
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

  // Gera imagem de cambista com PNG de fundo no tamanho nativo
  const generateCambistaImage = async (data, gerenteName = "") => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const img = await loadImage(arteColaboradorSrc, "cambista");

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const toNum = (s) => {
      if (!s && s !== 0) return 0;
      const clean = String(s).replace(/\s+/g, "").replace(/\./g, "").replace(/,/, ".");
      const signFixed = clean.replace(/-\s+/, "-");
      const n = parseFloat(signFixed.replace(/[^\d.-]/g, ""));
      return isNaN(n) ? 0 : n;
    };
    const fmt = (n) => (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const entradasN = toNum(data.entradas);
    const saidasN = toNum(data.saidas);
    const comissaoN = toNum(data.comissao);
    const cartoesN = toNum(data.cartoes);
    const lancN = toNum(data.lancamentos);
    const parcialCalc = entradasN - saidasN - comissaoN;
    const liquidoCalc = parcialCalc + lancN - cartoesN;
    const parcialInfo = toNum(data.parcial);
    const liquidoInfo = toNum(data.liquido);
    if (Math.abs(parcialCalc - parcialInfo) > 0.01 || Math.abs(liquidoCalc - liquidoInfo) > 0.01) {
      if (DEBUG_LOGS) {
        console.warn("[FORTBET] DivergÃƒÂªncia detectada", {
          cambista: data.nome,
          periodo: data.periodo,
          parcial_informado: data.parcial,
          parcial_calculado: fmt(parcialCalc),
          liquido_informado: data.liquido,
          liquido_calculado: fmt(liquidoCalc),
        });
      }
    }

    const base = Math.max(canvas.width, canvas.height);
    const fontSm = Math.round(base * 0.030);
    const fontMd = Math.round(base * 0.038);
    const fontLg = Math.round(base * 0.065);

    // Posições aproximadas da nova arte (percentuais X,Y)
    const defaultPos = {
      colaborador: [0.3275, 0.165],
      data: [0.5275, 0.2825],
      entradas: [0.3825, 0.44],
      comissoes: [0.75, 0.44],
      saidas: [0.38, 0.57],
      qtd_apostas: [0.7525, 0.57],
      lancamentos: [0.385, 0.70],
      saldo_final: [0.7525, 0.70],
      saldo_enviar: [0.525, 0.8375],
    };
    const POS = defaultPos;
    const pos = (key) => {
      const [px, py] = POS[key] || [0.5, 0.5];
      return { x: Math.round(px * canvas.width), y: Math.round(py * canvas.height) };
    };

    const draw = (text, p, align = "left", size = fontMd, color = "#000") => {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.font = `900 ${size}px "Montserrat", Arial, sans-serif`;
      ctx.fillText(text, p.x, p.y);
    };

    // Campos (centralizados nas caixas)
    draw(data.nome, pos("colaborador"), "center", fontMd, "#000");
    draw(data.periodo || "", pos("data"), "center", fontSm, "#000");

    draw(fmt(entradasN), pos("entradas"), "center");
    draw(fmt(comissaoN), pos("comissoes"), "center");
    draw(String(data.nApostas || "0"), pos("qtd_apostas"), "center");
    draw(fmt(saidasN), pos("saidas"), "center");
    draw(fmt(parcialCalc), pos("saldo_final"), "center");
    draw(fmt(lancN), pos("lancamentos"), "center");

    const isPos = liquidoCalc >= 0;
    draw(fmt(liquidoCalc), pos("saldo_enviar"), "center", fontLg, isPos ? "#00AA00" : "#CC0000");

    return canvas.toDataURL("image/png");
  };

  // Gera imagem de gerente com PNG de fundo no tamanho nativo
  const generateGerenteImage = async (gerente) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const img = await loadImage(arteGerenteSrc, "gerente");

    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const toNum = (s) => {
      if (!s && s !== 0) return 0;
      const clean = String(s).replace(/\s+/g, "").replace(/\./g, "").replace(/,/, ".");
      const signFixed = clean.replace(/-\s+/, "-");
      const n = parseFloat(signFixed.replace(/[^\d.-]/g, ""));
      return isNaN(n) ? 0 : n;
    };
    const fmt = (n) => (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const totals = (gerente.cambistas || []).reduce(
      (acc, c) => {
        acc.entradas += toNum(c.entradas);
        acc.saidas += toNum(c.saidas);
        acc.comissoes += toNum(c.comissao);
        acc.lancamentos += toNum(c.lancamentos);
        acc.cartoes += toNum(c.cartoes);
        acc.qtd += Number(c.nApostas || 0);
        return acc;
      },
      {
        entradas: 0,
        saidas: 0,
        comissoes: 0,
        lancamentos: 0,
        cartoes: 0,
        qtd: 0,
      }
    );

    const parcialCalc = totals.entradas - totals.saidas - totals.comissoes;
    const liquidoCalc = parcialCalc + totals.lancamentos - totals.cartoes;
    const qtdCambistas = Array.isArray(gerente.cambistas)
      ? gerente.cambistas.length
      : 0;

    const base = Math.max(canvas.width, canvas.height);
    const fontSm = Math.round(base * 0.030);
    const fontMd = Math.round(base * 0.038);
    const fontLg = Math.round(base * 0.065);

    const defaultPosG = {
      supervisor: [0.1775, 0.155],
      data: [0.195, 0.285],
      qtd_cambistas: [0.8675, 0.28],
      entradas: [0.3725, 0.44],
      comissoes: [0.795, 0.44],
      saidas: [0.38, 0.57],
      qtd_apostas: [0.8125, 0.57],
      lancamentos: [0.4075, 0.70],
      saldo_final: [0.79, 0.695],
      saldo_enviar: [0.525, 0.84],
    };
    const POSG = defaultPosG;
    const posG = (key) => {
      const [px, py] = POSG[key] || [0.5, 0.5];
      return { x: Math.round(px * canvas.width), y: Math.round(py * canvas.height) };
    };

    const draw = (text, p, align = "left", size = fontMd, color = "#000") => {
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.font = `900 ${size}px "Montserrat", Arial, sans-serif`;
      ctx.fillText(text, p.x, p.y);
    };

    draw(gerente.nome || "Supervisor", posG("supervisor"), "left", Math.round(fontMd * 0.9), "#000");
    draw(gerente.periodo || "", posG("data"), "left", Math.round(fontSm * 0.9), "#000");
    draw(String(qtdCambistas), posG("qtd_cambistas"), "center", Math.round(fontSm * 0.9), "#000");
    draw(fmt(totals.entradas), posG("entradas"), "center");
    draw(fmt(totals.comissoes), posG("comissoes"), "center");
    draw(fmt(totals.saidas), posG("saidas"), "center");
    draw(String(totals.qtd || 0), posG("qtd_apostas"), "center");
    draw(fmt(totals.lancamentos), posG("lancamentos"), "center");
    draw(fmt(parcialCalc), posG("saldo_final"), "center");

    const isPos = liquidoCalc >= 0;
    draw(fmt(liquidoCalc), posG("saldo_enviar"), "center", fontLg, isPos ? "#00AA00" : "#CC0000");

    if (localStorage.getItem("fortbet_debug_overlay") === "1") {
      ctx.strokeStyle = "#00FF00";
      ctx.lineWidth = 2;
      Object.keys(POSG).forEach((k) => {
        const p = posG(k);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.round(base * 0.004), 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = `900 ${fontSm}px "Montserrat", Arial, sans-serif`;
        ctx.fillStyle = "#00FF00";
        ctx.fillText(k, p.x + 6, p.y - 10);
      });
    }

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
        const folderSlug = normalizePart(gerente?.nome, `gerente_${index + 1}`);
        const gerenteFolder =
          zip.folder(folderSlug) || zip.folder(`gerente_${index + 1}`);

        if (!gerenteFolder) {
          continue;
        }

        const gerenteImg = await generateGerenteImage(gerente);
        gerenteFolder.file("gerente.png", gerenteImg.split(",")[1], { base64: true });

        await new Promise((resolve) => setTimeout(resolve, 100));

        for (const cambista of gerente.cambistas) {
          const cambistaImg = await generateCambistaImage(
            {
              ...cambista,
              periodo: gerente.periodo,
            },
            gerente.nome
          );

          const cambistaFile = `${normalizePart(cambista?.nome, "cambista")}.png`;
          gerenteFolder.file(cambistaFile, cambistaImg.split(",")[1], { base64: true });

          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "relatorios_fortbet.zip";
      link.click();

      alert("Arquivo ZIP baixado com sucesso!");
    } catch (err) {
      setError("Erro ao gerar imagens: " + err.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-900 to-black text-white relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(220,38,38,0.1),transparent_50%)] pointer-events-none"></div>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_80%,rgba(34,197,94,0.1),transparent_50%)] pointer-events-none"></div>

      {/* Header */}
      <div className="relative z-10 bg-gradient-to-r from-red-600/90 via-red-700/90 to-red-800/90 backdrop-blur-sm py-12 px-6 shadow-2xl border-b border-red-500/20">
        <div className="max-w-6xl mx-auto text-center">
          <div className="flex items-center justify-center gap-4 mb-6">
            {/* Logo da Empresa */}
            <div className="relative">
              <img
                src="/logo.jpg"
                alt="FortBet Brasil Logo"
                className="w-28 h-28 object-contain drop-shadow-lg"
              />
              <div className="absolute -inset-3 bg-gradient-to-r from-red-500/20 to-green-500/20 rounded-full blur-lg -z-10"></div>
            </div>
            <div>
              <h1 className="text-4xl font-black bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
                FORTBET
              </h1>
              <p className="text-xl font-bold text-green-400 mt-1">BRASIL</p>
            </div>
          </div>
          <p className="text-xl text-gray-300 max-w-2xl mx-auto leading-relaxed">
            Gerador de Relat&oacute;rios Personalizados
          </p>
          <div className="mt-6 flex items-center justify-center gap-2 text-sm text-gray-400">
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
            Sistema Online e Seguro
          </div>
        </div>
      </div>

      <div className="relative z-10 max-w-6xl mx-auto p-8">
        {/* Upload Section */}
        {!processedData && (
          <div className="bg-gray-900/80 backdrop-blur-xl rounded-2xl p-12 border border-gray-700/50 shadow-2xl hover:shadow-red-500/10 transition-all duration-500 hover:border-red-500/30">
            <div className="text-center">
              <div className="relative mb-8">
                <div className="w-24 h-24 bg-gradient-to-br from-red-500 to-red-700 rounded-full flex items-center justify-center mx-auto shadow-lg">
                  <Upload className="w-12 h-12 text-white" />
                </div>
                <div className="absolute -top-2 -right-2 w-8 h-8 bg-green-500 rounded-full flex items-center justify-center animate-bounce">
                  <span className="text-xs font-bold text-white">PDF</span>
                </div>
              </div>

              <h2 className="text-3xl font-bold mb-4 bg-gradient-to-r from-white to-gray-300 bg-clip-text text-transparent">
                Envie o PDF de Fechamento
              </h2>
              <p className="text-gray-400 mb-8 text-lg max-w-md mx-auto leading-relaxed">
                Arraste e solte ou clique para selecionar o arquivo PDF semanal
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileUpload}
                className="hidden"
              />

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={processing}
                className="bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white font-bold py-4 px-10 rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 mx-auto shadow-lg hover:shadow-red-500/25 transform hover:scale-105"
              >
                {processing ? (
                  <>
                    <Loader className="animate-spin w-6 h-6" />
                    <span className="text-lg">Processando PDF...</span>
                  </>
                ) : (
                  <>
                    <FileText className="w-6 h-6" />
                    <span className="text-lg">Selecionar PDF</span>
                  </>
                )}
              </button>

              {file && (
                <div className="mt-8 p-4 bg-green-500/10 border border-green-500/20 rounded-xl backdrop-blur-sm">
                  <p className="text-green-400 flex items-center justify-center gap-3 text-lg">
                    <CheckCircle className="w-6 h-6" />
                    <span className="font-medium">{file.name}</span>
                  </p>
                </div>
              )}

              {error && (
                <div className="mt-8 p-4 bg-red-500/10 border border-red-500/20 rounded-xl backdrop-blur-sm">
                  <p className="text-red-400 text-lg">{error}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Results Section */}
        {processedData && (
          <div className="space-y-8">
            <div className="bg-gradient-to-r from-green-600/20 to-green-700/20 backdrop-blur-xl rounded-2xl p-8 border border-green-500/30 shadow-2xl">
              <div className="flex flex-col lg:flex-row items-center justify-between gap-6">
                <div className="text-center lg:text-left">
                  <h2 className="text-3xl font-bold mb-3 flex items-center gap-3 justify-center lg:justify-start">
                    <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-white" />
                    </div>
                    <span className="bg-gradient-to-r from-green-400 to-green-300 bg-clip-text text-transparent">
                      PDF Processado com Sucesso!
                    </span>
                  </h2>
                  <p className="text-gray-300 text-lg">
                    <span className="font-semibold text-green-400">
                      {processedData.length}
                    </span>{" "}
                    gerentes encontrados &bull;{" "}
                    <span className="font-semibold text-green-400">
                      {processedData.reduce((sum, g) => sum + (Array.isArray(g.cambistas) ? g.cambistas.length : 0), 0)}
                    </span>{" "}
                    cambistas
                  </p>
                </div>
                <button
                  onClick={downloadAllImages}
                  disabled={processing}
                  className="bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-bold py-4 px-8 rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 shadow-lg hover:shadow-green-500/25 transform hover:scale-105"
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

            {/* Lista resumida de gerentes */}
            <div className="bg-gray-900/80 backdrop-blur-xl rounded-2xl p-6 border border-gray-700/50 shadow-2xl">
              <h3 className="text-xl font-bold text-white mb-4">Gerentes encontrados</h3>
              <div className="divide-y divide-gray-700/40">
                {processedData.map((gerente, idx) => (
                  <div key={`resumo-${idx}`} className="flex items-center justify-between py-3">
                    <span className="text-gray-300 font-medium">
                      {gerente && gerente.nome ? gerente.nome : `Gerente ${idx + 1}`}
                    </span>
                    <span className="text-green-400 font-semibold">
                      {(Array.isArray(gerente?.cambistas) ? gerente.cambistas.length : 0)} cambistas
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
                className="bg-gradient-to-r from-gray-700 to-gray-800 hover:from-gray-800 hover:to-gray-900 text-white font-bold py-4 px-12 rounded-xl transition-all duration-300 shadow-lg hover:shadow-gray-500/25 transform hover:scale-105"
              >
                Processar Novo PDF
              </button>
            </div>

          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};


// Parser principal baseado em texto continuo (normalizado)
const parsePDFTextStable = (text) => {
  const DEBUG = DEBUG_LOGS;

  const normalizeText = (input) =>
    (input || "")
      .normalize("NFKC")
      .replace(/[\u00A0\u2007\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const sanitizeGerenteName = (value) =>
    (value || "").replace(/^\s*\d+\s*/, "").trim();
  const shouldIgnoreHeader = (value) => {
    const norm = (value || "").toLowerCase();
    if (!norm) return true;
    if (/\bapostas\b/.test(norm) && /\bentradas\b/.test(norm)) return true;
    return false;
  };

  const textNorm = normalizeText(text);
  const LETTER_CLASS = "A-Za-z\\u00C0-\\u017F";
  const NAME_BODY_CHARS = `${LETTER_CLASS}0-9\\s._'\\-`;
  const NAME_START_CHARS = `${LETTER_CLASS}0-9`;

  const headerRe = new RegExp(
    `([${NAME_BODY_CHARS}]+?)\\s*\\/\\s*Comiss(?:\\u00E3o|ao)\\s*R\\$\\s*(-?\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2})`,
    "giu"
  );

  const headers = [];
  for (const match of textNorm.matchAll(headerRe)) {
    const nomeBruto = (match[1] || "").trim();
    const nome = sanitizeGerenteName(nomeBruto);
    if (shouldIgnoreHeader(nome)) continue;
    headers.push({
      index: match.index ?? 0,
      nome,
      comissao: (match[2] || "0,00").replace(/\s+/g, ""),
    });
  }

  if (DEBUG) console.log("Headers detectados:", headers.map((h) => h.nome));
  if (headers.length === 0) return [];

  const gerentes = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : textNorm.length;
    const section = textNorm.slice(start, end);

    const periodoMatch = section.match(/Per[i\u00ED]odo:\s*([0-9\/.\-\s\u00E0a]+\d{4})/iu);
    const periodo = periodoMatch ? (periodoMatch[1] || "").trim() : "";

    const money = '-?\\s*\\d{1,3}(?:\\.\\d{3})*,\\d{2}';
    const rowRe = new RegExp(
      `([${NAME_START_CHARS}][${NAME_BODY_CHARS}]*?)\\s+(\\d{1,4})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})\\s+R\\$\\s*(${money})`,
      'giu'
    );

    const cambistas = [];
    let rowMatch;
    while ((rowMatch = rowRe.exec(section)) !== null) {
      const nome = (rowMatch[1] || "").trim();
      if (
        !nome ||
        /^(Subtotal|Total)$/i.test(nome) ||
        shouldIgnoreHeader(nome)
      )
        continue;

      cambistas.push({
        nome,
        nApostas: (rowMatch[2] || "").replace(/[^\d]/g, ""),
        entradas: (rowMatch[3] || "0,00").replace(/\s+/g, ""),
        saidas: (rowMatch[4] || "0,00").replace(/\s+/g, ""),
        lancamentos: (rowMatch[5] || "0,00").replace(/\s+/g, ""),
        cartoes: (rowMatch[6] || "0,00").replace(/\s+/g, ""),
        comissao: (rowMatch[7] || "0,00").replace(/\s+/g, ""),
        parcial: (rowMatch[8] || "0,00").replace(/\s+/g, ""),
        liquido: (rowMatch[9] || "0,00").replace(/\s+/g, ""),
      });
    }

    if (DEBUG) console.log(`Cambistas em ${headers[i].nome}:`, cambistas.length);
    gerentes.push({
      nome: headers[i].nome,
      comissao: headers[i].comissao,
      periodo,
      cambistas,
    });
  }

  if (DEBUG) {
    console.log('Gerentes totais:', gerentes.length);
    console.log('Nomes:', gerentes.map((g) => g.nome));
  }

  return gerentes;
};

// Parser global mantem compatibilidade apontando para o parser estavel
const parsePDFTextGlobal = (text) => parsePDFTextStable(text);
export default App;









