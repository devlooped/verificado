import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage();
await page.goto(process.env.BASE_URL ?? "http://localhost:3000");
await page.getByRole("tab", { name: "Enlace" }).click();
await page.locator("input[name=url]").fill("http://localhost:3000/");
await page.getByRole("button", { name: "Pedir la evaluación" }).click();
const alert = await page.locator("form [role=alert]").textContent({ timeout: 10000 });
if (alert !== "Ingresá un enlace público." || page.url().includes("/c/")) throw new Error("FAILED: private link was accepted (" + alert + ")");
console.log("ok: a localhost link is rejected before any case is created");
await browser.close();
