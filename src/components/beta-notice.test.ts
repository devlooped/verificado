import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BetaNotice } from "./beta-notice.tsx";

test("the beta notice offers email and sign-in for visitors", () => {
  const html = renderToStaticMarkup(createElement(BetaNotice, { signedIn: false }));
  assert.match(html, /está en beta/);
  assert.match(html, /pedir una evaluación/);
  assert.match(html, /href="mailto:hola@che\.bot"/);
  assert.match(html, />hola@che\.bot<\/a>/);
  assert.ok(html.includes('href="/auth/login?returnTo=/"'));
  assert.doesNotMatch(html, /<form/);
});

test("the beta notice lets signed-in visitors sign out", () => {
  const html = renderToStaticMarkup(createElement(BetaNotice, { signedIn: true }));
  assert.ok(html.includes('href="/auth/logout?returnTo=/"'));
  assert.doesNotMatch(html, /<form/);
});
