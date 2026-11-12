import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { imageProblem, RequestForm, TEXT_MIN, textCount } from "./request-form.tsx";

test("the form uses native radios and visible labels, and keeps every kind mounted but only the chosen one active", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(RequestForm)));
  const radios = [...document.querySelectorAll('input[type="radio"][name="kind"]')];
  assert.deepEqual(radios.map((r) => r.getAttribute("value")), ["text", "link", "image"]);
  assert.ok(radios[0].hasAttribute("checked"));
  assert.equal(document.querySelector('[role="tablist"]'), null);
  const language = document.querySelector('select[name="language"]')!;
  assert.ok(document.querySelector(`label[for="${language.id}"]`));
  assert.deepEqual([...language.querySelectorAll("option")].map((option) => [option.getAttribute("value"), option.textContent]), [["auto", "Detectar"], ["es", "Español"], ["en", "Inglés"]]);
  assert.ok(language.querySelector('option[value="auto"]')!.hasAttribute("selected"));
  for (const name of ["text", "url", "image"]) {
    const input = document.querySelector('[name="' + name + '"]')!;
    const label = document.querySelector('label[for="' + input.id + '"]')!;
    assert.ok(label && !label.className.includes("sr-only"), name + " has a visible label");
  }
  const sets = [...document.querySelectorAll("fieldset")].slice(1);
  assert.deepEqual(sets.map((f) => f.hasAttribute("disabled")), [false, true, true]);
  assert.deepEqual(sets.map((f) => f.hasAttribute("hidden")), [false, true, true]);
});

test("the form offers no check type: the Expert check is disabled", () => {
  for (const user of [undefined, { sub: "user", roles: ["Admin"] }]) {
    const { document } = parseHTML(renderToStaticMarkup(createElement(RequestForm, { user })));
    assert.equal(document.querySelector('[name="check"]'), null);
    assert.doesNotMatch(document.toString(), /Tipo de chequeo|Experto|Rápido/);
  }
});

test("independent claims are an accessible unchecked option", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(RequestForm, { user: { sub: "user", roles: ["Contrib"] } })));
  const option = document.querySelector<HTMLInputElement>('input[type="checkbox"][name="identifyClaims"]')!;
  assert.ok(option);
  assert.ok(!option.hasAttribute("checked"));
  assert.ok(!option.hasAttribute("disabled"));
  assert.equal(document.querySelector(`label[for="${option.id}"]`)?.textContent?.trim(), "Identificar afirmaciones independientes");
  const hint = document.getElementById(option.getAttribute("aria-describedby")!)!;
  assert.match(hint.textContent!, /cada una y el contenido completo, sin debate\. No se aplica a preguntas/);
});

test("independent claims are only rendered for authenticated Contrib or Admin roles", () => {
  for (const roles of [["Contrib"], ["Admin"], ["reader", "Contrib"], ["Contrib", "Admin"]]) {
    const { document } = parseHTML(renderToStaticMarkup(createElement(RequestForm, { user: { sub: "user", roles } })));
    assert.ok(document.querySelector('[name="identifyClaims"]'));
  }
  for (const user of [undefined, null, { roles: ["Contrib"] }, { sub: "user" }, { sub: "user", roles: ["reader"] },
    { sub: "user", roles: ["contrib"] }, { sub: "user", roles: ["admin"] }, { sub: "user", roles: "Admin" }, { sub: "user", roles: ["SuperAdmin"] }]) {
    const { document } = parseHTML(renderToStaticMarkup(createElement(RequestForm, { user })));
    assert.equal(document.querySelector('[name="identifyClaims"]'), null);
    assert.ok(document.querySelector('button[type="submit"]'), "ordinary checks stay available");
  }
});

test("the text counter says what is missing below the minimum, else how much is used", () => {
  assert.deepEqual(textCount(""), { label: "0 / 6.000", short: false });
  assert.deepEqual(textCount("  corto  "), { label: "Faltan 15 caracteres", short: true });
  assert.deepEqual(textCount("x".repeat(TEXT_MIN - 1)), { label: "Faltan 1 carácter", short: true });
  assert.equal(textCount("x".repeat(1234)).short, false);
  assert.match(textCount("x".repeat(1234)).label, /^1\.234 \/ 6\.000$/);
});

test("an image is checked before it is uploaded, with the server's messages", () => {
  assert.equal(imageProblem(undefined), "Elegí una imagen.");
  assert.equal(imageProblem({ size: 0, type: "image/png" }), "Elegí una imagen.");
  assert.equal(imageProblem({ size: 10, type: "application/pdf" }), "Formatos aceptados: PNG, JPG, WEBP o GIF.");
  assert.equal(imageProblem({ size: 5 * 1024 * 1024, type: "image/jpeg" }), "La imagen no puede superar 4 MB.");
  assert.equal(imageProblem({ size: 1024, type: "image/webp" }), undefined);
});
