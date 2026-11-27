import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import type { Mutant } from "./types.ts";

const SWAPS = new Map<string, string>([
  ["<", "<="],
  ["<=", "<"],
  [">", ">="],
  [">=", ">"],
  ["===", "!=="],
  ["!==", "==="],
  ["&&", "||"],
  ["||", "&&"],
  ["+", "-"],
  ["-", "+"],
  ["??", "&&"],
]);

const ERROR_CTORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
]);

const isConsoleCall = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "console";

const isErrorMessageArg = (node: ts.Node): boolean =>
  node.parent !== undefined &&
  ts.isNewExpression(node.parent) &&
  ts.isIdentifier(node.parent.expression) &&
  ERROR_CTORS.has(node.parent.expression.text) &&
  node.parent.arguments?.[0] === node;

export function isPropertyNameNode(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isBindingElement(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

const isInert = (node: ts.Node): boolean =>
  ts.isTypeNode(node) ||
  ts.isImportDeclaration(node) ||
  ts.isTemplateExpression(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  isConsoleCall(node) ||
  isErrorMessageArg(node);

export function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function edits(node: ts.Node, tree: ts.SourceFile): [number, number, string, string][] {
  const at = (one: ts.Node) => one.getStart(tree);
  const text = (one: ts.Node) => one.getText(tree);
  if (ts.isBinaryExpression(node)) {
    const op = text(node.operatorToken);
    const to = SWAPS.get(op);
    return to === undefined
      ? []
      : [[at(node.operatorToken), node.operatorToken.getEnd(), to, `${op} -> ${to}`]];
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return [[at(node), at(node.operand), "", "drop !"]];
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    const to = String(node.kind !== ts.SyntaxKind.TrueKeyword);
    return [[at(node), node.getEnd(), to, `${text(node)} -> ${to}`]];
  }
  if (ts.isNumericLiteral(node) && !isPropertyNameNode(node)) {
    const value = Number(node.text.replaceAll("_", ""));
    if (Number.isFinite(value)) {
      const to = String(value + 1);
      return [[at(node), node.getEnd(), `(${to})`, `${node.text} -> ${to}`]];
    }
  }
  if (ts.isIfStatement(node) && !ts.isLabeledStatement(node.parent)) {
    return [[at(node), node.getEnd(), ";", "delete if"]];
  }
  if (ts.isConditionalExpression(node)) {
    const swapped = `(${text(node.condition)}) ? (${text(node.whenFalse)}) : (${text(node.whenTrue)})`;
    return [[at(node), node.getEnd(), swapped, "swap ?:"]];
  }
  return [];
}

export function mutantsFromSource(file: string, source: string): Mutant[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const found: Mutant[] = [];
  const lines = source.split("\n");
  const visit = (node: ts.Node): void => {
    if (isInert(node)) return;
    for (const [start, end, text, label] of edits(node, tree)) {
      const line = tree.getLineAndCharacterOfPosition(start).line + 1;
      found.push({
        id: `${file}:${String(start)}:${label}`,
        file,
        line,
        label,
        start,
        end,
        text,
        source: lines[line - 1]?.trim() ?? "",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

export function mutantsOf(root: string, file: string): Mutant[] {
  return mutantsFromSource(file, readFileSync(join(root, file), "utf8"));
}

export function applyMutant(source: string, mutant: Pick<Mutant, "start" | "end" | "text">): string {
  return source.slice(0, mutant.start) + mutant.text + source.slice(mutant.end);
}
