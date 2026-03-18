import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_REPORTS_DIR = "bot/output";
const DEFAULT_MAP_PATH = "bot/config/area-whatsapp-groups.json";
const DEFAULT_SESSION_DIR = "bot/.session/whatsapp";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_DELAY_BETWEEN_SEND_MS = 1_200;
const WHATSAPP_URL = "https://web.whatsapp.com/";

function todayIsoDate() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeLooseText(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sanitizeFilename(value) {
  const ascii = String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "arquivo";
}

function xpathStringLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.split("'").join("',\"'\",'")}')`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    date: todayIsoDate(),
    reportsDir: DEFAULT_REPORTS_DIR,
    mapPath: DEFAULT_MAP_PATH,
    sessionDir: DEFAULT_SESSION_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    delayBetweenSendMs: DEFAULT_DELAY_BETWEEN_SEND_MS,
    execute: false,
    areas: [],
    limit: null,
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
    if (arg.startsWith("--reports-dir=")) {
      options.reportsDir = arg.slice("--reports-dir=".length);
      continue;
    }
    if (arg === "--reports-dir") {
      options.reportsDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--map=")) {
      options.mapPath = arg.slice("--map=".length);
      continue;
    }
    if (arg === "--map") {
      options.mapPath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--session-dir=")) {
      options.sessionDir = arg.slice("--session-dir=".length);
      continue;
    }
    if (arg === "--session-dir") {
      options.sessionDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number.parseInt(arg.slice("--timeout-ms=".length), 10);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(args[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith("--delay-ms=")) {
      options.delayBetweenSendMs = Number.parseInt(arg.slice("--delay-ms=".length), 10);
      continue;
    }
    if (arg === "--delay-ms") {
      options.delayBetweenSendMs = Number.parseInt(args[i + 1], 10);
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
    if (arg.startsWith("--area=")) {
      options.areas.push(arg.slice("--area=".length));
      continue;
    }
    if (arg === "--area") {
      options.areas.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Argumento nao reconhecido: ${arg}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error("Data invalida. Use formato YYYY-MM-DD.");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("O --timeout-ms precisa ser um inteiro positivo.");
  }
  if (!Number.isFinite(options.delayBetweenSendMs) || options.delayBetweenSendMs < 0) {
    throw new Error("O --delay-ms precisa ser um inteiro maior ou igual a zero.");
  }
  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit <= 0)) {
    throw new Error("O --limit precisa ser um inteiro positivo.");
  }

  return options;
}

function helpText() {
  return `
Uso:
  npm run bot:wa:send -- [opcoes]

Padrao:
  roda em modo PREVIEW (nao envia). Use --execute para enviar de verdade.

Opcoes:
  --date YYYY-MM-DD         Data dos relatios em bot/output/YYYY-MM-DD
  --reports-dir caminho     Diretorio base dos relatorios (padrao: bot/output)
  --map caminho             Arquivo de mapeamento area -> grupo
  --session-dir caminho     Sessao persistente do WhatsApp Web
  --timeout-ms 120000       Timeout de espera da UI do WhatsApp
  --delay-ms 1200           Espera entre envios
  --area "NOME"             Filtra por area (pode repetir)
  --limit N                 Processa apenas as primeiras N areas
  --execute                 Envia mensagens de fato
  --help                    Exibe esta ajuda
`.trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function loadMapping(mapPath) {
  const resolved = path.resolve(mapPath);
  let parsed;
  try {
    parsed = await readJson(resolved);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Arquivo de mapeamento nao encontrado: ${resolved}`);
    }
    throw new Error(`Falha ao ler mapeamento: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.groups)) {
    throw new Error("Formato invalido em mapeamento. Esperado: { \"groups\": [] }.");
  }
  return parsed.groups
    .map((entry) => ({
      areaName: normalizeText(entry.areaName),
      areaId: normalizeText(entry.areaId),
      groupName: normalizeText(entry.groupName),
      enabled: entry.enabled !== false,
    }))
    .filter((entry) => entry.enabled);
}

