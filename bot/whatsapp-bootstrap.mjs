import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_SESSION_DIR = "bot/.session/whatsapp";
const WHATSAPP_URL = "https://web.whatsapp.com/";

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    sessionDir: DEFAULT_SESSION_DIR,
    timeoutMs: 5 * 60 * 1000,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Argumento nao reconhecido: ${arg}`);
  }

  if (
    !Number.isFinite(options.timeoutMs) ||
    Number.isNaN(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new Error("O --timeout-ms precisa ser um inteiro positivo.");
  }

  return options;
}

function helpText() {
  return `
Uso:
  npm run bot:wa:bootstrap -- [opcoes]

Opcoes:
  --session-dir caminho      Diretorio da sessao persistente (padrao: bot/.session/whatsapp)
  --timeout-ms 300000        Tempo maximo para detectar login (padrao: 300000)
  --help                     Exibe esta ajuda
`.trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function waitForWhatsAppReady(page, timeoutMs) {
  const readySelectors = [
    "#pane-side",
    "[data-testid='chat-list']",
    "div[aria-label='Chat list']",
    "div[aria-label='Lista de conversas']",
  ];
  const intervalMs = 600;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of readySelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        return selector;
      }
    }
    await page.waitForTimeout(intervalMs);
  }

  throw new Error(
    "Nao foi possivel confirmar login no WhatsApp Web dentro do tempo limite.",
  );
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  const sessionDir = path.resolve(options.sessionDir);
  await ensureDir(sessionDir);

  console.log("Abrindo WhatsApp Web em sessao persistente...");
  console.log(`Sessao: ${sessionDir}`);
  console.log("Se aparecer QR code, escaneie com o celular da conta do bot.");

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(WHATSAPP_URL, { waitUntil: "domcontentloaded" });

    const readySelector = await waitForWhatsAppReady(page, options.timeoutMs);
    console.log(`Sessao validada. Elemento detectado: ${readySelector}`);
    console.log(
      "Sessao salva com sucesso. Voce pode fechar o navegador ou encerrar com Ctrl+C.",
    );

    await page.waitForTimeout(15_000);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(`Falha no bootstrap do WhatsApp: ${error.message}`);
  process.exitCode = 1;
});
