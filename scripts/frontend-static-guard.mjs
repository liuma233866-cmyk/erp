import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import acorn from "./acorn.cjs";

// Static guard for the classic-script frontend bundle. It parses every script in
// index.html load order with acorn, resolves call-site identifiers against real
// lexical scopes + cross-file globals, and reports load-order hazards. This replaces
// the old regex-based check that mistook keywords (if/for/while/catch/...), IIFE
// parameters and object-method definitions for undefined calls.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.FRONTEND_ROOT
  ? path.resolve(process.env.FRONTEND_ROOT)
  : path.resolve(here, "..", "frontend");

const FALLBACK_ORDER = [
  "core/state.js",
  "core/api.js",
  "core/router.js",
  "panels/orders.js",
  "panels/multi-platform-publish.js",
  "panels/logs.js",
  "panels/messages.js",
  "panels/users.js",
  "panels/shops.js",
  "panels/product-list.js",
  "panels/reports.js",
  "panels/finance.js",
  "panels/commissions.js",
  "core/safe-image-url.js",
  "core/profit-estimate.js",
  "panels/ai.js",
  "app.js",
];

function readLoadOrder() {
  const htmlPath = path.join(root, "index.html");
  if (!fs.existsSync(htmlPath)) return null;
  const html = fs.readFileSync(htmlPath, "utf8");
  const order = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const rel = m[1].split("?")[0].split("#")[0].replace(/\\/g, "/").replace(/^\/+/, "");
    if (rel.toLowerCase().endsWith(".js") && !order.includes(rel)) order.push(rel);
  }
  return order.length ? order : null;
}

const order = readLoadOrder() || FALLBACK_ORDER;

const BUILTINS = new Set([
  "console", "document", "window", "globalThis", "alert", "confirm", "prompt",
  "localStorage", "sessionStorage", "fetch", "JSON", "Math", "parseInt",
  "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "URL",
  "URLSearchParams", "Blob", "FileReader", "FormData", "Image", "Date", "Array",
  "Object", "String", "Number", "Boolean", "RegExp", "Promise", "Symbol", "Error",
  "TypeError", "RangeError", "ReferenceError", "SyntaxError", "ErrorEvent",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "TouchEvent",
  "PointerEvent", "File", "FileList", "DataTransfer", "navigator", "history",
  "location", "structuredClone", "Intl", "Map", "Set", "WeakMap", "WeakSet",
  "Proxy", "Reflect", "TextDecoder", "TextEncoder", "btoa", "atob",
  "queueMicrotask", "AbortController", "AbortSignal", "crypto", "XLSX", "iconv",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "BigInt64Array",
  "BigUint64Array", "ArrayBuffer", "DataView", "Buffer", "process", "module",
  "require", "exports", "performance", "requestIdleCallback",
  "cancelIdleCallback", "ResizeObserver", "IntersectionObserver",
  "MutationObserver", "screen", "innerWidth", "innerHeight", "getComputedStyle",
  "matchMedia", "getSelection", "Worker", "SharedWorker", "MessageChannel",
  "BroadcastChannel", "EventSource", "WebSocket", "CSS", "HTMLDivElement",
  "HTMLElement", "Element", "Node", "NodeList", "Document", "DOMParser",
  "XMLSerializer", "SVGElement", "CanvasRenderingContext2D", "Path2D",
  "Notification", "Function", "BigInt", "NaN", "Infinity", "undefined", "eval",
  "test", "describe", "it", "expect", "assert", "beforeEach", "afterEach",
  "before", "after", "AbortError", "setImmediate",
]);

function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      break;
    case "ObjectPattern":
      for (const p of node.properties) {
        if (p.type === "RestElement") collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of node.elements) collectPatternNames(el, out);
      break;
    case "AssignmentPattern":
      collectPatternNames(node.left, out);
      break;
    case "RestElement":
      collectPatternNames(node.argument, out);
      break;
    default:
      break;
  }
}

function collectScopeDecls(bodyStatements, target) {
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id) target.add(node.id.name);
        return;
      case "VariableDeclaration":
        for (const d of node.declarations) collectPatternNames(d.id, target);
        return;
      case "ClassDeclaration":
        if (node.id) target.add(node.id.name);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassExpression":
        return;
      case "BlockStatement":
        for (const s of node.body) visit(s);
        return;
      case "IfStatement":
        visit(node.consequent);
        if (node.alternate) visit(node.alternate);
        return;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        visit(node.body);
        return;
      case "TryStatement":
        visit(node.block);
        if (node.handler) visit(node.handler.body);
        if (node.finalizer) visit(node.finalizer);
        return;
      case "SwitchStatement":
        for (const c of node.cases) for (const s of c.consequent) visit(s);
        return;
      case "LabeledStatement":
        visit(node.body);
        return;
      case "WithStatement":
        visit(node.body);
        return;
      default:
        return;
    }
  };
  for (const s of bodyStatements) visit(s);
}

const parsed = new Map();
const globalNames = new Set();
const fileTopLevel = new Map();

for (const rel of order) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`missing file in load order: ${rel}`);
    process.exit(1);
  }
  const ast = acorn.parse(fs.readFileSync(file, "utf8"), {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    locations: true,
  });
  parsed.set(rel, ast);
  const top = new Set();
  collectScopeDecls(ast.body, top);
  fileTopLevel.set(rel, top);
  for (const n of top) globalNames.add(n);
}

