// Read-only source inspection: never import application modules or load .env.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Next already ships the parser; this is tooling, not a runtime dependency.
const parser = createRequire(import.meta.url)("next/dist/compiled/babel/parser.js") as {
  parse(source: string, options: object): Ast;
};
type Ast = { type: string; [key: string]: unknown };
const node = (value: unknown): Ast | undefined => value && typeof value === "object" && "type" in value ? value as Ast : undefined;
const name = (value: unknown): string => {
  const current = node(value);
  if (!current) return "";
  if (current.type === "Identifier") return String(current.name);
  if (current.type === "MemberExpression" || current.type === "OptionalMemberExpression") return `${name(current.object)}.${name(current.property)}`;
  return "";
};
const sqlText = (value: unknown): string => {
  const current = node(value);
  if (current?.type === "StringLiteral") return String(current.value);
  if (current?.type === "TemplateLiteral") return (current.quasis as Array<{ value: { raw: string } }>).map((q) => q.value.raw).join(" ");
  if (current?.type === "BinaryExpression" && current.operator === "+") return sqlText(current.left) + sqlText(current.right);
  return "";
};

export type EffectSite = { file: string; scope: string; call: string; kind: string; count: number };
export function inspectSource(file: string, source: string) {
  const ast = parser.parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const sites = new Map<string, EffectSite>();
  const steps: string[] = [];
  const symbols = new Set<string>();
  const turnKinds = new Set<string>();
  const visit = (current: Ast, scope: string) => {
    if (current.type === "FunctionDeclaration" || current.type === "ClassDeclaration") {
      const id = name(current.id);
      if (id) { scope = id; symbols.add(id); }
    } else if (current.type === "VariableDeclarator" && scope === "module") {
      const id = name(current.id);
      if (id) { scope = id; symbols.add(id); }
    } else if (["ObjectMethod", "ClassMethod", "ClassPrivateMethod", "ObjectProperty"].includes(current.type)) {
      const id = name(current.key);
      if (id) scope += `.${id}`;
    }
    const body = node(current.body);
    if (body?.type === "BlockStatement" && Array.isArray(body.directives) && body.directives.some((directive) => {
      const value = (directive as { value?: { value?: string } }).value?.value;
      return value === "use step";
    })) steps.push(scope);
    if (current.type === "TSTypeAliasDeclaration" && name(current.id) === "TurnSpec") {
      symbols.add("TurnSpec");
      const collect = (value: Ast) => {
        if (value.type === "TSPropertySignature" && name(value.key) === "kind") {
          const literal = node(node(value.typeAnnotation)?.typeAnnotation);
          const kind = node(literal?.literal)?.value;
          if (typeof kind === "string") turnKinds.add(kind);
        }
        for (const child of Object.values(value)) {
          if (Array.isArray(child)) child.forEach((item) => { const n = node(item); if (n) collect(n); });
          else { const n = node(child); if (n) collect(n); }
        }
      };
      collect(current);
    }
    if (current.type === "CallExpression" || current.type === "OptionalCallExpression") {
      const call = name(current.callee);
      const leaf = call.split(".").at(-1);
      let kind: string | undefined;
      if (["generateText", "generateImage", "embedMany", "streamText"].includes(call)) kind = "model";
      else if (leaf === "fetch" || call === "fetch") kind = "network";
      else if (call === "start" || call.endsWith(".cancel")) kind = "workflow";
      else if (["runCommand", "writeFiles", "readFileToBuffer", "getCommand", "stop", "snapshot"].includes(leaf ?? "") || /(?:sandbox|Sandbox)\.(?:create|get|list|delete|update)$/.test(call) || call === "found.delete") kind = "sandbox";
      else if (/\.sessions\.(?:create|update)$/.test(call) || call === "browser.close") kind = "browser";
      else if (["putObject", "copyObject", "deleteObjects"].includes(call)) kind = "object-storage";
      else if (leaf === "write") kind = "write-candidate";
      else if (["spawn", "writeFile", "unlink", "mkdtemp"].includes(leaf ?? "")) kind = "local-process-or-file";
      else if (leaf === "query") {
        const args = current.arguments as Ast[];
        const text = sqlText(args?.[0]);
        if (/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(text)) kind = "sql-write-or-lock";
      }
      if (kind) {
        const key = JSON.stringify([scope, call, kind]);
        const previous = sites.get(key);
        if (previous) previous.count++;
        else sites.set(key, { file, scope, call, kind, count: 1 });
      }
    }
    for (const child of Object.values(current)) {
      if (Array.isArray(child)) child.forEach((item) => { const n = node(item); if (n) visit(n, scope); });
      else { const n = node(child); if (n) visit(n, scope); }
    }
  };
  visit(ast, "module");
  return { sites: [...sites.values()], steps: [...new Set(steps)].sort(), symbols: [...symbols].sort(), turnKinds: [...turnKinds].sort() };
}

// Conservative syntactic candidates, not a reachability or fencing proof.
// Administrative/UI writers are included; tests, maintenance scripts, generated
// output and credentials are excluded. Maintenance entry points are in the doc.
export function inspectContinuationSources(root = process.cwd()) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(relative);
    }
  };
  walk("src");
  walk("sandbox/harness");
  const results = files.sort().map((file) => ({ file, ...inspectSource(file, readFileSync(path.join(root, file), "utf8")) }));
  return {
    scope: ["src/**/*.ts(x), excluding *.test.ts", "sandbox/harness/**/*.ts"],
    sites: results.flatMap((r) => r.sites).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    steps: results.filter((r) => r.steps.length).map(({ file, steps }) => ({ file, steps })),
    turnKinds: results.find((r) => r.file === "src/court/turns.ts")!.turnKinds,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(inspectContinuationSources(), null, 2));
}
