import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaseRecord } from "../domain/court.ts";
import { Suspended } from "./suspended.tsx";

const failedCase: CaseRecord = {
  id: "failed-case",
  createdAt: "2026-10-31T00:00:00Z",
  status: "failed",
  submission: { kind: "text", text: "Una afirmación" },
  error: "Se interrumpió la sesión.",
};

test("only admins see failure details and the blocked retry control", () => {
  const allowed = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: { sub: "admin-user", roles: ["Admin"] } }));
  assert.doesNotMatch(allowed, /<form/);
  assert.match(allowed, /Reintentar/);
  assert.doesNotMatch(allowed, /Podés volver a intentarlo/);
  assert.match(allowed, /Detalle: Se interrumpió la sesión/);

  for (const user of [
    undefined,
    null,
    { sub: "someone", email: "other@example.com", email_verified: true },
    { sub: "someone", email: "daniel@cazzulino.com", email_verified: false },
    { email: "daniel@cazzulino.com", email_verified: true },
    { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true },
    { sub: "someone", roles: ["admin"] },
    { roles: ["Admin"] },
  ]) {
    const denied = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user }));
    assert.match(denied, /El análisis se interrumpió/);
    assert.match(denied, /El panel no pudo completar el análisis/);
    assert.doesNotMatch(denied, /Detalle:|Se interrumpió la sesión|<form|Reintentar|Podés volver a intentarlo/);
    assert.match(denied, /href="mailto:hola@che\.bot\?subject=Caso%20failed-case%20interrumpido"/);
  }
  for (const html of [allowed, renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: undefined }))]) {
    assert.ok(html.includes('href="/"'), "every visitor has a way back");
  }
  assert.doesNotMatch(allowed, /mailto:/);
});

test("admin retry is disabled without a form, with an accessible zero-effects explanation", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: { sub: "admin-user", roles: ["Admin"] } })));
  const button = document.querySelector("button")!;
  assert.equal(button.textContent, "Reintentar");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(button.hasAttribute("disabled"));
  assert.equal(document.querySelector("form"), null);
  assert.equal(button.hasAttribute("formaction"), false);
  const description = button.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent).join(" ");
  assert.match(description, /Reintentar está bloqueado: la continuación segura está desactivada/);
  assert.match(description, /No se reinicia ni se borra el expediente, no se limpian sus sandboxes ni se inicia otra ejecución/);
  assert.match(description, /No se puede estimar el costo pendiente ni qué resultados podrán reutilizarse/);
});

test("the blocked view distinguishes destructive administrative rerun without offering a fallback", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(Suspended, { c: { ...failedCase, error: undefined }, user: { sub: "admin-user", roles: ["Admin"] } })));
  const explanation = document.querySelector("section")!.textContent;
  assert.match(explanation, /«Volver a ejecutar» es una operación administrativa distinta: elimina resultados y archivos generados y empieza de cero/);
  assert.match(explanation, /No se usa como alternativa de Reintentar/);
  assert.equal(document.querySelectorAll("button").length, 1);
  assert.deepEqual([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["/"]);
});
