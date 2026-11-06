import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"

/**
 * Finds every mutating server entry point in the web app and whether it calls
 * `requirePermission`: route handlers exporting POST, PUT, PATCH or DELETE from an
 * `app/**\/route.ts(x)` file, and server actions (every export of a "use server" file, and
 * every function whose body starts with "use server"). Read by `auth-handlers.test.ts`.
 */
export type Handler = {
  readonly file: string
  readonly name: string
  readonly kind: "route" | "action"
  readonly guarded: boolean
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])
const SOURCE_DIRS = ["app", "components", "hooks", "lib"]

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

function hasUseServer(statements: readonly ts.Statement[]): boolean {
  for (const statement of statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    )
      return false
    if (statement.expression.text === "use server") return true
  }
  return false
}

function callsRequirePermission(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "requirePermission"
    ) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  )
}

/** Exported functions in a module, by name. A re-export (`export { x as POST }`) has no body here. */
function exportedFunctions(
  source: ts.SourceFile
): { name: string; body: ts.Node | null }[] {
  const found: { name: string; body: ts.Node | null }[] = []
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      const isDefault = (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
      found.push({
        name: statement.name?.text ?? (isDefault ? "default" : "anonymous"),
        body: statement.body ?? null,
      })
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        found.push({
          name: declaration.name.text,
          body: declaration.initializer ?? null,
        })
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements)
        found.push({ name: element.name.text, body: null })
    } else if (ts.isExportAssignment(statement)) {
      found.push({ name: "default", body: statement.expression })
    }
  }
  return found
}

function functionName(node: FunctionNode): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name !== undefined &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  )
    return node.name.text
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  return "anonymous"
}

function guardedBody(body: ts.Node | null): boolean {
  return body !== null && callsRequirePermission(body)
}

/** The mutating handlers in one file. `file` is the path relative to apps/web, with "/". */
export function auditSource(file: string, text: string): Handler[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const handlers: Handler[] = []

  if (/^app\/(?:.+\/)?route\.tsx?$/.test(file)) {
    for (const entry of exportedFunctions(source))
      if (MUTATING.has(entry.name))
        handlers.push({
          file,
          name: entry.name,
          kind: "route",
          guarded: guardedBody(entry.body),
        })
  }

  if (hasUseServer(source.statements)) {
    for (const entry of exportedFunctions(source))
      handlers.push({
        file,
        name: entry.name,
        kind: "action",
        guarded: guardedBody(entry.body),
      })
  }

  const visit = (node: ts.Node): void => {
    if (
      isFunctionNode(node) &&
      node.body !== undefined &&
      ts.isBlock(node.body) &&
      hasUseServer(node.body.statements)
    )
      handlers.push({
        file,
        name: functionName(node),
        kind: "action",
        guarded: callsRequirePermission(node.body),
      })
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)

  return handlers
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      files.push(path)
  }
  return files
}

/** Every mutating handler under the web app's source directories. */
export function auditTree(root: string): Handler[] {
  return SOURCE_DIRS.flatMap((dir) => sourceFiles(join(root, dir))).flatMap(
    (path) =>
      auditSource(
        relative(root, path).split(sep).join("/"),
        readFileSync(path, "utf8")
      )
  )
}

/** Every route file under app/, relative to `root`, so a test can check the walk reached them. */
export function routeFiles(root: string): string[] {
  return sourceFiles(join(root, "app"))
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((file) => /^app\/(?:.+\/)?route\.tsx?$/.test(file))
}