const unresolved = [];
const loadOrderHazards = [];
const inventory = new Map();

for (const rel of order) {
  const ast = parsed.get(rel);

  let decls = 0;
  let arrows = 0;
  (function count(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration") decls++;
    else if (node.type === "ArrowFunctionExpression") arrows++;
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") count(c);
      } else if (v && typeof v.type === "string") {
        count(v);
      }
    }
  })(ast);
  inventory.set(rel, { decls, arrows });

  const report = (node, name, kind) => {
    unresolved.push({ file: rel, line: node.loc.start.line, name, kind });
  };

  function walk(node, scopes) {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "CallExpression":
      case "NewExpression": {
        const callee = node.callee;
        if (callee && callee.type === "Identifier") {
          const name = callee.name;
          if (!scopes.some((s) => s.has(name)) && !globalNames.has(name) && !BUILTINS.has(name)) {
            report(callee, name, node.type === "NewExpression" ? "new" : "call");
          }
        }
        break;
      }
      case "TaggedTemplateExpression": {
        if (node.tag.type === "Identifier") {
          const name = node.tag.name;
          if (!scopes.some((s) => s.has(name)) && !globalNames.has(name) && !BUILTINS.has(name)) {
            report(node.tag, name, "tag");
          }
        }
        break;
      }
      default:
        break;
    }

    if (node.type === "Program") {
      const s = new Set(fileTopLevel.get(rel));
      for (const st of node.body) walk(st, [...scopes, s]);
      return;
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const s = new Set();
      if (node.type === "FunctionExpression" && node.id) s.add(node.id.name);
      for (const p of node.params) collectPatternNames(p, s);
      collectScopeDecls(node.body.type === "BlockStatement" ? node.body.body : [node.body], s);
      const inner = [...scopes, s];
      for (const p of node.params) walk(p, inner);
      if (node.body.type === "BlockStatement") for (const st of node.body.body) walk(st, inner);
      else walk(node.body, inner);
      return;
    }
    if (node.type === "BlockStatement" || node.type === "StaticBlock") {
      const s = new Set();
      collectScopeDecls(node.body, s);
      const inner = [...scopes, s];
      for (const st of node.body) walk(st, inner);
      return;
    }
    if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      const s = new Set();
      if (node.type === "ForStatement" && node.init) collectScopeDecls([node.init], s);
      else if (node.left) collectScopeDecls([node.left], s);
      const inner = [...scopes, s];
      for (const key of ["init", "left", "right", "test", "update", "body"]) {
        if (node[key]) walk(node[key], inner);
      }
      return;
    }
    if (node.type === "CatchClause") {
      const s = new Set();
      if (node.param) collectPatternNames(node.param, s);
      collectScopeDecls(node.body.body, s);
      const inner = [...scopes, s];
      if (node.param) walk(node.param, inner);
      walk(node.body, inner);
      return;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const s = new Set();
      if (node.id) s.add(node.id.name);
      const inner = [...scopes, s];
      if (node.superClass) walk(node.superClass, inner);
      for (const el of node.body.body) walk(el, inner);
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") walk(c, scopes);
      } else if (v && typeof v.type === "string") {
        walk(v, scopes);
      }
    }
  }
  walk(ast, []);

  const idx = order.indexOf(rel);
  const immediate = new Set();
  for (let i = 0; i <= idx; i++) for (const n of fileTopLevel.get(order[i])) immediate.add(n);
  const laterOnly = new Set();
  for (let i = idx + 1; i < order.length; i++) {
    for (const n of fileTopLevel.get(order[i])) if (!immediate.has(n)) laterOnly.add(n);
  }
  const checkImmediate = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      const nm = node.callee.name;
      if (laterOnly.has(nm)) {
        loadOrderHazards.push({ file: rel, line: node.loc.start.line, name: nm });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      const v = node[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") checkImmediate(c);
      } else if (v && typeof v.type === "string") {
        checkImmediate(v);
      }
    }
  };
  for (const stmt of ast.body) {
    if (["FunctionDeclaration", "VariableDeclaration", "ClassDeclaration"].includes(stmt.type)) continue;
    checkImmediate(stmt);
  }
}

console.log(`frontend root: ${root}`);
console.log(`scripts in load order: ${order.length}`);
for (const rel of order) {
  const inv = inventory.get(rel);
  console.log(`  ${rel}: ${inv.decls} function declarations, ${inv.arrows} arrow functions`);
}

console.log("\nUNRESOLVED CALL SITES:");
if (!unresolved.length) console.log("  none");
else for (const u of unresolved) console.log(`  ${u.file}:${u.line}  ${u.name}(...) [${u.kind}]`);

console.log("\nLOAD-ORDER HAZARDS (top-level code calling a later-defined function):");
if (!loadOrderHazards.length) console.log("  none");
else for (const h of loadOrderHazards) console.log(`  ${h.file}:${h.line}  ${h.name}()`);

const pass = unresolved.length === 0 && loadOrderHazards.length === 0;
console.log(`\nRESULT: ${pass ? "PASS" : `FAIL (${unresolved.length} unresolved, ${loadOrderHazards.length} hazards)`}`);
process.exitCode = pass ? 0 : 1;
