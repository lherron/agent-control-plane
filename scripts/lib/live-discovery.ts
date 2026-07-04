import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type RouteSummary = {
  key: string
  method: string
  path: string
  family: string
  source: string
  handler: string | null
  handlerSource: string | null
}

export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const routeSourceRels = [
  'packages/acp-server/src/routing/exact-routes.ts',
  'packages/acp-server/src/routing/param-routes.ts',
  'packages/gateway-ios/src/routes.ts',
] as const

export function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

export function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    )
  }
  return value
}

export function rel(path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

export async function readText(root: string, path: string): Promise<string> {
  return await Bun.file(join(root, path)).text()
}

async function exists(path: string): Promise<boolean> {
  return await Bun.file(path).exists()
}

async function resolveLocalModule(
  root: string,
  fromRel: string,
  specifier: string
): Promise<string | undefined> {
  if (!specifier.startsWith('.')) return undefined
  const fromAbs = join(root, fromRel)
  const raw = resolve(dirname(fromAbs), specifier)
  const candidates = raw.endsWith('.js')
    ? [raw.replace(/\.js$/, '.ts'), raw.replace(/\.js$/, '.tsx')]
    : [`${raw}.ts`, `${raw}.tsx`, join(raw, 'index.ts'), join(raw, 'index.tsx')]

  for (const candidate of candidates) {
    if (await exists(candidate)) return relative(root, candidate).split(sep).join('/')
  }
  return undefined
}

function stringArg(call: ts.CallExpression, index: number): string | undefined {
  const arg = call.arguments[index]
  return arg !== undefined && ts.isStringLiteral(arg) ? arg.text : undefined
}

function propertyString(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
  )
  return property !== undefined && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined
}

function propertyExpression(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
  )
  return property?.initializer
}

function expressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.getText()
  if (ts.isCallExpression(expression)) {
    const lastArg = expression.arguments[expression.arguments.length - 1]
    return lastArg !== undefined && ts.isExpression(lastArg) ? expressionName(lastArg) : undefined
  }

  const text = expression.getText()
  const directHandler = text.match(/\b(handle[A-Z][A-Za-z0-9_]*)\b/)
  if (directHandler?.[1] !== undefined) return directHandler[1]
  const memberHandler = text.match(/\b([A-Za-z][A-Za-z0-9_]*\.handle[A-Z][A-Za-z0-9_]*)\b/)
  return memberHandler?.[1]
}

function routeFamily(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'v1') return segments[1] ?? 'root'
  return segments[0] ?? 'root'
}

async function importSources(
  root: string,
  sourceRel: string,
  sourceFile: ts.SourceFile
): Promise<Map<string, string>> {
  const imports = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue

    const resolved = await resolveLocalModule(root, sourceRel, statement.moduleSpecifier.text)
    if (resolved === undefined) continue

    const namedBindings = statement.importClause?.namedBindings
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) continue
    for (const element of namedBindings.elements) {
      imports.set(element.name.text, resolved)
    }
  }
  return imports
}

function handlerSource(handler: string | undefined, imports: Map<string, string>): string | null {
  if (handler === undefined) return null
  const rootName = handler.split('.')[0]
  if (rootName === undefined) return null
  return imports.get(rootName) ?? null
}

function routeSummary(
  method: string,
  path: string,
  source: string,
  handler: string | undefined,
  imports: Map<string, string>
): RouteSummary {
  return {
    key: `${method} ${path}`,
    method,
    path,
    family: routeFamily(path),
    source,
    handler: handler ?? null,
    handlerSource: handlerSource(handler, imports),
  }
}

function collectExactRoutes(
  sourceRel: string,
  sourceFile: ts.SourceFile,
  imports: Map<string, string>
): RouteSummary[] {
  const routes: RouteSummary[] = []

  function visit(node: ts.Node): void {
    if (
      !ts.isPropertyAssignment(node) ||
      !ts.isComputedPropertyName(node.name) ||
      !ts.isCallExpression(node.name.expression)
    ) {
      ts.forEachChild(node, visit)
      return
    }

    const keyCall = node.name.expression
    if (!ts.isIdentifier(keyCall.expression) || keyCall.expression.text !== 'exactRouteKey') {
      ts.forEachChild(node, visit)
      return
    }

    const method = stringArg(keyCall, 0)
    const path = stringArg(keyCall, 1)
    if (method !== undefined && path !== undefined) {
      routes.push(routeSummary(method, path, sourceRel, expressionName(node.initializer), imports))
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return routes
}

function collectParamRoutes(
  sourceRel: string,
  sourceFile: ts.SourceFile,
  imports: Map<string, string>
): RouteSummary[] {
  const routes: RouteSummary[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createParamRoute'
    ) {
      const method = stringArg(node, 0)
      const path = stringArg(node, 1)
      const handlerExpression = node.arguments[2]
      if (method !== undefined && path !== undefined && handlerExpression !== undefined) {
        routes.push(
          routeSummary(
            method,
            path,
            sourceRel,
            ts.isExpression(handlerExpression) ? expressionName(handlerExpression) : undefined,
            imports
          )
        )
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return routes
}

function collectGatewayRoutes(
  sourceRel: string,
  sourceFile: ts.SourceFile,
  imports: Map<string, string>
): RouteSummary[] {
  const routes: RouteSummary[] = []

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push'
    ) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue
        const method = propertyString(arg, 'method')
        const path = propertyString(arg, 'path')
        if (method === undefined || path === undefined) continue
        routes.push(
          routeSummary(
            method,
            path,
            sourceRel,
            expressionName(propertyExpression(arg, 'handle') ?? arg),
            imports
          )
        )
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return routes
}

export async function collectRouteSummaries(root = repoRoot): Promise<RouteSummary[]> {
  const routes: RouteSummary[] = []
  for (const sourceRel of routeSourceRels) {
    const sourcePath = join(root, sourceRel)
    if (!(await exists(sourcePath))) continue

    const source = await readText(root, sourceRel)
    const sourceFile = ts.createSourceFile(sourceRel, source, ts.ScriptTarget.Latest, true)
    const imports = await importSources(root, sourceRel, sourceFile)
    routes.push(...collectExactRoutes(sourceRel, sourceFile, imports))
    routes.push(...collectParamRoutes(sourceRel, sourceFile, imports))
    routes.push(...collectGatewayRoutes(sourceRel, sourceFile, imports))
  }

  const unique = new Map<string, RouteSummary>()
  for (const route of routes) unique.set(`${route.key} ${route.source}`, route)
  return [...unique.values()].sort(
    (a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source)
  )
}
