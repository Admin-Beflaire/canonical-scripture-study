import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const owners = [
  ["services/study/", "study"],
  ["services/maintenance/control/", "control"],
  ["services/maintenance/data-preparation/", "preparation"],
  ["packages/shared/", "shared"],
  ["schemas/", "schemas"],
];
const allowed = {
  study: new Set(["study", "shared", "schemas"]),
  control: new Set(["control", "shared", "schemas"]),
  preparation: new Set(["preparation", "shared", "schemas"]),
  shared: new Set(["shared", "schemas"]),
};
const owner = path => owners.find(([prefix]) => path.startsWith(prefix))?.[1];
const compilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext, resolveJsonModule: true };

export function checkSource(root, file, source) {
  const from = owner(file);
  if (!allowed[from]) return [];
  const failures = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function dependency(node) {
    if (!node || !ts.isStringLiteral(node)) {
      failures.push(`${file}: computed module dependency is not allowed`);
      return;
    }
    const name = node.text;
    if (name.startsWith("node:")) return;
    // Resolve bare names too: an alias must not bypass the repository boundary.
    const target = ts.resolveModuleName(name, resolve(root, file), compilerOptions, ts.sys).resolvedModule;
    const path = target && relative(root, target.resolvedFileName).replaceAll("\\", "/");
    if (path?.split("/").includes("node_modules")) return;
    if (!path || !allowed[from].has(owner(path))) failures.push(`${file}: forbidden or unresolved dependency ${name}`);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) dependency(node.moduleSpecifier);
    if (ts.isImportTypeNode(node)) dependency(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node)) failures.push(`${file}: import-equals is not allowed`);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") failures.push(`${file}: require is not allowed`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (ast.referencedFiles.length || ast.typeReferenceDirectives.length) failures.push(`${file}: triple-slash dependencies are not allowed`);
  return failures;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = ["services", "packages"].flatMap(directory =>
    files(resolve(root, directory)).flatMap(path => checkSource(root, relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8"))));
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Application dependency boundaries passed.");
}
