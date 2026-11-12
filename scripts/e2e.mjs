import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const [mode, arg] = process.argv.slice(2);
const out = "data/shots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "es-AR" });
const assert = (ok, msg) => {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok: " + msg);
};

if (mode === "submit") {
  await page.goto(base);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out + "/home.png", fullPage: true });
  await page.getByRole("button", { name: "Pedir la evaluación" }).waitFor();
  await page.locator("textarea[name=text]").fill(arg);
  await page.getByRole("button", { name: "Pedir la evaluación" }).click();
  await page.waitForURL(/\/c\//);
  const heading = await page.getByRole("heading", { level: 1 }).textContent();
  assert(heading === "El panel está analizando", "after submitting, the case page shows only 'El panel está analizando'");
  assert((await page.locator("article[data-claim]").count()) === 0, "result cards are not shown while in session; completed dialogue messages may appear");
  await page.screenshot({ path: out + "/in-session.png", fullPage: true });
  console.log("case " + page.url().split("/").at(-1));
}

if (mode === "case") {
  await page.goto(base + "/c/" + arg);
  await page.waitForTimeout(1500);
  const heading = await page.getByRole("heading", { level: 1 }).textContent();
  console.log("heading: " + heading);
  const claims = await page.locator("article[data-claim]").count();
  const votes = page.locator('article[data-claim] [role="group"] span[aria-label][title]');
  const chips = await votes.count();
  const seals = await page.locator("span[aria-label^='Desempate del moderador']").count();
  console.log("claims=" + claims + " voteChips=" + chips + " judgeSeals=" + seals + " caseEntries=" + (await page.locator("section ol > li").count()));
  for (const label of await votes.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) console.log("  " + label);
  assert(claims > 0 && chips === claims * 4, "every claim shows exactly four analyst vote icons");
  await page.screenshot({ path: out + "/case-" + arg + ".png", fullPage: true });
  await page.screenshot({ path: out + "/case-" + arg + "-top.png" });
  await page.getByRole("heading", { name: "Registro del debate" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/case-" + arg + "-case.png" });
  await page.locator("[id^=S]").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/case-" + arg + "-debate.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + "/case-" + arg + "-mobile.png", fullPage: false });
}

await browser.close();