async function loadReportsForDate(reportsDir, date) {
  const dateDir = path.resolve(reportsDir, date);
  let files;
  try {
    files = await fs.readdir(dateDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Diretorio de relatorios nao encontrado: ${dateDir}`);
    }
    throw error;
  }

  const jsonFiles = files.filter(
    (name) => name.endsWith(".json") && name !== "_resumo_execucao.json" && !name.startsWith("_"),
  );
  const reports = [];

  for (const jsonName of jsonFiles) {
    const jsonPath = path.join(dateDir, jsonName);
    const json = await readJson(jsonPath);
    const base = jsonName.slice(0, -".json".length);
    const txtPath = path.join(dateDir, `${base}.txt`);
    let messageText = "";
    try {
      messageText = await fs.readFile(txtPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    reports.push({
      areaName: normalizeText(json.areaName),
      areaId: normalizeText(json.areaId),
      total: normalizeText(json.total),
      rowCount: Number(json.rowCount ?? 0),
      messageText,
      jsonPath,
      txtPath,
    });
  }

  return { dateDir, reports };
}

function filterMappings(mapping, options) {
  let selected = mapping;
  if (options.areas.length) {
    const wanted = new Set(options.areas.map((value) => normalizeKey(value)));
    selected = selected.filter((entry) => wanted.has(normalizeKey(entry.areaName)));
  }
  if (options.limit) {
    selected = selected.slice(0, options.limit);
  }
  return selected;
}

function buildJobs(selectedMappings, reports) {
  const byAreaName = new Map(reports.map((item) => [normalizeKey(item.areaName), item]));
  const byAreaId = new Map(
    reports
      .filter((item) => item.areaId)
      .map((item) => [normalizeText(item.areaId), item]),
  );

  const jobs = [];
  const errors = [];

  for (const entry of selectedMappings) {
    const report = entry.areaId ? byAreaId.get(entry.areaId) : byAreaName.get(normalizeKey(entry.areaName));
    if (!report) {
      errors.push({
        areaName: entry.areaName,
        areaId: entry.areaId,
        groupName: entry.groupName,
        reason: "Relatorio nao encontrado para a area",
      });
      continue;
    }
    if (!entry.groupName) {
      errors.push({
        areaName: entry.areaName,
        areaId: entry.areaId,
        groupName: entry.groupName,
        reason: "Grupo de WhatsApp vazio no mapeamento",
      });
      continue;
    }
    if (!report.messageText) {
      errors.push({
        areaName: entry.areaName,
        areaId: entry.areaId,
        groupName: entry.groupName,
        reason: "Arquivo .txt da mensagem nao encontrado",
      });
      continue;
    }

    jobs.push({
      areaName: report.areaName,
      areaId: report.areaId,
      groupName: entry.groupName,
      messageText: report.messageText,
      total: report.total,
      rowCount: report.rowCount,
      sourceJson: report.jsonPath,
      sourceTxt: report.txtPath,
    });
  }

  return { jobs, errors };
}

async function waitForWhatsAppReady(page, timeoutMs) {
  const selectors = [
    "#pane-side",
    "[data-testid='chat-list']",
    "div[aria-label='Chat list']",
    "div[aria-label='Lista de conversas']",
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("WhatsApp Web nao ficou pronto dentro do timeout.");
}

async function openGroup(page, groupName, timeoutMs) {
  await page.keyboard.press("Control+K");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(groupName, { delay: 25 });

  const literal = xpathStringLiteral(groupName);
  const searchResult = page.locator(
    `xpath=//*[@id='pane-side']//*[@title=${literal}]`,
  ).first();
  await searchResult.waitFor({ state: "visible", timeout: timeoutMs });
  await searchResult.click();

  const selectedChat = page.locator(
    `xpath=//*[@id='pane-side']//*[@aria-selected='true']//*[@title=${literal}] | //*[@id='pane-side']//*[@aria-selected='true' and @title=${literal}]`,
  ).first();
  await selectedChat.waitFor({ state: "visible", timeout: timeoutMs });

  const header = page.locator("#main header").first();
  await header.waitFor({ state: "visible", timeout: timeoutMs });
  const headerText = normalizeText(await header.innerText());
  const expected = normalizeLooseText(groupName);
  const got = normalizeLooseText(headerText);
  if (!got.includes(expected)) {
    throw new Error(
      `Chat aberto nao confere com o grupo esperado. Esperado: "${groupName}" | Header: "${headerText}"`,
    );
  }
}

async function sendMessageToCurrentChat(page, messageText) {
  const textbox = page.locator("footer div[contenteditable='true'][role='textbox']").first();
  await textbox.waitFor({ state: "visible", timeout: 15_000 });
  await textbox.click();
  await page.keyboard.insertText(messageText);
  await page.keyboard.press("Enter");
}

async function runPreview(jobs, errors, outputPath) {
  const preview = {
    mode: "preview",
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    totalErrors: errors.length,
    jobs: jobs.map((job) => ({
      areaName: job.areaName,
      areaId: job.areaId,
      groupName: job.groupName,
      rowCount: job.rowCount,
      total: job.total,
      sourceTxt: job.sourceTxt,
    })),
    errors,
  };
  await fs.writeFile(outputPath, JSON.stringify(preview, null, 2), "utf8");
}

async function runExecution(jobs, errors, options, outputPath, screenshotsDir) {
  const result = {
    mode: "execute",
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    sent: [],
    failed: [...errors],
  };

  const sessionDir = path.resolve(options.sessionDir);
  await ensureDir(sessionDir);

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(WHATSAPP_URL, { waitUntil: "domcontentloaded" });
    await waitForWhatsAppReady(page, options.timeoutMs);

    for (const job of jobs) {
      try {
        await openGroup(page, job.groupName, options.timeoutMs);
        await sendMessageToCurrentChat(page, job.messageText);
        result.sent.push({
          areaName: job.areaName,
          areaId: job.areaId,
          groupName: job.groupName,
          total: job.total,
          rowCount: job.rowCount,
          sentAt: new Date().toISOString(),
        });
        await page.waitForTimeout(options.delayBetweenSendMs);
      } catch (error) {
        const shotName = `${sanitizeFilename(job.areaName)}__${Date.now()}.png`;
        const shotPath = path.join(screenshotsDir, shotName);
        try {
          await page.screenshot({ path: shotPath, fullPage: true });
        } catch {
          // Ignore screenshot failures to avoid masking main error.
        }
        result.failed.push({
          areaName: job.areaName,
          areaId: job.areaId,
          groupName: job.groupName,
          reason: error.message,
          screenshot: shotPath,
        });
      }
    }
  } finally {
    await context.close();
  }

  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const mapping = await loadMapping(options.mapPath);
  if (!mapping.length) {
    throw new Error(
      "Mapeamento vazio. Preencha bot/config/area-whatsapp-groups.json com area e grupo.",
    );
  }

  const { dateDir, reports } = await loadReportsForDate(options.reportsDir, options.date);
  const selectedMappings = filterMappings(mapping, options);
  if (!selectedMappings.length) {
    throw new Error("Nenhuma area selecionada apos aplicar filtros.");
  }

  const { jobs, errors } = buildJobs(selectedMappings, reports);
  const outJson = path.join(
    dateDir,
    options.execute ? "_whatsapp_execute_result.json" : "_whatsapp_preview.json",
  );
  const screenshotsDir = path.join(dateDir, "_whatsapp_screenshots");
  await ensureDir(screenshotsDir);

  if (!options.execute) {
    await runPreview(jobs, errors, outJson);
    console.log("Preview gerado com sucesso.");
    console.log(`Arquivo: ${outJson}`);
    console.log(`Pronto para envio: ${jobs.length}`);
    console.log(`Com erro: ${errors.length}`);
    console.log("Use --execute para enviar de fato.");
    return;
  }

  if (!jobs.length) {
    throw new Error("Nao ha mensagens validas para envio.");
  }

  console.log(`Iniciando envio de ${jobs.length} mensagem(ns) via WhatsApp Web...`);
  const result = await runExecution(jobs, errors, options, outJson, screenshotsDir);
  console.log("Envio finalizado.");
  console.log(`Arquivo de resultado: ${outJson}`);
  console.log(`Enviadas: ${result.sent.length}`);
  console.log(`Falhas: ${result.failed.length}`);
}

main().catch((error) => {
  console.error(`Falha no envio WhatsApp: ${error.message}`);
  process.exitCode = 1;
});
