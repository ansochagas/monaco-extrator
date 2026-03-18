import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { load as loadHtml } from "cheerio";

const DEFAULT_BASE_URL = "https://monacoloterias.ddns.net";
const DEFAULT_LOGIN_PATH = "/login";
const DEFAULT_REPORT_PATH = "/Coletas";
const DEFAULT_OUTPUT_DIR = "bot/output";

function nowIso() {
  return new Date().toISOString();
}

function todayIsoDate() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fixMojibakeIfNeeded(value) {
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (repaired.includes("\uFFFD")) {
      return value;
    }
    return repaired;
  } catch {
    return value;
  }
}

function normalizeText(value) {
  const cleaned = String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return fixMojibakeIfNeeded(cleaned);
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function sanitizeFilename(value) {
  const ascii = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const safe = ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "arquivo";
}

function parseCurrencyToCents(rawValue) {
  const clean = String(rawValue ?? "")
    .replace(/\s+/g, "")
    .replace(/[R$r$\u00A0]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!clean) return 0;
  const amount = Number(clean);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function formatCentsToCurrency(cents) {
  const signal = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const integer = Math.floor(absolute / 100);
  const decimal = String(absolute % 100).padStart(2, "0");
  const formattedInteger = String(integer).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${signal}R$ ${formattedInteger},${decimal}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    date: todayIsoDate(),
    areas: [],
    areaIds: [],
    limit: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    saveHtml: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--date=")) {
      options.date = arg.slice("--date=".length);
      continue;
    }
    if (arg === "--date") {
      options.date = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--area=")) {
      options.areas.push(arg.slice("--area=".length));
      continue;
    }
    if (arg === "--area") {
      options.areas.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--area-id=")) {
      options.areaIds.push(arg.slice("--area-id=".length));
      continue;
    }
    if (arg === "--area-id") {
      options.areaIds.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = Number.parseInt(arg.slice("--limit=".length), 10);
      continue;
    }
    if (arg === "--limit") {
      options.limit = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--save-html") {
      options.saveHtml = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Argumento nao reconhecido: ${arg}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("Data invalida. Use formato YYYY-MM-DD, ex: 2026-02-25");
  }

  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("O --limit precisa ser um inteiro positivo.");
  }

  return options;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadDotEnv(dotEnvPath) {
  try {
    const fileContent = await fs.readFile(dotEnvPath, "utf8");
    for (const rawLine of fileContent.split(/\r?\n/g)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = line.slice(0, equalsIndex).trim();
      const value = line.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

class HttpSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cookies = new Map();
  }

  buildCookieHeader() {
    if (!this.cookies.size) return "";
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  storeCookies(response) {
    const setCookieHeaders =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const cookie of setCookieHeaders) {
      const firstChunk = cookie.split(";")[0];
      const separator = firstChunk.indexOf("=");
      if (separator <= 0) continue;
      const name = firstChunk.slice(0, separator).trim();
      const value = firstChunk.slice(separator + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  resolveUrl(urlOrPath) {
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
    return new URL(urlOrPath, `${this.baseUrl}/`).toString();
  }

  async request(urlOrPath, init = {}) {
    const maxRedirects = 10;
    let currentUrl = this.resolveUrl(urlOrPath);
    let method = (init.method || "GET").toUpperCase();
    let body = init.body;
    let redirects = 0;

    while (redirects <= maxRedirects) {
      const headers = new Headers(init.headers || {});
      const cookieHeader = this.buildCookieHeader();
      if (cookieHeader) headers.set("Cookie", cookieHeader);
      if (method === "POST" && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/x-www-form-urlencoded");
      }

      const response = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: "manual",
      });
      this.storeCookies(response);

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      currentUrl = this.resolveUrl(location);
      method = "GET";
      body = undefined;
      redirects += 1;
    }

    throw new Error(`Muitos redirects ao acessar ${urlOrPath}`);
  }

  async getText(urlOrPath) {
    const response = await this.request(urlOrPath, { method: "GET" });
    return response.text();
  }

  async postForm(urlOrPath, payload) {
    const body = new URLSearchParams(payload).toString();
    const response = await this.request(urlOrPath, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    return response.text();
  }
}

function parseHiddenInputs(html) {
  const $ = loadHtml(html);
  const fields = {};
  $("input[type='hidden'][name]").each((_, input) => {
    const name = $(input).attr("name");
    if (!name) return;
    fields[name] = $(input).attr("value") ?? "";
  });
  return fields;
}

function parseAreaOptions(html) {
  const $ = loadHtml(html);
  const options = [];
  $("#ContentPlaceHolderMaster_dropDownListArea option").each((_, option) => {
    const value = normalizeText($(option).attr("value"));
    const name = normalizeText($(option).text());
    if (!value || value === "0") return;
    options.push({ id: value, name });
  });
  return options;
}

function parseReportTable(html) {
  const $ = loadHtml(html);
  const periodLabel = normalizeText($("#ContentPlaceHolderMaster_data").attr("value") || "");
  const table = $("#ContentPlaceHolderMaster_gridviewColetas");

  if (!table.length) {
    return {
      periodLabel,
      rows: [],
      total: "R$ 0,00",
      hasTable: false,
    };
  }

  const rows = [];
  let total = "";
  table.find("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => normalizeText($(td).text()));
    if (!cells.length) return;

    const data = cells[2] ?? "";
    const vendedor = cells[4] ?? "";
    const coletor = cells[5] ?? "";
    const tipo = cells[6] ?? "";
    const valor = cells[8] ?? "";

    const isTotalRow = !data && !vendedor && !coletor && !tipo && Boolean(valor);
    if (isTotalRow) {
      total = valor;
      return;
    }

    const isDataRow = Boolean(data || vendedor || coletor || tipo || valor);
    if (!isDataRow) return;

    rows.push({
      data,
      vendedor,
      coletor,
      tipo,
      valor,
    });
  });

  if (!total) {
    const sum = rows.reduce((acc, item) => acc + parseCurrencyToCents(item.valor), 0);
    total = formatCentsToCurrency(sum);
  }

  return {
    periodLabel,
    rows,
    total,
    hasTable: true,
  };
}

function buildTextReport({ areaName, queryDate, periodLabel, rows, total }) {
  const lines = [];
  lines.push("Ola,");
  lines.push("");
  lines.push("Segue abaixo seu relatorio de coletas no dia e o valor que precisa ser enviado:");
  lines.push("");
  lines.push(`AREA: ${areaName}`);
  lines.push(`DATA REFERENCIA: ${queryDate}`);
  if (periodLabel) {
    lines.push(`PERIODO SISTEMA: ${periodLabel}`);
  }
  lines.push("");
  lines.push("DATA | VENDEDOR | COLETOR | TIPO | VALOR");
  if (!rows.length) {
    lines.push("(sem movimentacao)");
  } else {
    for (const row of rows) {
      lines.push(
        `${row.data} | ${row.vendedor} | ${row.coletor} | ${row.tipo} | ${row.valor}`,
      );
    }
  }
  lines.push(`TOTAL: ${total}`);
  return lines.join("\n");
}

function filterAreas(allAreas, options) {
  const wantedNames = new Set(options.areas.map((name) => normalizeKey(name)));
  const wantedIds = new Set(options.areaIds.map((id) => String(id).trim()));

  let selected = allAreas;
  if (wantedNames.size || wantedIds.size) {
    selected = allAreas.filter(
      (area) => wantedIds.has(area.id) || wantedNames.has(normalizeKey(area.name)),
    );
  }

  if (options.limit) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

function parseEnvConfig() {
  const baseUrl = process.env.MONACO_BASE_URL || DEFAULT_BASE_URL;
  const loginPath = process.env.MONACO_LOGIN_PATH || DEFAULT_LOGIN_PATH;
  const reportPath = process.env.MONACO_REPORT_PATH || DEFAULT_REPORT_PATH;
  const username = process.env.MONACO_USER || "";
  const password = process.env.MONACO_PASSWORD || "";
  return { baseUrl, loginPath, reportPath, username, password };
}

function helpText() {
  return `
Uso:
  npm run bot:capture -- [opcoes]

Opcoes:
  --date YYYY-MM-DD         Data inicial/final da consulta (padrao: hoje)
  --area "NOME DA AREA"     Filtra por nome da area (pode repetir)
  --area-id 8               Filtra por id da area (pode repetir)
  --limit 3                 Processa apenas as primeiras N areas
  --output-dir caminho      Diretorio de saida (padrao: bot/output)
  --save-html               Salva HTML bruto de cada area para debug
  --help                    Exibe esta ajuda
`.trim();
}

async function login(session, config) {
  const loginHtml = await session.getText(config.loginPath);
  const state = parseHiddenInputs(loginHtml);
  const loginPayload = {
    ...state,
    usuario: config.username,
    senha: config.password,
    brnLogin: "Login",
  };
  const afterLoginHtml = await session.postForm(config.loginPath, loginPayload);
  if (!afterLoginHtml.includes("id=\"lblUsuario\"")) {
    throw new Error("Falha no login. Verifique usuario/senha.");
  }
}

function buildSearchPayload({ state, queryDate, areaId }) {
  return {
    ...state,
    __EVENTTARGET: state.__EVENTTARGET ?? "",
    __EVENTARGUMENT: state.__EVENTARGUMENT ?? "",
    __LASTFOCUS: state.__LASTFOCUS ?? "",
    "ctl00$ContentPlaceHolderMaster$data_inicial": queryDate,
    "ctl00$ContentPlaceHolderMaster$data_final": queryDate,
    "ctl00$ContentPlaceHolderMaster$dropDownListArea": areaId,
    "ctl00$ContentPlaceHolderMaster$dropDownListColetor": "0",
    "ctl00$ContentPlaceHolderMaster$dropDownListVendedor": "0",
    "ctl00$ContentPlaceHolderMaster$DropDownListTipo": "0",
    "ctl00$ContentPlaceHolderMaster$DropDownListStatus": "0",
    "ctl00$ContentPlaceHolderMaster$btnBuscar": "Geral",
  };
}

async function captureArea(session, config, area, queryDate) {
  const reportHtml = await session.getText(config.reportPath);
  const state = parseHiddenInputs(reportHtml);
  const payload = buildSearchPayload({
    state,
    queryDate,
    areaId: area.id,
  });
  const resultHtml = await session.postForm(config.reportPath, payload);
  const parsed = parseReportTable(resultHtml);
  return {
    area,
    queryDate,
    parsed,
    html: resultHtml,
  };
}

async function saveAreaFiles({ outputDir, area, queryDate, report, saveHtml }) {
  const filePrefix = `${sanitizeFilename(area.name)}__id_${area.id}`;
  const textReport = buildTextReport({
    areaName: area.name,
    queryDate,
    periodLabel: report.periodLabel,
    rows: report.rows,
    total: report.total,
  });

  const jsonPayload = {
    generatedAt: nowIso(),
    areaId: area.id,
    areaName: area.name,
    queryDate,
    periodLabel: report.periodLabel,
    rowCount: report.rows.length,
    total: report.total,
    rows: report.rows,
  };

  await fs.writeFile(path.join(outputDir, `${filePrefix}.txt`), textReport, "utf8");
  await fs.writeFile(
    path.join(outputDir, `${filePrefix}.json`),
    JSON.stringify(jsonPayload, null, 2),
    "utf8",
  );
  if (saveHtml) {
    await fs.writeFile(path.join(outputDir, `${filePrefix}.html`), report.rawHtml, "utf8");
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  await loadDotEnv(path.resolve("bot/.env"));
  const config = parseEnvConfig();

  if (!config.username || !config.password) {
    throw new Error(
      "Credenciais ausentes. Configure MONACO_USER e MONACO_PASSWORD no bot/.env.",
    );
  }

  const outDateDir = path.resolve(options.outputDir, options.date);
  await ensureDir(outDateDir);

  const session = new HttpSession(config.baseUrl);
  await login(session, config);
  const coletasHtml = await session.getText(config.reportPath);
  const allAreas = parseAreaOptions(coletasHtml);
  if (!allAreas.length) {
    throw new Error("Nao foi possivel carregar a lista de areas.");
  }

  const selectedAreas = filterAreas(allAreas, options);
  if (!selectedAreas.length) {
    throw new Error("Nenhuma area selecionada para processar.");
  }

  const executionSummary = {
    generatedAt: nowIso(),
    date: options.date,
    totalAreasAvailable: allAreas.length,
    totalAreasProcessed: selectedAreas.length,
    success: [],
    failures: [],
  };

  console.log(
    `Iniciando captura de ${selectedAreas.length} area(s) para ${options.date}...`,
  );

  for (const area of selectedAreas) {
    try {
      const capture = await captureArea(session, config, area, options.date);
      const report = {
        ...capture.parsed,
        rawHtml: capture.html,
      };
      await saveAreaFiles({
        outputDir: outDateDir,
        area,
        queryDate: options.date,
        report,
        saveHtml: options.saveHtml,
      });
      executionSummary.success.push({
        areaId: area.id,
        areaName: area.name,
        rowCount: report.rows.length,
        total: report.total,
      });
      console.log(
        `[OK] ${area.name} (id ${area.id}) -> ${report.rows.length} linha(s), total ${report.total}`,
      );
    } catch (error) {
      executionSummary.failures.push({
        areaId: area.id,
        areaName: area.name,
        error: error.message,
      });
      console.error(`[ERRO] ${area.name} (id ${area.id}) -> ${error.message}`);
    }
  }

  const summaryPath = path.join(outDateDir, "_resumo_execucao.json");
  await fs.writeFile(summaryPath, JSON.stringify(executionSummary, null, 2), "utf8");

  console.log("");
  console.log(`Captura finalizada. Arquivos em: ${outDateDir}`);
  console.log(`Sucesso: ${executionSummary.success.length}`);
  console.log(`Falhas: ${executionSummary.failures.length}`);
  console.log(`Resumo: ${summaryPath}`);

  if (executionSummary.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Falha fatal: ${error.message}`);
  process.exitCode = 1;
});
