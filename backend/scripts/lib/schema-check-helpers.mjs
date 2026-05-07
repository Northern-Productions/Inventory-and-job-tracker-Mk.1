export function normalizeFunctionDefinitionForSemanticCheck(definition) {
  return String(definition || '').replace(/\r\n?/g, '\n');
}
