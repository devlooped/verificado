import assert from "node:assert/strict";
import { test } from "node:test";
import { canViewAdmin, canViewCaseCost, isAdmin } from "./case-access.ts";

test("case costs require an authenticated user with the exact Contrib or Admin role", () => {
  for (const roles of [["Contrib"], ["Admin"], ["reader", "Contrib"], ["Contrib", "Admin"]]) {
    assert.equal(canViewCaseCost({ sub: "user", roles }), true);
  }
  for (const user of [undefined, null, { roles: ["Admin"] }, { roles: ["Contrib"] }, { sub: "user" },
    { sub: "user", roles: ["contrib"] }, { sub: "user", roles: ["admin"] },
    { sub: "user", roles: ["SuperAdmin"] }, { sub: "user", roles: "Contrib" },
    { sub: "user", roles: [null, "reader"] }]) {
    assert.equal(canViewCaseCost(user), false);
  }
});

test("the admin page is visible to an exact Contrib or Admin role, but only Admin may change it", () => {
  for (const roles of [["Contrib"], ["Admin"], ["reader", "Contrib"], ["Contrib", "Admin"]]) {
    assert.equal(canViewAdmin({ sub: "user", roles }), true);
  }
  for (const user of [undefined, null, { roles: ["Admin"] }, { roles: ["Contrib"] }, { sub: "user" },
    { sub: "user", roles: ["contrib"] }, { sub: "user", roles: ["admin"] },
    { sub: "user", roles: ["SuperAdmin"] }, { sub: "user", roles: "Contrib" }, { sub: "user", roles: [null, "reader"] }]) {
    assert.equal(canViewAdmin(user), false);
  }
  assert.equal(isAdmin({ sub: "user", roles: ["Contrib"] }), false);
});

